import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app';
import type { Config } from '../src/server/config';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import { MockProvider } from '../src/server/providers/mock';
import { QUIET } from './helpers';
import type { AccessView } from '../src/shared/access';

let dir: string, registry: Registry, server: Server, unsafe: Server, base: string, unsafeBase: string, config: Config;
const mail = { check: vi.fn(async () => {}), list: vi.fn(async () => [{ id: '1:2', from: 'supplier@example.com', subject: 'Account verification', date: '' }]), read: vi.fn(async () => ({ id: '1:2', from: 'supplier@example.com', subject: 'Account verification', text: 'Code 123456', date: '', truncated: false })), send: vi.fn(async () => {}) };
const phrase = 'business vault passphrase';
async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(base + path, { method, headers: { ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
async function establish() {
  return registry.create({ name: 'Only Paperclips', idea: 'Sell paperclips as a small sustainable business.', executives: [{ profileId: 'operations', agentCount: 1 }], settings: { maxCycles: 1, maxTasksPerPhase: 1, budgetUsd: 1000 } });
}
beforeAll(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'access-api-'));
  const store = new Store(dir); await store.init();
  registry = new Registry(store, new MockProvider(QUIET), { retryDelayMs: 1, emitIntervalMs: 1, access: { mail } });
  config = { port: 0, host: '127.0.0.1', dataDir: dir, provider: 'mock', providerReason: 'test', production: false, workspace: 'default', anthropicAmbient: false, claudeCode: { command: 'claude', extraUsage: false, blocked: null } };
  server = createApp(registry, config).listen(0, '127.0.0.1');
  unsafe = createApp(registry, { ...config, host: '0.0.0.0' }).listen(0, '127.0.0.1');
  await Promise.all([server, unsafe].map(server => new Promise<void>(resolve => server.once('listening', resolve))));
  base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  unsafeBase = 'http://127.0.0.1:' + (unsafe.address() as AddressInfo).port;
});
afterAll(async () => {
  await registry.shutdown();
  for (const instance of [server, unsafe]) { instance.closeAllConnections(); await new Promise<void>(resolve => instance.close(() => resolve())); }
  await rm(dir, { recursive: true, force: true });
});
describe('business access API', () => {
  it('creates, unlocks and locks a vault without putting secrets in organisation state or views', async () => {
    const runner = await establish(), root = '/api/orgs/' + runner.org.id + '/access';
    expect((await api('GET', root)).data.unlocked).toBe(false);
    expect((await api('POST', root + '/create', { passphrase: phrase })).status).toBe(201);
    const added = await api('POST', root + '/accounts', { label: 'Supplier', loginUrl: 'https://supplier.example/login', username: 'paperclips', password: 'private-site-password', ownerIds: ['coo'] });
    expect(added.status).toBe(201);
    const saved = (added.data as AccessView).accounts[0]!;
    expect(JSON.stringify(added.data)).not.toContain('private-site-password');
    expect((await api('POST', root + '/accounts/' + saved.id + '/reveal', {})).data.password).toBe('private-site-password');
    expect((await api('GET', root + '/accounts/' + saved.id + '/reveal')).status).toBe(404);
    const state = await readFile(path.join(dir, 'orgs', runner.org.id, 'org.json'), 'utf8');
    expect(state).not.toContain('private-site-password');
    expect(state).not.toContain('access-vault');
    expect(JSON.stringify((await api('GET', '/api/orgs/' + runner.org.id)).data)).not.toContain('private-site-password');
    expect((await api('GET', root)).headers.get('cache-control')).toBe('no-store');
    expect((await api('POST', root + '/lock', {})).data.accounts).toEqual([]);
    expect((await api('POST', root + '/accounts/' + saved.id + '/reveal', {})).status).toBe(423);
    expect((await api('POST', root + '/unlock', { passphrase: phrase })).data.accounts[0].id).toBe(saved.id);
    const other = await establish();
    await other.access.unlock(phrase, true);
    expect((await api('POST', '/api/orgs/' + other.org.id + '/access/accounts/' + saved.id + '/reveal', {})).status).toBe(404);
  });
  it('cannot be framed by another page, in the interface or the API', async () => {
    // The interface is served from behind the same app, as main.ts does.
    const app = createApp(registry, config);
    app.get('/', (_req, res) => { res.send('<!doctype html><title>The dashboard</title>'); });
    const page = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => page.once('listening', resolve));
    try {
      for (const url of ['http://127.0.0.1:' + (page.address() as AddressInfo).port + '/', base + '/api/meta']) {
        const response = await fetch(url);
        expect(response.status).toBe(200);
        expect(response.headers.get('x-frame-options')).toBe('DENY');
        expect(response.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
      }
    } finally {
      page.closeAllConnections();
      await new Promise<void>(resolve => page.close(() => resolve()));
    }
  });
  it('rejects cross-site controls and disables access on a publicly bound server', async () => {
    const runner = await establish(), root = '/api/orgs/' + runner.org.id + '/access';
    expect((await api('POST', root + '/create', { passphrase: phrase }, { Origin: 'https://foreign.example' })).status).toBe(403);
    expect((await api('GET', root, undefined, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await fetch(unsafeBase + root).then(res => res.json())).available).toBe(false);
    expect((await fetch(unsafeBase + root + '/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passphrase: phrase }) })).status).toBe(403);
    expect((await api('POST', root + '/google/start', { label: 'Gmail', ownerIds: [] }, { Origin: 'https://foreign.example' })).status).toBe(403);
  });
  it('gives a running local task real access tools with its own lead identity', async () => {
    const runner = await establish();
    await runner.access.unlock(phrase, true);
    const box = await runner.access.addMailbox({ label: 'Inbox', address: 'office@paperclips.example', username: 'office@paperclips.example', password: 'mail-test-secret', imapHost: 'imap.paperclips.example', smtpHost: 'smtp.paperclips.example', ownerIds: ['coo'] });
    const provider = registry.provider as MockProvider;
    const original = provider.agent.bind(provider);
    let checked = false;
    const spy = vi.spyOn(provider, 'agent').mockImplementation(async request => {
      const tool = request.tools.find(tool => tool.name === 'read_business_email');
      expect(tool).toBeDefined();
      const result = JSON.parse(await tool!.run({ mailboxId: box.id }));
      expect(result.untrustedContent[0].subject).toBe('Account verification');
      expect(request.prompt).not.toContain('mail-test-secret');
      checked = true;
      return original(request);
    });
    try { runner.start(); await runner.idle(); expect(checked).toBe(true); }
    finally { spy.mockRestore(); }
  });
});
