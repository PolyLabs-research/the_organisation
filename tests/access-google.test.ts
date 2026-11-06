import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exchangeGoogleCode, GmailMail, GMAIL_SCOPES, googleRoutes } from '../src/server/access-google';
import { AccessError, type MailboxSecret } from '../src/server/access-vault';
import { Registry } from '../src/server/registry';
import { Store } from '../src/server/store';
import { MockProvider } from '../src/server/providers/mock';
import type { Config } from '../src/server/config';
import { QUIET } from './helpers';

const box: MailboxSecret = { id: 'mail_test', provider: 'gmail', label: 'Business Gmail', address: 'office@paperclips.example', username: 'office@paperclips.example', password: 'refresh-test-secret', imapHost: '', smtpHost: '', smtpPort: 465, ownerIds: ['coo'], enabled: true, createdAt: '' };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const configure = () => { vi.stubEnv('GOOGLE_CLIENT_ID', 'test-client.apps.googleusercontent.com'); vi.stubEnv('GOOGLE_CLIENT_SECRET', 'test-client-secret'); };
afterEach(() => vi.unstubAllEnvs());

describe('Gmail API adapter', () => {
  it('exchanges an OAuth code with PKCE and requires both requested scopes and a refresh token', async () => {
    configure();
    const fake = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ access_token: 'access-test-secret', refresh_token: box.password, scope: GMAIL_SCOPES.join(' ') })).mockResolvedValueOnce(json({ emailAddress: box.address }));
    expect(await exchangeGoogleCode('code', 'verifier', 'http://localhost:4780/api/oauth/google/callback', fake)).toEqual({ address: box.address, refreshToken: box.password });
    const body = fake.mock.calls[0]![1]!.body as URLSearchParams;
    expect(body.get('code_verifier')).toBe('verifier');
    expect(body.get('grant_type')).toBe('authorization_code');
    const denied = vi.fn<typeof fetch>().mockResolvedValue(json({ access_token: 'access', refresh_token: 'refresh', scope: GMAIL_SCOPES[0] }));
    await expect(exchangeGoogleCode('code', 'verifier', 'http://localhost/callback', denied)).rejects.toThrow(/both permissions/);
  });
  it('refreshes server-side, lists inbox metadata, and reads plain text without modifying Gmail', async () => {
    configure();
    const fake = vi.fn<typeof fetch>(async (url, options) => {
      const address = String(url);
      if (address.endsWith('/token')) return json({ access_token: 'short-lived-secret' });
      expect((options?.headers as Record<string, string>).Authorization).toBe('Bearer short-lived-secret');
      if (address.includes('maxResults=')) return json({ messages: [{ id: 'abc123' }] });
      return json({ id: 'abc123', internalDate: '1760000000000', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'From', value: 'Supplier <supplier@example.com>' }, { name: 'Subject', value: 'Verification' }], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from('Verify your email using code 123456.').toString('base64url') } }, { mimeType: 'text/plain', filename: 'ignore.txt', body: { data: Buffer.from('attachment data').toString('base64url') } }] } });
    });
    const gmail = new GmailMail(fake), signal = new AbortController().signal;
    expect(await gmail.list(box, signal)).toMatchObject([{ id: 'abc123', subject: 'Verification' }]);
    const read = await gmail.read(box, 'abc123', signal);
    expect(read.text).toBe('Verify your email using code 123456.');
    expect(fake.mock.calls.filter(([url]) => String(url).includes('gmail.googleapis.com')).every(([, options]) => options?.method === 'GET')).toBe(true);
    expect((fake.mock.calls[0]![1]!.body as URLSearchParams).get('refresh_token')).toBe(box.password);
  });
  it('constructs a MIME email from the fixed mailbox and sends only when explicitly called', async () => {
    configure();
    const fake = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ access_token: 'access' })).mockResolvedValueOnce(json({ id: 'sent123' }));
    await new GmailMail(fake).send(box, { id: 'draft_test', to: 'supplier@example.com', subject: 'Quote', text: 'Please quote for 10 boxes.' }, new AbortController().signal);
    const [url, options] = fake.mock.calls[1]!;
    expect(String(url)).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');
    const mime = Buffer.from(JSON.parse(options!.body as string).raw, 'base64url').toString('utf8');
    expect(mime).toContain('From: office@paperclips.example');
    expect(mime).toContain('To: supplier@example.com');
    expect(mime).toContain('Please quote for 10 boxes.');
    expect(mime).not.toContain(box.password);
  });
  it('does not forward Google error bodies, fetch errors, tokens, redirects or oversized responses', async () => {
    configure();
    const signal = new AbortController().signal;
    const bad = vi.fn<typeof fetch>().mockResolvedValue(json({ error: box.password }, 401));
    await expect(new GmailMail(bad).list(box, signal)).rejects.toThrow(/Google refused access/);
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error('request contained ' + box.password));
    await expect(new GmailMail(network).list(box, signal)).rejects.not.toThrow(box.password);
    const tooLarge = vi.fn<typeof fetch>().mockResolvedValue(new Response('x'.repeat(1024 * 1024 + 1)));
    await expect(new GmailMail(tooLarge).list(box, signal)).rejects.toMatchObject({ status: 413 });
    expect(bad.mock.calls[0]![1]!.redirect).toBe('error');
  });
});

describe('Google callback binding', () => {
  let dir: string, registry: Registry, server: Server, base: string, orgId: string;
  const exchange = vi.fn(async () => ({ address: box.address, refreshToken: box.password }));
  const start = async () => {
    const response = await fetch(base + '/api/orgs/' + orgId + '/access/google/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: 'Office', ownerIds: ['coo'] }) });
    const url = new URL((await response.json() as { url: string }).url);
    return { state: url.searchParams.get('state')!, cookie: response.headers.get('set-cookie')!.split(';')[0]!, url };
  };
  async function setup() {
    configure();
    exchange.mockClear();
    dir = await mkdtemp(path.join(os.tmpdir(), 'google-access-'));
    const store = new Store(dir); await store.init();
    registry = new Registry(store, new MockProvider(QUIET));
    const runner = await registry.create({ name: 'Only Paperclips', idea: 'Sell paperclips for a sustainable small business.', executives: [{ profileId: 'operations' }] });
    orgId = runner.org.id; await runner.access.unlock('test business vault passphrase', true);
    const app = express(); app.use(express.json());
    const config: Config = { port: 0, host: '127.0.0.1', dataDir: dir, provider: 'mock', providerReason: 'test', production: false, workspace: 'default', anthropicAmbient: false, claudeCode: { command: 'claude', extraUsage: false, blocked: null } };
    googleRoutes(app, registry, config, exchange);
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(error instanceof AccessError ? error.status : 500).json({ error: error instanceof Error ? error.message : 'Failed' }); });
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  }
  afterEach(async () => {
    if (registry) await registry.shutdown();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    if (dir) await rm(dir, { recursive: true, force: true });
  });
  it('binds a single-use state to the browser, organisation and unlocked vault session', async () => {
    await setup();
    const flow = await start();
    expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(flow.url.searchParams.get('scope')).toBe(GMAIL_SCOPES.join(' '));
    expect(flow.url.href).not.toContain('test-client-secret');
    const callback = base + '/api/oauth/google/callback?state=' + flow.state + '&code=authcode';
    expect((await fetch(callback, { redirect: 'manual' })).status).toBe(400);
    expect(exchange).not.toHaveBeenCalled();
    const accepted = await fetch(callback, { headers: { Cookie: flow.cookie }, redirect: 'manual' });
    expect(accepted.status).toBe(303);
    expect(accepted.headers.get('location')).toBe('/?access=connected#/org/' + orgId);
    expect((await registry.get(orgId)!.access.view()).mailboxes[0]).toMatchObject({ provider: 'gmail', address: box.address, ownerIds: ['coo'] });
    expect(JSON.stringify(await registry.get(orgId)!.access.view())).not.toContain(box.password);
    expect((await fetch(callback, { headers: { Cookie: flow.cookie }, redirect: 'manual' })).status).toBe(400);
    expect(exchange).toHaveBeenCalledTimes(1);
  });
  it('rejects a denied consent and a callback after lock, before exchanging any code', async () => {
    await setup();
    const denied = await start();
    expect((await fetch(base + '/api/oauth/google/callback?state=' + denied.state + '&error=access_denied', { headers: { Cookie: denied.cookie }, redirect: 'manual' })).status).toBe(400);
    const flow = await start();
    await registry.get(orgId)!.access.lock();
    await registry.get(orgId)!.access.unlock('test business vault passphrase');
    const response = await fetch(base + '/api/oauth/google/callback?state=' + flow.state + '&code=code', { headers: { Cookie: flow.cookie }, redirect: 'manual' });
    expect(response.status).toBe(409);
    expect(exchange).not.toHaveBeenCalled();
  });
});
