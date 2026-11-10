import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { BusinessAccess } from '../src/server/access';
import { reachOf, signInURL, type Resolver } from '../src/server/access-network';
import { connectedTools } from '../src/server/access-tools';
import type { Privilege } from '../src/shared/privileges';
import { FakeAuthorisationServer, visit } from './fake-auth-server';
import { FakeToolServer, taking, text } from './fake-mcp-server';
import { QUIET, harness, runToRest, type Harness } from './helpers';
import { MockProvider } from '../src/server/providers/mock';
import type { AgentRequest, AgentResult } from '../src/server/providers/types';

// Signing in to a tool server through the browser. The real client runs against a tool server that wants a sign-in
// and an authorisation server built from the protocol's own handlers, both on this machine. The person's browser is
// the test: it goes where it is sent and comes back with what it is given.

const phrase = 'a long business vault passphrase';
const REDIRECT = 'http://127.0.0.1:4780/api/oauth/tools/callback';
let dir: string, server: FakeToolServer, auth: FakeAuthorisationServer, access: BusinessAccess, held: Set<Privilege>;
const signal = () => new AbortController().signal;
/** Sign in as a person does: start it, go where it says, and come back with the code. `targetId` is a connection whose sign-in is being made again. */
const signIn = async (over: object = {}, targetId: string | null = null) => {
  const state = randomBytes(8).toString('hex');
  const begun = await access.beginToolSignIn(targetId ? over : { label: 'Orders', url: server.url, ownerIds: ['cto'], ...over }, targetId, REDIRECT, state);
  const back = await visit(begun.url);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe(state);
  const id = await access.finishToolSignIn(begun.underWay, back.searchParams.get('code')!, access.vault.epoch);
  return access.vault.read().toolServers.find(item => item.id === id)!;
};
const kept = () => access.vault.read().toolServers[0]!;
const shown = async () => (await access.view()).toolServers[0]!;
const allow = async (...names: string[]) => {
  const view = await shown();
  await access.allowTools(view.id, { allowed: names.map(name => ({ name, fingerprint: view.tools.find(tool => tool.name === name)!.fingerprint })) });
};
const tools = (task = 't1') => connectedTools(access, 'cto', task, signal(), () => true);
const use = async (name: string, input: object, task = 't1') => JSON.parse(await tools(task).find(tool => tool.name === name)!.run(input as { [key: string]: unknown }));
/** Have the token in use look, to this program, as if it were about to run out. */
const nearlyOut = () => access.vault.change(data => { data.toolServers[0]!.signIn!.expiresAt = new Date(Date.now() + 5_000).toISOString(); });
const renewals = () => auth.issued.filter(item => item.grant === 'refresh');
const LAPSED = { error: 'The sign-in to this tool server has lapsed. A person has to sign in again, under Email & accounts.' };

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'tool-sign-in-'));
  auth = new FakeAuthorisationServer();
  await auth.listen();
  server = new FakeToolServer();
  server.auth = auth;
  await server.listen();
  held = new Set(['use_tools']);
  access = new BusinessAccess(path.join(dir, 'vault.json'), 'org_test', () => ['ceo', 'cto', 'cmo'], { allows: (_actor, privilege) => held.has(privilege) });
  await access.unlock(phrase, true);
});
afterEach(async () => { await access.dispose(); await server.close(); await auth.close(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('signing in to a tool server', () => {
  it('sends the person to the service the server names, comes back with a token, and connects the server with none of its tools allowed', async () => {
    const saved = await signIn();
    // The program registered itself, with nothing to keep secret and one address the browser may be sent back to.
    expect([...auth.clients.values()]).toEqual([expect.objectContaining({ client_name: 'the_organisation', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'] })]);
    expect([...auth.clients.values()][0]!.client_secret).toBeUndefined();
    // What the browser was sent with: who is asking, where to come back to, proof for later that the one who comes back is the one who left, and what the token is to be for.
    expect(auth.asked).toEqual([{ clientId: saved.signIn!.clientId, redirectUri: REDIRECT, state: expect.any(String), scopes: ['orders.read'], resource: server.url, challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) }]);
    expect(auth.issued).toEqual([{ grant: 'code', clientId: saved.signIn!.clientId, resource: server.url }]);
    // What is kept: the token where a token goes, and where the person signed in, which is where the sign-in will be renewed.
    expect(auth.access.has(saved.password)).toBe(true);
    expect(saved).toMatchObject({ label: 'Orders', prefix: 'orders', url: server.url, header: 'Authorization', ownerIds: ['cto'], enabled: true });
    expect(saved.signIn).toMatchObject({ issuer: auth.base + '/', tokenEndpoint: auth.base + '/token', clientGiven: false, clientSecret: '', resource: server.url, scope: 'orders.read', lapsed: false });
    expect(auth.refresh.has(saved.signIn!.refreshToken)).toBe(true);
    expect(Date.parse(saved.signIn!.expiresAt!) - Date.now()).toBeGreaterThan(3_500_000);
    // The server was asked for its tools with the new token, and a person has allowed none of them.
    const view = await shown();
    expect(view.tools.map(tool => [tool.name, tool.allowed])).toEqual([['find_order', false], ['cancel_order', false], ['remember', false], ['recall', false]]);
    expect(view).toMatchObject({ hasToken: true, signIn: { issuer: auth.base + '/', lapsed: false, renews: true } });
    expect(tools()).toEqual([]);
    // No token, and nothing that could get one, is anywhere a person or an agent can read it.
    for (const place of [JSON.stringify(await access.view()), await readFile(access.vault.file, 'utf8'), access.context('cto')]) {
      for (const secret of [saved.password, saved.signIn!.refreshToken]) expect(place).not.toContain(secret);
    }
    expect((await access.view()).audit[0]).toMatchObject({ actorId: 'person', action: 'tool_server_connected', targetId: saved.id });
  });

  it('calls a tool with the token the sign-in gave', async () => {
    const saved = await signIn();
    await allow('find_order');
    expect(await use('orders__find_order', { number: 'A-17' })).toEqual({ untrustedContent: 'Order A-17: 3 ferns, paid.' });
    expect(server.seen.at(-1)!.authorization).toBe('Bearer ' + saved.password);
  });

  it('does not sign in to a server that asks for no sign-in, and leaves nothing open on it', async () => {
    server.auth = null;
    server.token = '';
    await expect(signIn()).rejects.toMatchObject({ status: 409, message: 'This server does not ask for a sign-in. Connect it without one.' });
    await vi.waitFor(() => expect(server.open).toBe(0), { timeout: 10_000 });
    expect((await access.view()).toolServers).toEqual([]);
    await expect(signIn({ url: server.base + '/nothing-here' })).rejects.toMatchObject({ status: 404 });
    // A server that turns the program away and says nothing of any sign-in most likely wants a token.
    server.token = 'tool-server-token-0001';
    await expect(signIn()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('It may want a token instead.') });
  });

  it('connects nothing twice, and nothing for a team that does not exist', async () => {
    await signIn();
    await expect(signIn({ label: 'Again' })).rejects.toMatchObject({ status: 409, message: expect.stringContaining('already connected') });
    await expect(signIn({ url: server.url + '?other', ownerIds: ['nobody'] })).rejects.toThrow(/existing executive team/);
    await expect(signIn({ url: server.url + '?other', clientSecret: 'a-secret-with-no-client' })).rejects.toThrow(/goes with a client id/);
    expect(access.vault.read().toolServers).toHaveLength(1);
  });

  it('saves nothing if the vault is not as it was when the sign-in began', async () => {
    const begun = await access.beginToolSignIn({ label: 'Orders', url: server.url, ownerIds: ['cto'] }, null, REDIRECT, 'state-1');
    const code = (await visit(begun.url)).searchParams.get('code')!;
    await expect(access.finishToolSignIn(begun.underWay, code, access.vault.epoch + 1)).rejects.toMatchObject({ status: 409 });
    expect((await access.view()).toolServers).toEqual([]);
    // The code was good once, and has been spent.
    await expect(access.finishToolSignIn(begun.underWay, code, access.vault.epoch)).rejects.toMatchObject({ status: 502, message: expect.stringContaining('invalid_grant') });
  });

  it('says what to do for a service that will not register a program by itself, and signs in with the client a person gives', async () => {
    await auth.close();
    auth = new FakeAuthorisationServer();
    await auth.listen({ registers: false });
    server.auth = auth;
    await expect(signIn()).rejects.toMatchObject({ status: 409, message: expect.stringContaining('with ' + REDIRECT + ' as its redirect address') });
    // A person registers the program at the service, and is given a client for it.
    auth.clients.set('client-from-the-service', { client_id: 'client-from-the-service', client_secret: 'secret-from-the-service', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_post' });
    const saved = await signIn({ clientId: 'client-from-the-service', clientSecret: 'secret-from-the-service' });
    expect(saved.signIn).toMatchObject({ clientId: 'client-from-the-service', clientSecret: 'secret-from-the-service', clientGiven: true });
    expect(JSON.stringify(await access.view())).not.toContain('secret-from-the-service');
    server.tools.push({ name: 'echo', inputSchema: taking({}), run: () => text('The program proves itself with secret-from-the-service.') });
    await access.readTools(saved.id);
    await allow('echo');
    expect(await use('orders__echo', {})).toEqual({ untrustedContent: 'The program proves itself with [redacted].' });
    // Renewing proves which program is asking, with the secret.
    await nearlyOut();
    await allow('find_order', 'echo');
    expect(await use('orders__find_order', { number: 'A-1' })).toHaveProperty('untrustedContent');
    expect(renewals()).toHaveLength(1);
    // Signing in again uses the client that was given, without its being given again.
    await signIn({}, saved.id);
    expect(kept().signIn).toMatchObject({ clientId: 'client-from-the-service', clientSecret: 'secret-from-the-service', clientGiven: true });
  });
});

describe('where a sign-in may lead', () => {
  const resolve: Resolver = async host => ({ 'auth.example': ['93.184.216.34'], 'intranet.example': ['10.0.0.7'], 'both.example': ['93.184.216.34', '192.168.1.9'] })[host] ?? (() => { throw new Error('ENOTFOUND'); })();
  const at = (address: string) => reachOf(new URL(address), resolve);

  it('knows this machine from the network it is on, and that from the internet', async () => {
    expect(await Promise.all(['http://localhost:3000/', 'http://127.0.0.1/', 'http://[::1]:8080/'].map(at))).toEqual(['here', 'here', 'here']);
    expect(await Promise.all(['https://10.1.2.3/', 'https://192.168.0.4/', 'https://[fd00::1]/', 'https://169.254.169.254/', 'https://intranet.example/', 'https://both.example/'].map(at))).toEqual(['inside', 'inside', 'inside', 'inside', 'inside', 'inside']);
    expect(await Promise.all(['https://93.184.216.34/', 'https://auth.example/'].map(at))).toEqual(['outside', 'outside']);
    await expect(at('https://nowhere.example/')).rejects.toMatchObject({ status: 502 });
  });

  it('lets a server name a sign-in that is no further in than the server itself', async () => {
    const may = (address: string, server: 'here' | 'inside' | 'outside') => signInURL(address, server, resolve).then(() => true, () => false);
    // A server out on the internet: its sign-in is out there too, over HTTPS, and nowhere in here.
    expect(await Promise.all(['https://auth.example/authorize', 'https://93.184.216.34/token'].map(address => may(address, 'outside')))).toEqual([true, true]);
    expect(await Promise.all(['https://intranet.example/', 'https://10.0.0.7/', 'https://both.example/', 'http://127.0.0.1:8080/', 'http://localhost/', 'https://169.254.169.254/latest/meta-data', 'http://auth.example/'].map(address => may(address, 'outside')))).toEqual([false, false, false, false, false, false, false]);
    // A server inside the network may use a sign-in inside it, or outside. One on this machine may use any.
    expect(await Promise.all(['https://intranet.example/', 'https://auth.example/', 'http://127.0.0.1:8080/'].map(address => may(address, 'inside')))).toEqual([true, true, false]);
    expect(await Promise.all(['http://127.0.0.1:8080/', 'https://intranet.example/', 'https://auth.example/', 'http://intranet.example/'].map(address => may(address, 'here')))).toEqual([true, true, true, false]);
    await expect(signInURL('https://intranet.example/', 'outside', resolve)).rejects.toThrow(/inside this network or on this machine/);
  });

  it('will not follow a server whose sign-in is somewhere that cannot be used, or is for another address', async () => {
    server.signInAt = 'http://sign-in.example:8080';
    await expect(signIn()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('has to be HTTPS') });
    server.signInAt = null;
    server.signInFor = 'https://another.example/mcp';
    await expect(signIn()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('for another address than the one given') });
    expect(auth.asked).toEqual([]);
    expect((await access.view()).toolServers).toEqual([]);
  });

  it('holds every address in a sign-in to the rule, not only the ones it is told about first', async () => {
    // A sign-in service that is where it may be, and says a program registers itself somewhere that it may not.
    const service = http.createServer((req, res) => {
      const base = 'http://' + req.headers.host;
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: 'http://register.example:8080/register', response_types_supported: ['code'], code_challenge_methods_supported: ['S256'] }));
    });
    await new Promise<void>(resolve => service.listen(0, '127.0.0.1', resolve));
    try {
      server.signInAt = 'http://127.0.0.1:' + (service.address() as AddressInfo).port;
      await expect(signIn()).rejects.toMatchObject({ status: 502, message: expect.stringContaining('has to be HTTPS') });
    } finally { service.closeAllConnections(); await new Promise<void>(resolve => service.close(() => resolve())); }
  });

  it('reads where a server’s sign-in is from the server itself, and not from wherever the server points', async () => {
    const reached: string[] = [];
    const other = http.createServer((req, res) => { reached.push(req.method + ' ' + req.url); res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ resource: server.url, authorization_servers: ['http://127.0.0.1:9'] })); });
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    try {
      // Turned away, the program is told that the sign-in is described at another address. Only the server can say who signs people in for it.
      server.describedAt = 'http://127.0.0.1:' + (other.address() as AddressInfo).port + '/sign-in';
      const saved = await signIn();
      expect(reached).toEqual([]);
      expect(saved.signIn!.issuer).toBe(auth.base + '/');
    } finally { other.closeAllConnections(); await new Promise<void>(resolve => other.close(() => resolve())); }
  });

  it('asks to stay signed in where the service says that has to be asked for, unless a person has said what to ask for', async () => {
    await auth.close();
    auth = new FakeAuthorisationServer();
    auth.scopes = ['orders.read', 'offline_access'];
    await auth.listen();
    server.auth = auth;
    const saved = await signIn();
    expect(auth.asked[0]!.scopes).toEqual(['orders.read', 'offline_access']);
    await signIn({ scope: 'orders.read' }, saved.id);
    expect(auth.asked[1]!.scopes).toEqual(['orders.read']);
  });

  it('takes only a token of the kind it can send', async () => {
    auth.kind = 'mac';
    await expect(signIn()).rejects.toMatchObject({ status: 502, message: 'The service gave a kind of token this cannot use.' });
    expect((await access.view()).toolServers).toEqual([]);
  });
});

describe('keeping a sign-in going', () => {
  it('renews a sign-in that is about to run out before a call, once however many calls are waiting, and keeps what takes the old refresh token’s place', async () => {
    const saved = await signIn();
    await allow('find_order');
    await nearlyOut();
    // The service takes its time, so the others arrive while the first is still waiting. A refresh token is good once: a second caller spending it would lose the sign-in.
    auth.slow = 250;
    const answers = await Promise.all(['t1', 't2', 't3', 't4', 't5'].map(task => use('orders__find_order', { number: task }, task)));
    expect(answers.every(answer => 'untrustedContent' in answer)).toBe(true);
    // One renewal, spending the refresh token that was kept. What it gave is what is kept now.
    expect(renewals()).toEqual([{ grant: 'refresh', clientId: saved.signIn!.clientId, spent: saved.signIn!.refreshToken, resource: server.url }]);
    const now = kept();
    expect(now.password).not.toBe(saved.password);
    expect(auth.access.has(now.password)).toBe(true);
    expect(auth.refresh.has(now.signIn!.refreshToken)).toBe(true);
    expect(now.signIn!.refreshToken).not.toBe(saved.signIn!.refreshToken);
    expect(Date.parse(now.signIn!.expiresAt!) - Date.now()).toBeGreaterThan(3_500_000);
    expect(server.seen.at(-1)!.authorization).toBe('Bearer ' + now.password);
    // With a token that has a long time to run, nothing is renewed.
    await use('orders__find_order', { number: 'again' });
    expect(renewals()).toHaveLength(1);
  });

  it('carries a task’s session over a renewal, with the new token', async () => {
    await signIn();
    await allow('remember', 'recall');
    await use('orders__remember', { value: 'the blue fern' });
    await nearlyOut();
    expect(await use('orders__recall', {})).toEqual({ untrustedContent: 'the blue fern' });
    expect(renewals()).toHaveLength(1);
    expect(server.seen.at(-1)!.authorization).toBe('Bearer ' + kept().password);
    expect(new Set(server.calls.map(call => call.session)).size).toBe(1);
  });

  it('renews and makes the call again when the server turns down a token whose date says it should still work', async () => {
    const saved = await signIn();
    await allow('find_order');
    auth.expire();
    expect(await use('orders__find_order', { number: 'A-17' })).toEqual({ untrustedContent: 'Order A-17: 3 ferns, paid.' });
    expect(renewals()).toHaveLength(1);
    expect(kept().password).not.toBe(saved.password);
    // The call that was turned down never reached the tool, so it was made once.
    expect(server.calls.map(call => call.input)).toEqual([{ number: 'A-17' }]);
    // Several turned down at once with the same token: one of them renews it, and the rest use what that one got.
    auth.expire();
    auth.slow = 250;
    const answers = await Promise.all(['t1', 't2', 't3', 't4'].map(task => use('orders__find_order', { number: task }, task)));
    expect(answers.every(answer => 'untrustedContent' in answer)).toBe(true);
    expect(renewals()).toHaveLength(2);
    auth.slow = 0;
    // The same when a person reads the server's tools again.
    auth.expire();
    await access.readTools(saved.id);
    expect(renewals()).toHaveLength(3);
  });

  it('does not put what an old sign-in’s renewal brings back in the place of a sign-in made since', async () => {
    const saved = await signIn();
    await allow('find_order');
    await nearlyOut();
    // A renewal sets off and is slow to come back. Before it does, the person signs in again.
    auth.slow = 400;
    const call = use('orders__find_order', { number: 'A-1' });
    await vi.waitFor(() => expect(auth.seen.filter(request => request === 'POST /token')).toHaveLength(2), { timeout: 10_000 });
    const again = await signIn({}, saved.id);
    await call;
    expect(renewals()).toHaveLength(1);
    // What is kept is the new sign-in, whole: its token and the refresh token that goes with it.
    expect(kept().password).toBe(again.password);
    expect(kept().signIn).toMatchObject({ refreshToken: again.signIn!.refreshToken, signedInAt: again.signIn!.signedInAt });
    expect(auth.handed.indexOf(again.password)).toBeGreaterThan(auth.handed.indexOf(saved.password));
    auth.slow = 0;
    expect(await use('orders__find_order', { number: 'A-2' })).toHaveProperty('untrustedContent');
  });

  it('renews a sign-in where the person signed in, and nowhere the server names later', async () => {
    const saved = await signIn();
    await allow('find_order');
    const reached: string[] = [];
    const other = http.createServer((req, res) => { reached.push(req.method + ' ' + req.url); res.writeHead(404).end(); });
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve));
    try {
      // The tool server now says its sign-in is somewhere else. Nobody signed in there.
      server.signInAt = 'http://127.0.0.1:' + (other.address() as AddressInfo).port;
      auth.expire();
      expect(await use('orders__find_order', { number: 'A-17' })).toHaveProperty('untrustedContent');
      expect(renewals()).toEqual([expect.objectContaining({ spent: saved.signIn!.refreshToken })]);
      expect(reached).toEqual([]);
    } finally { other.closeAllConnections(); await new Promise<void>(resolve => other.close(() => resolve())); }
  });

  it('tells the agent a person has to sign in again when a sign-in can no longer be renewed, offers its tools no more, and puts it on the person’s desk', async () => {
    const saved = await signIn();
    await allow('find_order');
    const [tool] = tools();
    auth.withdraw();
    expect(JSON.parse(await tool!.run({ number: 'A-17' }))).toEqual(LAPSED);
    expect(kept().signIn!.lapsed).toBe(true);
    expect(server.calls).toEqual([]);
    expect(tools()).toEqual([]);
    expect(access.context('cto')).not.toContain('find_order');
    const view = await access.view();
    expect(view.toolServers[0]!.signIn).toMatchObject({ lapsed: true });
    expect(view.requests).toEqual([expect.objectContaining({ actorId: 'system', service: 'Orders', status: 'open', reason: expect.stringContaining('Sign in again') })]);
    expect(view.audit.some(entry => entry.action === 'sign_in_lapsed' && entry.targetId === saved.id)).toBe(true);
    // Asked again, it says the same and asks the service nothing: there is nothing more to learn there.
    const before = auth.seen.length;
    expect(JSON.parse(await tool!.run({ number: 'A-17' }))).toEqual(LAPSED);
    await expect(access.readTools(saved.id)).rejects.toMatchObject({ status: 403, message: LAPSED.error });
    expect(auth.seen.length).toBe(before);
    expect((await access.view()).requests).toHaveLength(1);
  });

  it('counts a sign-in that the service gave no way to renew as lapsed when its token stops working', async () => {
    auth.renews = false;
    const saved = await signIn();
    expect(saved.signIn!.refreshToken).toBe('');
    expect((await shown()).signIn).toMatchObject({ renews: false, lapsed: false });
    await allow('find_order');
    expect(await use('orders__find_order', { number: 'A-1' })).toHaveProperty('untrustedContent');
    auth.expire();
    expect(await use('orders__find_order', { number: 'A-2' })).toEqual(LAPSED);
    expect(kept().signIn!.lapsed).toBe(true);
  });

  it('does not count a service in trouble, or one that cannot be reached, as a sign-in that has lapsed, and asks it once for all who are waiting', async () => {
    const saved = await signIn();
    await allow('find_order');
    await nearlyOut();
    const later = { error: 'The sign-in to this tool server could not be renewed just now. Try again shortly.' };
    auth.troubled = true;
    const asked = () => auth.seen.filter(request => request === 'POST /token').length, before = asked();
    expect(await Promise.all(['t1', 't2', 't3', 't4'].map(task => use('orders__find_order', { number: task }, task)))).toEqual([later, later, later, later]);
    expect(asked() - before).toBe(1);
    expect(kept().signIn).toMatchObject({ lapsed: false, refreshToken: saved.signIn!.refreshToken });
    expect(tools()).toHaveLength(1);
    expect((await access.view()).requests).toEqual([]);
    // It is not asked again straight away, though it is well again. Half a minute on it is, and the same sign-in is renewed as if nothing had happened.
    auth.troubled = false;
    expect(await use('orders__find_order', { number: 'A-0' })).toEqual(later);
    expect(asked() - before).toBe(1);
    const clock = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => clock() + 31_000);
    expect(await use('orders__find_order', { number: 'A-1' })).toHaveProperty('untrustedContent');
    expect(asked() - before).toBe(2);
    await nearlyOut();
    await auth.close();
    try {
      expect(await use('orders__find_order', { number: 'A-2' })).toEqual(later);
      expect(kept().signIn!.lapsed).toBe(false);
    } finally { auth = new FakeAuthorisationServer(); await auth.listen(); }
  });

  it('signs in again to the same connection, with what was allowed there still allowed', async () => {
    const saved = await signIn();
    await allow('find_order', 'recall');
    auth.withdraw();
    await use('orders__find_order', { number: 'A-1' });
    expect(kept().signIn!.lapsed).toBe(true);
    const again = await signIn({}, saved.id);
    expect(again.id).toBe(saved.id);
    expect(access.vault.read().toolServers).toHaveLength(1);
    expect(again.signIn).toMatchObject({ lapsed: false, clientGiven: false });
    expect(again.password).not.toBe(saved.password);
    expect((await shown()).tools.filter(tool => tool.allowed).map(tool => tool.name)).toEqual(['find_order', 'recall']);
    expect(await use('orders__find_order', { number: 'A-2' })).toEqual({ untrustedContent: 'Order A-2: 3 ferns, paid.' });
    // What was waiting on the person's desk has been dealt with.
    const view = await access.view();
    expect(view.requests.map(request => request.status)).toEqual(['resolved']);
    expect(view.audit[0]).toMatchObject({ action: 'tool_called' });
    expect(view.audit.some(entry => entry.action === 'signed_in_again' && entry.targetId === saved.id)).toBe(true);
  });

  it('takes the tokens of a sign-in out of what a tool returns, and will not send them', async () => {
    const saved = await signIn();
    server.tools.push({ name: 'echo', inputSchema: taking({ note: { type: 'string' } }), run: input => text('You said ' + String(input.note) + '. I was sent ' + saved.password + ' and I guess ' + saved.signIn!.refreshToken + '.') });
    await access.readTools(saved.id);
    await allow('echo');
    expect(await use('orders__echo', { note: 'hello' })).toEqual({ untrustedContent: 'You said hello. I was sent [redacted] and I guess [redacted].' });
    for (const secret of [saved.password, saved.signIn!.refreshToken]) expect(await use('orders__echo', { note: 'look: ' + secret })).toEqual({ error: 'This cannot contain a saved password or token.' });
  });

  it('has no token of a person’s to replace, and forgets the sign-in with the connection', async () => {
    const saved = await signIn();
    await expect(access.password('toolServers', saved.id, 'a-token-of-my-own')).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Sign in to it again') });
    expect(kept().password).toBe(saved.password);
    await access.remove('toolServers', saved.id);
    expect((await access.view()).toolServers).toEqual([]);
    expect(access.vault.read().toolServers).toEqual([]);
  });
});

describe('in an organisation', () => {
  /** A simulator whose agents each use the connected tool once, if they are offered it. */
  class Using extends MockProvider {
    readonly returned: string[] = [];
    override async agent(req: AgentRequest): Promise<AgentResult> {
      const tool = req.tools.find(item => item.name === 'orders__find_order');
      if (tool) this.returned.push(await tool.run({ number: 'A-17' }));
      return super.agent(req);
    }
  }
  let run: Harness | undefined;
  afterEach(async () => { await run?.cleanup(); run = undefined; });

  it('tells the board when a sign-in lapses under its agents, once, and goes on with its work without the tools', async () => {
    const provider = new Using(QUIET);
    run = await harness({ provider, executives: [{ profileId: 'engineering', agentCount: 2 }] });
    const vault = run.runner.access;
    await vault.unlock(phrase, true);
    const begun = await vault.beginToolSignIn({ label: 'Orders', url: server.url, ownerIds: ['cto'] }, null, REDIRECT, 'state-1');
    const id = await vault.finishToolSignIn(begun.underWay, (await visit(begun.url)).searchParams.get('code')!, vault.vault.epoch);
    const view = (await vault.view()).toolServers[0]!;
    await vault.allowTools(id, { allowed: view.tools.filter(tool => tool.name === 'find_order').map(tool => ({ name: tool.name, fingerprint: tool.fingerprint })) });
    await run.runner.setPrivilege('cto', 'use_tools', true);
    // The sign-in is withdrawn at the service before any agent has used it.
    auth.withdraw();
    await runToRest(run.runner);
    // The first agent to use the tool found out, and was told what a person has to do. Agents that started after that were not offered it at all.
    expect(provider.returned.length).toBeGreaterThan(0);
    expect(new Set(provider.returned)).toEqual(new Set([JSON.stringify(LAPSED)]));
    expect(server.calls).toEqual([]);
    const said = run.org.board.filter(message => message.title === 'The sign-in to Orders has lapsed');
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ type: 'system', fromId: 'system', body: expect.stringContaining('sign in to it again') });
    // The organisation's work went on to the end of its cycle all the same.
    expect(run.org.pauseReason).toBe('cycle_limit');
    expect((await vault.view()).requests).toHaveLength(1);
  });
});
