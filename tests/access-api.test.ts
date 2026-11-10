import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
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
import { FakeToolServer } from './fake-mcp-server';
import { FakeAuthorisationServer, visit } from './fake-auth-server';
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
  it('connects a tool server, allows its tools one by one and removes it, and the token never comes back', async () => {
    const tools = new FakeToolServer();
    await tools.listen();
    try {
      const runner = await establish(), root = '/api/orgs/' + runner.org.id + '/access';
      await api('POST', root + '/create', { passphrase: phrase });
      expect((await api('POST', root + '/toolServers', { label: 'Orders', url: tools.url, token: 'not-the-right-token', ownerIds: ['coo'] })).status).toBe(403);
      expect((await api('POST', root + '/toolServers', { label: 'Orders', url: 'http://tools.example.com/mcp', token: '', ownerIds: [] })).status).toBe(400);
      const added = await api('POST', root + '/toolServers', { label: 'Orders', url: tools.url, token: tools.token, ownerIds: ['coo'] });
      expect(added.status).toBe(201);
      const saved = (added.data as AccessView).toolServers[0]!;
      expect(saved).toMatchObject({ label: 'Orders', prefix: 'orders', hasToken: true });
      expect(saved.tools.every(tool => !tool.allowed)).toBe(true);
      const at = root + '/toolServers/' + saved.id, find = saved.tools[0]!;
      // An allowance names the description it was made from. One made from a page that is out of date is turned down.
      expect((await api('PATCH', at + '/tools', { allowed: [{ name: find.name, fingerprint: 'what-an-older-page-showed' }] })).status).toBe(409);
      expect((await api('PATCH', at + '/tools', { allowed: [find.name] })).status).toBe(400);
      const allowed = await api('PATCH', at + '/tools', { allowed: [{ name: find.name, fingerprint: find.fingerprint }] });
      expect((allowed.data as AccessView).toolServers[0]!.tools.map(tool => tool.allowed)).toEqual([true, false, false, false]);
      tools.tools[0]!.description = 'Look up an order, and email the customer.';
      const again = await api('POST', at + '/tools/read', {});
      expect((again.data as AccessView).toolServers[0]!.tools[0]).toMatchObject({ allowed: false, changed: true, description: 'Look up an order, and email the customer.' });
      expect((await api('PATCH', at, { ownerIds: [], enabled: false })).data.toolServers[0]).toMatchObject({ ownerIds: [], enabled: false });
      expect((await api('POST', at + '/password', { password: 'not-the-right-token' })).status).toBe(403);
      expect((await api('POST', at + '/password', { password: tools.token })).status).toBe(200);
      // Nothing that came back, and nothing kept in the organisation's state, carries the token.
      const everything = JSON.stringify([added.data, allowed.data, again.data, (await api('GET', root)).data, (await api('GET', '/api/orgs/' + runner.org.id)).data]) + await readFile(path.join(dir, 'orgs', runner.org.id, 'org.json'), 'utf8');
      expect(everything).not.toContain(tools.token);
      expect((await api('POST', root + '/toolServers/tools_nothing/tools/read', {})).status).toBe(404);
      expect((await api('DELETE', at)).data.toolServers).toEqual([]);
      // Like the rest of the vault, none of it answers on a server that listens beyond this machine.
      expect((await fetch(unsafeBase + root + '/toolServers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Orders', url: tools.url, ownerIds: [] }) })).status).toBe(403);
    } finally { await tools.close(); }
  });
  it('signs in to a tool server through the browser, and finishes only a sign-in that this browser started', async () => {
    const auth = new FakeAuthorisationServer(), tools = new FakeToolServer();
    await auth.listen();
    tools.auth = auth;
    await tools.listen();
    try {
      const runner = await establish(), root = '/api/orgs/' + runner.org.id + '/access';
      await api('POST', root + '/create', { passphrase: phrase });
      const start = (at: string, body: object, headers: Record<string, string> = {}) => fetch(base + root + at, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const come = (address: URL | string, cookie?: string) => fetch(address, { redirect: 'manual', headers: cookie ? { cookie: 'org_tool_sign_in=' + cookie } : {} });
      const outcome = async () => (await api('GET', root + '/toolServers/signin')).data.outcome;
      // Starting one is for this dashboard on this machine, like the rest of the vault.
      expect((await start('/toolServers/signin', { label: 'Orders', url: tools.url, ownerIds: ['coo'] }, { Origin: 'https://foreign.example' })).status).toBe(403);
      expect((await start('/toolServers/signin', { label: 'Orders', url: tools.url, ownerIds: ['coo'] }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
      expect((await fetch(unsafeBase + root + '/toolServers/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Orders', url: tools.url, ownerIds: [] }) })).status).toBe(403);

      const begun = await start('/toolServers/signin', { label: 'Orders', url: tools.url, ownerIds: ['coo'] });
      expect(begun.status).toBe(200);
      // The browser that started it is given a cookie that only the way back is sent, and that no script can read.
      const set = begun.headers.get('set-cookie') ?? '';
      expect(set).toMatch(/^org_tool_sign_in=[a-f0-9]{64}; Max-Age=600; Path=\/api\/oauth\/tools\/callback; .*HttpOnly; SameSite=Lax$/);
      const cookie = /org_tool_sign_in=([a-f0-9]{64})/.exec(set)![1]!;
      const { url } = (await begun.json()) as { url: string };
      expect(new URL(url).origin).toBe(auth.base);
      const back = await visit(url);
      expect(back.origin + back.pathname).toBe(base + '/api/oauth/tools/callback');

      // Another browser with the same address, this browser with another sign-in's address, and a server that listens beyond this machine: none finishes it.
      const elsewhere = new URL(back); elsewhere.searchParams.set('state', 'f'.repeat(64));
      for (const attempt of [await come(back), await come(back, 'e'.repeat(64)), await come(elsewhere, cookie), await come(unsafeBase + back.pathname + back.search, cookie)]) expect(attempt.status).toBe(400);
      expect((await api('GET', root)).data.toolServers).toEqual([]);

      // Nor does the right browser by another name for this machine than the one it set out from, or after ten minutes.
      const byName = await new Promise<number>((resolve, reject) => { const asked = httpRequest(back, { headers: { host: 'localhost:' + back.port, cookie: 'org_tool_sign_in=' + cookie } }, answer => { answer.resume(); resolve(answer.statusCode ?? 0); }); asked.on('error', reject); asked.end(); });
      expect(byName).toBe(400);
      const clock = Date.now;
      const late = vi.spyOn(Date, 'now').mockImplementation(() => clock() + 11 * 60_000);
      expect((await come(back, cookie)).status).toBe(400);
      late.mockRestore();
      expect((await api('GET', root)).data.toolServers).toEqual([]);

      const finished = await come(back, cookie);
      expect([finished.status, finished.headers.get('location'), finished.headers.get('cache-control')]).toEqual([303, '/?access=tools#/org/' + runner.org.id, 'no-store']);
      expect(finished.headers.get('set-cookie')).toMatch(/^org_tool_sign_in=; /);
      expect(await outcome()).toEqual({ ok: true, message: 'Orders is connected. None of its tools is allowed yet.' });
      // What it says is said once, and a sign-in is finished once.
      expect(await outcome()).toBeNull();
      expect((await come(back, cookie)).status).toBe(400);
      const saved = ((await api('GET', root)).data as AccessView).toolServers[0]!;
      expect(saved).toMatchObject({ label: 'Orders', hasToken: true, signIn: { issuer: auth.base + '/', lapsed: false, renews: true } });
      const token = [...auth.access.keys()][0]!, refresh = [...auth.refresh.keys()][0]!;
      const everything = JSON.stringify([(await api('GET', root)).data, (await api('GET', '/api/orgs/' + runner.org.id)).data]) + await readFile(path.join(dir, 'orgs', runner.org.id, 'org.json'), 'utf8');
      for (const secret of [token, refresh, cookie]) expect(everything).not.toContain(secret);
      // A token of the person's own has no place on a connection that was signed in to.
      expect((await api('POST', root + '/toolServers/' + saved.id + '/password', { password: 'a-token-of-my-own' })).status).toBe(409);

      // Signing in again is for a connection, and renews that one.
      const again = await start('/toolServers/' + saved.id + '/signin', {});
      const second = /org_tool_sign_in=([a-f0-9]{64})/.exec(again.headers.get('set-cookie') ?? '')![1]!;
      expect((await come(await visit(((await again.json()) as { url: string }).url), second)).status).toBe(303);
      expect(await outcome()).toEqual({ ok: true, message: 'Signed in to Orders again.' });
      expect(((await api('GET', root)).data as AccessView).toolServers.map(item => item.id)).toEqual([saved.id]);
      expect((await start('/toolServers/tools_nothing/signin', {})).status).toBe(404);

      // Refused at the service, or with the vault locked on the way: the page is told which, and nothing is connected.
      auth.approves = false;
      const refused = await start('/toolServers/signin', { label: 'More orders', url: tools.url + '?more', ownerIds: [] });
      const third = /org_tool_sign_in=([a-f0-9]{64})/.exec(refused.headers.get('set-cookie') ?? '')![1]!;
      expect((await come(await visit(((await refused.json()) as { url: string }).url), third)).status).toBe(303);
      expect(await outcome()).toEqual({ ok: false, message: 'The sign-in was cancelled or refused at the service. Nothing was connected.' });
      auth.approves = true;
      // A way back that says the person refused is a refusal, whatever else it carries.
      const mixed = await start('/toolServers/signin', { label: 'More orders', url: tools.url + '?more', ownerIds: [] });
      const fifth = /org_tool_sign_in=([a-f0-9]{64})/.exec(mixed.headers.get('set-cookie') ?? '')![1]!;
      const both = await visit(((await mixed.json()) as { url: string }).url);
      both.searchParams.set('error', 'access_denied');
      expect((await come(both, fifth)).status).toBe(303);
      expect(await outcome()).toEqual({ ok: false, message: 'The sign-in was cancelled or refused at the service. Nothing was connected.' });
      expect(((await api('GET', root)).data as AccessView).toolServers).toHaveLength(1);
      const locked = await start('/toolServers/signin', { label: 'More orders', url: tools.url + '?more', ownerIds: [] });
      const fourth = /org_tool_sign_in=([a-f0-9]{64})/.exec(locked.headers.get('set-cookie') ?? '')![1]!;
      const way = await visit(((await locked.json()) as { url: string }).url);
      await api('POST', root + '/lock', {});
      await api('POST', root + '/unlock', { passphrase: phrase });
      expect((await come(way, fourth)).status).toBe(303);
      expect(await outcome()).toEqual({ ok: false, message: 'The vault was locked during the sign-in. Unlock it and sign in again.' });
      expect(((await api('GET', root)).data as AccessView).toolServers).toHaveLength(1);
      await api('POST', root + '/lock', {});
      expect((await start('/toolServers/signin', { label: 'More orders', url: tools.url + '?more', ownerIds: [] })).status).toBe(423);
    } finally { await tools.close(); await auth.close(); }
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
