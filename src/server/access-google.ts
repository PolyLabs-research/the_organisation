import { createHash, randomBytes } from 'node:crypto';
import type { Express, Request } from 'express';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import type { MailMessage, MailSummary } from '../shared/access';
import type { Config } from './config';
import type { Registry } from './registry';
import type { MailTransport } from './access-mail';
import { AccessError, type MailboxSecret } from './access-vault';

export const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];
export function googleConfigured(): boolean { return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
const credentials = () => {
  if (!googleConfigured()) throw new AccessError('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET on the server, then restart it.', 503);
  return { client_id: process.env.GOOGLE_CLIENT_ID!, client_secret: process.env.GOOGLE_CLIENT_SECRET! };
};
type Fetcher = typeof fetch;
async function googleJSON<T>(fetcher: Fetcher, url: string, options: RequestInit): Promise<T> {
  try {
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000);
    const response = await fetcher(url, { ...options, signal, redirect: 'error' });
    if (!response.ok) {
      await response.body?.cancel();
      throw new AccessError(response.status === 401 || response.status === 403 ? 'Google refused access. Reconnect Gmail and check the consent scopes or Workspace policy.' : 'Google could not complete the request. Check its status before retrying a send.', 502);
    }
    if (!response.body) throw new Error('Empty response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1024 * 1024) { await reader.cancel(); throw new AccessError('This Google response is too large. Open the message in Gmail instead.', 413); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch (error) {
    if (error instanceof AccessError) throw error;
    throw new AccessError('Google could not complete the connection. Retry the connection; check Gmail before retrying a send.', 502);
  }
}
interface Token { access_token: string; refresh_token?: string; scope?: string; }
export async function exchangeGoogleCode(code: string, verifier: string, redirectUri: string, fetcher: Fetcher = fetch): Promise<{ address: string; refreshToken: string }> {
  const token = await googleJSON<Token>(fetcher, 'https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ ...credentials(), code, code_verifier: verifier, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  if (!token.refresh_token || !token.access_token || !GMAIL_SCOPES.every(scope => token.scope?.split(' ').includes(scope))) throw new AccessError('Google did not grant offline Gmail read and send access. Connect again and approve both permissions.');
  const profile = await googleJSON<{ emailAddress: string }>(fetcher, 'https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: 'Bearer ' + token.access_token } });
  if (!profile.emailAddress || !/^[^\s@]+@[^\s@]+$/.test(profile.emailAddress)) throw new AccessError('Google did not return a mailbox address.');
  return { address: profile.emailAddress, refreshToken: token.refresh_token };
}
interface GmailPart { mimeType?: string; filename?: string; body?: { data?: string; size?: number }; parts?: GmailPart[]; headers?: Array<{ name: string; value: string }>; }
interface GmailMessage { id: string; internalDate?: string; payload?: GmailPart; snippet?: string; sizeEstimate?: number; }
const summary = (message: GmailMessage): MailSummary => {
  const header = (name: string) => (message.payload?.headers?.find(item => item.name.toLowerCase() === name)?.value ?? '').replace(/[\r\n]/g, ' ').slice(0, 400);
  const date = Number(message.internalDate);
  return { id: message.id, from: header('from'), subject: header('subject') || '(no subject)', date: Number.isFinite(date) ? new Date(date).toISOString() : '' };
};
/** A refresh token is encrypted in the mailbox's secret slot; short-lived access tokens stay in this call only. */
export class GmailMail implements MailTransport {
  constructor(private readonly fetcher: Fetcher = fetch) {}
  private async token(box: MailboxSecret, signal: AbortSignal): Promise<string> {
    const result = await googleJSON<Token>(this.fetcher, 'https://oauth2.googleapis.com/token', {
      method: 'POST', signal, body: new URLSearchParams({ ...credentials(), refresh_token: box.password, grant_type: 'refresh_token' }),
    });
    if (!result.access_token) throw new AccessError('Reconnect Gmail: Google did not return an access token.', 502);
    return result.access_token;
  }
  private api<T>(token: string, path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    return googleJSON<T>(this.fetcher, 'https://gmail.googleapis.com/gmail/v1/users/me/' + path, {
      signal, method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  }
  async check(box: MailboxSecret, signal: AbortSignal) {
    const profile = await this.api<{ emailAddress: string }>(await this.token(box, signal), 'profile', signal);
    if (profile.emailAddress.toLowerCase() !== box.address.toLowerCase()) throw new AccessError('This Google connection belongs to another mailbox.');
  }
  async list(box: MailboxSecret, signal: AbortSignal): Promise<MailSummary[]> {
    const token = await this.token(box, signal);
    const listed = await this.api<{ messages?: Array<{ id: string }> }>(token, 'messages?maxResults=20&labelIds=INBOX', signal);
    const result: MailSummary[] = [];
    for (const item of (listed.messages ?? []).slice(0, 20)) {
      if (!/^[a-zA-Z0-9_-]+$/.test(item.id)) continue;
      result.push(summary(await this.api<GmailMessage>(token, 'messages/' + item.id + '?format=metadata&metadataHeaders=From&metadataHeaders=Subject', signal)));
    }
    return result;
  }
  async read(box: MailboxSecret, messageId: string, signal: AbortSignal): Promise<MailMessage> {
    if (!/^[a-zA-Z0-9_-]{1,200}$/.test(messageId)) throw new AccessError('Select a message from the inbox first.');
    const token = await this.token(box, signal);
    const message = await this.api<GmailMessage>(token, 'messages/' + messageId + '?format=full', signal);
    const plain: string[] = [], html: string[] = [];
    const visit = (part: GmailPart, depth = 0) => {
      if (depth > 20 || part.filename) return;
      if (part.body?.data && ['text/plain', 'text/html'].includes(part.mimeType ?? '')) {
        (part.mimeType === 'text/plain' ? plain : html).push(Buffer.from(part.body.data, 'base64url').toString('utf8'));
      }
      for (const child of part.parts ?? []) visit(child, depth + 1);
    };
    if (message.payload) visit(message.payload);
    const text = plain.length ? plain.join('\n') : html.length
      ? (await simpleParser(Buffer.from('Content-Type: text/html; charset=utf-8\r\n\r\n' + html.join('\n')), { skipTextToHtml: true, skipImageLinks: true, maxHtmlLengthToParse: 256 * 1024 })).text ?? ''
      : message.snippet ?? '';
    return { ...summary(message), text: text.slice(0, 20000), truncated: text.length > 20000 };
  }
  async send(box: MailboxSecret, draft: { id: string; to: string; subject: string; text: string }, signal: AbortSignal) {
    const token = await this.token(box, signal);
    const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows', disableFileAccess: true, disableUrlAccess: true });
    const mime = await composer.sendMail({ from: box.address, to: draft.to, subject: draft.subject, text: draft.text, messageId: '<' + draft.id + '@' + box.address.split('@')[1] + '>' });
    if (!Buffer.isBuffer(mime.message)) throw new AccessError('The message could not be prepared.', 500);
    await this.api(token, 'messages/send', signal, { raw: mime.message.toString('base64url') });
  }
}
interface Pending { orgId: string; ownerIds: string[]; label: string; verifier: string; cookie: string; redirect: string; expires: number; epoch: number; }
const local = (config: Config) => ['localhost', '127.0.0.1', '::1', '[::1]'].includes(config.host);
const cookieOf = (req: Request) => /(?:^|;\s*)org_google_flow=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
export function googleRoutes(app: Express, registry: Registry, config: Config, exchange = exchangeGoogleCode) {
  const pending = new Map<string, Pending>();
  app.post('/api/orgs/:id/access/google/start', (req, res) => {
    if (!local(config)) throw new AccessError('Google sign-in is available only on a loopback server.', 403);
    const access = registry.get(String(req.params.id))?.access;
    if (!access) throw new AccessError('No such organisation.', 404);
    if (!access.vault.unlocked) throw new AccessError('Unlock the vault before connecting Gmail.', 423);
    const spec = access.googleGrant(req.body);
    const { client_id } = credentials();
    for (const [key, value] of pending) if (value.expires < Date.now()) pending.delete(key);
    if (pending.size >= 50) throw new AccessError('Too many sign-in attempts are waiting. Try again in ten minutes.', 429);
    const state = randomBytes(32).toString('hex'), cookie = randomBytes(32).toString('hex'), verifier = randomBytes(32).toString('base64url');
    const redirect = req.protocol + '://' + req.headers.host + '/api/oauth/google/callback';
    pending.set(state, { orgId: String(req.params.id), ...spec, verifier, cookie, redirect, expires: Date.now() + 10 * 60_000, epoch: access.vault.epoch });
    res.cookie('org_google_flow', cookie, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/api/oauth/google/callback', maxAge: 10 * 60_000 });
    res.setHeader('Cache-Control', 'no-store');
    const params = new URLSearchParams({ client_id, redirect_uri: redirect, response_type: 'code', scope: GMAIL_SCOPES.join(' '), access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    res.json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + params });
  });
  app.get('/api/oauth/google/callback', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = pending.get(state);
    if (!local(config) || !flow || flow.expires < Date.now() || flow.cookie !== cookieOf(req) || new URL(flow.redirect).host !== req.headers.host) throw new AccessError('This Google sign-in expired or did not start in this browser. Connect Gmail again.', 400);
    pending.delete(state);
    res.clearCookie('org_google_flow', { path: '/api/oauth/google/callback' });
    const access = registry.get(flow.orgId)?.access;
    if (!access?.vault.unlocked || flow.epoch !== access.vault.epoch) throw new AccessError('The vault was locked during sign-in. Unlock it and connect Gmail again.', 409);
    if (req.query.error || typeof req.query.code !== 'string' || req.query.code.length > 4096) throw new AccessError('Google sign-in was cancelled or denied. No mailbox was connected.');
    const result = await exchange(req.query.code, flow.verifier, flow.redirect);
    await access.addGmail(result.address, result.refreshToken, flow, flow.epoch);
    res.redirect(303, '/?access=connected#/org/' + flow.orgId);
  });
}
