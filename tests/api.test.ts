import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { MockProvider } from '../src/server/providers/mock';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import type { OrgView, TeamRecommendation } from '../src/shared/types';
import { QUIET, waitFor } from './helpers';

let server: http.Server;
let registry: Registry;
let base: string;
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-api-'));
  const store = new Store(dir);
  await store.init();
  registry = new Registry(store, new MockProvider(QUIET), { retryDelayMs: 1, emitIntervalMs: 1 });
  const config: Config = { port: 0, host: '127.0.0.1', dataDir: dir, provider: 'mock', providerReason: 'test', production: false, workspace: 'default', anthropicAmbient: false };
  server = createApp(registry, config).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await registry.shutdown();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

async function api<T = any>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : (undefined as T) };
}

const IDEA = 'An online shop that sells refurbished bicycles to commuters, with a repair subscription.';

async function establish(extra: Record<string, unknown> = {}): Promise<OrgView> {
  const { status, data } = await api<OrgView>('POST', '/api/orgs', {
    name: 'Second Cycle',
    idea: IDEA,
    executives: [{ profileId: 'engineering', agentCount: 2 }, { profileId: 'operations' }],
    settings: { maxCycles: 1, budgetUsd: 1000 },
    ...extra,
  });
  expect(status).toBe(201);
  return data;
}

describe('the API', () => {
  it('describes the provider and the profile library', async () => {
    const { status, data } = await api('GET', '/api/meta');
    expect(status).toBe(200);
    expect(data.provider).toMatchObject({ id: 'mock', simulated: true, defaultModel: 'claude-opus-5-5' });
    const cto = data.profiles.find((p: any) => p.id === 'engineering');
    expect(cto.phases.map((p: any) => p.name)).toEqual(['Spec', 'Build', 'Test', 'Release']);
    expect(data.defaults.budgetUsd).toBeGreaterThan(0);
  });

  it('recommends an executive team for an idea', async () => {
    expect((await api('POST', '/api/recommend', { idea: 'short' })).status).toBe(400);
    const { status, data } = await api<TeamRecommendation>('POST', '/api/recommend', { idea: IDEA });
    expect(status).toBe(200);
    expect(data.executives.length).toBeGreaterThanOrEqual(3);
    expect(data.executives.map((e) => e.profileId)).toContain('operations');
  });

  it('establishes an organisation, runs it and serves what it produced', async () => {
    const created = await establish({ steer: 'Start in Manchester.' });
    const id = created.org.id;
    expect(created.org.status).toBe('idle');
    expect(created.org.executives.map((e) => e.id)).toEqual(['ceo', 'cto', 'coo', 'signatory']);
    expect((await api('GET', '/api/orgs')).data.some((o: any) => o.id === id)).toBe(true);

    const started = await api<OrgView>('POST', `/api/orgs/${id}/start`);
    expect(started.data.org.status).toBe('running');
    const runner = registry.get(id)!;
    await runner.idle();

    const { data: view } = await api<OrgView>('GET', `/api/orgs/${id}`);
    expect(view.org.status).toBe('paused');
    expect(view.org.pauseReason).toBe('cycle_limit');
    expect(view.active).toEqual([]);
    expect(view.org.plans.every((p) => p.status === 'done')).toBe(true);
    expect(view.org.steers[0]!.status).toBe('acknowledged');

    const files = (await api('GET', `/api/orgs/${id}/files`)).data as Array<{ path: string }>;
    expect(files.length).toBeGreaterThan(0);
    const file = await api('GET', `/api/orgs/${id}/file?path=${encodeURIComponent(files[0]!.path)}`);
    expect(file.data.content).toContain('Simulated work product');
    expect((await api('GET', `/api/orgs/${id}/file?path=${encodeURIComponent('../org.json')}`)).status).toBe(400);
    expect((await api('GET', `/api/orgs/${id}/file?path=nope.md`)).status).toBe(400);

    const task = view.org.plans[0]!.phases[0]!.tasks[0]!;
    const detail = await api('GET', `/api/orgs/${id}/tasks/${task.id}`);
    expect(detail.data.task.result).toContain('Produced');
    expect((await api('GET', `/api/orgs/${id}/tasks/t999999`)).status).toBe(404);

    const activity = (await api('GET', `/api/orgs/${id}/activity`)).data as Array<{ kind: string; ok: boolean }>;
    expect(activity.some((a) => a.kind === 'direct' && a.ok)).toBe(true);
  });

  it('runs an organisation on hosted sessions, and reads a run agent\'s task from the session when asked', async () => {
    const meta = await api('GET', '/api/meta');
    expect(meta.data.provider.managed).toBe(true);
    expect(meta.data.defaults).toMatchObject({ execution: 'local', workflowRuns: true, archiveSessions: false });

    const { org } = await establish({
      executives: [{ profileId: 'engineering', agentCount: 2 }],
      settings: { maxCycles: 1, budgetUsd: 1000, execution: 'managed' },
    });
    expect(org.settings.execution).toBe('managed');
    // Anything but the two ways of working is ignored.
    expect((await api('PATCH', `/api/orgs/${org.id}/settings`, { execution: 'elsewhere' })).data.org.settings.execution).toBe('managed');

    await api('POST', `/api/orgs/${org.id}/start`);
    const runner = registry.get(org.id)!;
    await waitFor(() => runner.org.status === 'paused' && !runner.busy, 'the cycle to finish');
    const view = (await api<OrgView>('GET', `/api/orgs/${org.id}`)).data;
    const plan = view.org.plans[0]!;
    expect(plan).toMatchObject({ status: 'done', execution: 'managed' });
    expect(plan.managed).toMatchObject({ state: 'finished', synced: {} });
    expect(plan.managed!.runs).toHaveLength(1);

    // The session can be archived by hand now that the plan is over, once.
    const archived = await api('POST', `/api/orgs/${org.id}/plans/${plan.id}/archive-session`);
    expect(archived.status).toBe(200);
    expect(archived.data).toMatchObject({ archived: 1, left: 0 });
    expect(archived.data.view.org.plans[0].managed.archivedAt).toBeTruthy();
    expect((await api('POST', `/api/orgs/${org.id}/archive-sessions`)).data).toMatchObject({ archived: 0, left: 0 });
    expect((await api('POST', `/api/orgs/${org.id}/plans/p999/archive-session`)).status).toBe(404);

    // An agent in a workflow run got its work from the run, so the plan holds neither its brief nor what it returned.
    const inRun = plan.phases[2]!.tasks.find((t) => t.agent === null)!;
    expect(inRun.result).toBeNull();
    const detail = (await api('GET', `/api/orgs/${org.id}/tasks/${inRun.id}`)).data;
    expect(detail.task.brief).toMatch(/^Check piece 1 of 4/);
    expect(detail.task.result).toMatch(/^Piece 1 is consistent/);
    // Read once, then kept.
    expect((await api<OrgView>('GET', `/api/orgs/${org.id}`)).data.org.plans[0]!.phases[2]!.tasks.find((t) => t.id === inRun.id)!.result).toMatch(/^Piece 1/);
  });

  it('pushes live updates to an open dashboard', async () => {
    const { org } = await establish();
    const controller = new AbortController();
    const res = await fetch(`${base}/api/orgs/${org.id}/events`, { signal: controller.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const statuses: string[] = [];
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const chunk = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = chunk.split('\n').find((l) => l.startsWith('data: '));
          if (chunk.startsWith('event: view') && data) statuses.push((JSON.parse(data.slice(6)) as OrgView).org.status);
        }
      }
    })().catch(() => {});
    await waitFor(() => statuses.length > 0, 'the first event');
    expect(statuses[0]).toBe('idle');
    await api('POST', `/api/orgs/${org.id}/start`);
    await waitFor(() => statuses.includes('running') && statuses.at(-1) === 'paused', 'the run to be streamed');
    controller.abort();
    await pump;
  });

  it('takes steer, settings and agent allocation while the organisation exists', async () => {
    const { org } = await establish();
    const url = `/api/orgs/${org.id}`;

    expect((await api('POST', `${url}/steer`, { text: '  ' })).status).toBe(400);
    const steered = await api<OrgView>('POST', `${url}/steer`, { text: 'Stay profitable.' });
    expect(steered.data.org.steers.map((s) => s.text)).toEqual(['Stay profitable.']);

    // An organisation is not established on a model named in a form no model has; nor is the name quietly dropped.
    const unnamed = await api('POST', '/api/orgs', { name: 'Nameless', idea: IDEA, executives: [{ profileId: 'engineering' }], settings: { workerModel: '' } });
    expect(unnamed.status).toBe(400);
    expect(unnamed.data.error).toMatch(/model named for the agents is not a model’s name/);
    // A change that names a model in a form no model has is refused whole, not half applied.
    const malformed = await api('PATCH', `${url}/settings`, { budgetUsd: 99, executiveModel: '' });
    expect(malformed.status).toBe(400);
    expect(malformed.data.error).toMatch(/model named for the executives is not a model’s name/);
    const settings = await api<OrgView>('PATCH', `${url}/settings`, { budgetUsd: 12.5, arbiter: 'judge', workerModel: 'claude-haiku-5-5' });
    expect(settings.data.org.settings).toMatchObject({ budgetUsd: 12.5, arbiter: 'judge', workerModel: 'claude-haiku-5-5', executiveModel: 'claude-opus-5-5' });
    expect(settings.data.org.executives.some((e) => e.kind === 'judge')).toBe(true);
    const back = await api<OrgView>('PATCH', `${url}/settings`, { arbiter: 'ceo' });
    expect(back.data.org.executives.some((e) => e.kind === 'judge')).toBe(false);

    const agents = await api<OrgView>('PATCH', `${url}/executives/cto`, { agentCount: 5 });
    expect(agents.data.org.executives.find((e) => e.id === 'cto')?.agentCount).toBe(5);
    expect((await api('PATCH', `${url}/executives/ceo`, { agentCount: 5 })).status).toBe(400);
    expect((await api('PATCH', `${url}/executives/cto`, { agentCount: 'lots' })).status).toBe(400);
  });

  it('pauses and stops on request', async () => {
    const { org } = await establish({ settings: { maxCycles: null, budgetUsd: 1000 } });
    const url = `/api/orgs/${org.id}`;
    await api('POST', `${url}/start`);
    const paused = await api<OrgView>('POST', `${url}/pause`);
    expect(paused.data.org).toMatchObject({ status: 'paused', pauseReason: 'user' });
    await api('POST', `${url}/start`);
    const stopped = await api<OrgView>('POST', `${url}/stop`);
    expect(stopped.data.org.status).toBe('paused');
    await registry.get(org.id)!.idle();
  });

  it('refuses organisations that cannot work, with a reason a person can act on', async () => {
    const none = await api('POST', '/api/orgs', { name: 'Empty', idea: IDEA, executives: [] });
    expect(none.status).toBe(400);
    expect(none.data.error).toMatch(/at least one/);
    expect((await api('POST', '/api/orgs', { idea: IDEA, executives: [{ profileId: 'product' }] })).status).toBe(400);
    const res = await fetch(`${base}/api/orgs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(res.status).toBe(400);
  });

  it('closes an open dashboard stream when its organisation is deleted', async () => {
    const { org } = await establish();
    const res = await fetch(`${base}/api/orgs/${org.id}/events`);
    const reader = res.body!.getReader();
    await reader.read(); // the initial view
    expect((await api('DELETE', `/api/orgs/${org.id}`)).status).toBe(204);
    let ended = false;
    for (let i = 0; i < 50 && !ended; i++) ended = (await reader.read()).done;
    expect(ended).toBe(true);
  });

  it('deletes an organisation and its files', async () => {
    const { org } = await establish();
    expect((await api('DELETE', `/api/orgs/${org.id}`)).status).toBe(204);
    expect((await api('GET', `/api/orgs/${org.id}`)).status).toBe(404);
    expect((await api('DELETE', `/api/orgs/${org.id}`)).status).toBe(404);
    expect((await api('POST', '/api/orgs/org_missing/start')).status).toBe(404);
    expect((await api('GET', '/api/nothing-here')).status).toBe(404);
  });
});

describe('who may call the API', () => {
  it('turns away a web page on another site trying to drive it', async () => {
    const { org } = await establish();
    const foreign = await api('POST', `/api/orgs/${org.id}/start`, undefined, { origin: 'https://evil.example' });
    expect(foreign.status).toBe(403);
    expect(registry.get(org.id)!.org.status).toBe('idle');
    const same = await api('POST', `/api/orgs/${org.id}/pause`, undefined, { origin: base });
    expect(same.status).toBe(200);
  });

  it('applies the localhost rule when bound to the IPv6 loopback address too', async () => {
    const config: Config = { port: 0, host: '::1', dataDir: dir, provider: 'mock', providerReason: 'test', production: false, workspace: 'default', anthropicAmbient: false };
    const other = createApp(registry, config).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => other.once('listening', resolve));
    const { port } = other.address() as AddressInfo;
    const status = await new Promise<number>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/api/orgs', headers: { host: 'evil.example' } }, (res) => (res.resume(), resolve(res.statusCode ?? 0))).on('error', reject);
    });
    expect(status).toBe(403);
    await new Promise<void>((resolve) => other.close(() => resolve()));
  });

  it('refuses to start an organisation that is being deleted', async () => {
    const { org } = await establish();
    const runner = registry.get(org.id)!;
    await registry.remove(org.id);
    expect(() => runner.start()).toThrow(/deleted/);
    expect(runner.org.status).not.toBe('running');
  });

  it('answers only requests addressed to localhost', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const { port } = server.address() as AddressInfo;
      http
        .get({ host: '127.0.0.1', port, path: '/api/orgs', headers: { host: 'evil.example' } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject);
    });
    expect(status).toBe(403);
  });
});
