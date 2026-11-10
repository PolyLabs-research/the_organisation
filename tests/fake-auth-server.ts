import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { InvalidGrantError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

// An authorisation server for the tests: the protocol's own handlers for registering a client, asking a person,
// handing out tokens and renewing them, at a local address. What a real one keeps in a database is kept here in
// maps a test can read and change. The person it asks is the test: it agrees or refuses at once.

const token = (kind: string) => kind + '-' + randomBytes(18).toString('base64url');

export class FakeAuthorisationServer {
  /** Whether the person agrees when the browser arrives. */
  approves = true;
  /** How long a token lasts, in seconds. */
  lifetime = 3600;
  /** Whether a sign-in can be renewed at all. */
  renews = true;
  /** The service is having trouble: it answers a request for a token with an error of its own, which says nothing about the sign-in. */
  troubled = false;
  /** How long it takes to renew a sign-in, in milliseconds: long enough for others to arrive while one is waiting. */
  slow = 0;
  /** The kind of token it says it hands out. */
  kind = 'Bearer';
  /** What it says a program may ask for. A service that renews a sign-in only when asked to by name says so here. */
  scopes = ['orders.read', 'orders.write'];
  base = '';
  readonly clients = new Map<string, OAuthClientInformationFull>();
  /** Tokens that work now, and what each is for. */
  readonly access = new Map<string, { clientId: string; scopes: string[]; expiresAt: number; resource?: string }>();
  /** Refresh tokens that have not been used. Each is good once. */
  readonly refresh = new Map<string, { clientId: string; scopes: string[]; resource?: string }>();
  /** Every time the browser arrived: what the address asked for. */
  readonly asked: Array<{ clientId: string; redirectUri: string; state?: string; scopes: string[]; resource?: string; challenge: string }> = [];
  /** Every token handed out: for a code, or for a refresh token, which is named. */
  readonly issued: Array<{ grant: 'code' | 'refresh'; clientId: string; spent?: string; resource?: string }> = [];
  /** The tokens themselves, in the order they were handed out. */
  readonly handed: string[] = [];
  /** Every request that reached the server, by path. */
  readonly seen: string[] = [];
  private readonly codes = new Map<string, { clientId: string; challenge: string; scopes: string[]; resource?: string }>();
  private readonly server = http.createServer((req, res) => { this.seen.push((req.method ?? '') + ' ' + (req.url ?? '').split('?')[0]); this.app(req, res); });
  private app: express.Express = express();

  /** Withdraw every sign-in, as a person does at the service, or as one does by letting it run out. */
  withdraw(): void { this.access.clear(); this.refresh.clear(); }
  /** The tokens in use stop working, and the sign-ins behind them can still be renewed. */
  expire(): void { this.access.clear(); }

  private hand(clientId: string, scopes: string[], resource: string | undefined): OAuthTokens {
    const access = token('access');
    this.access.set(access, { clientId, scopes, expiresAt: Math.floor(Date.now() / 1000) + this.lifetime, resource });
    this.handed.push(access);
    const tokens: OAuthTokens = { access_token: access, token_type: this.kind, expires_in: this.lifetime, scope: scopes.join(' ') };
    if (this.renews) { tokens.refresh_token = token('refresh'); this.refresh.set(tokens.refresh_token, { clientId, scopes, resource }); }
    return tokens;
  }
  /** What a resource server asks before it takes a token. */
  verify(presented: string): AuthInfo {
    const known = this.access.get(presented);
    if (!known || known.expiresAt * 1000 < Date.now()) throw new InvalidTokenError('The token is not one that works.');
    return { token: presented, clientId: known.clientId, scopes: known.scopes, expiresAt: known.expiresAt, resource: known.resource ? new URL(known.resource) : undefined };
  }

  /** `registers: false` for a service that a program cannot register itself with: a person has to, and is given a client. */
  async listen(options: { registers?: boolean } = {}): Promise<void> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.base = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
    const provider: OAuthServerProvider = {
      clientsStore: {
        getClient: id => this.clients.get(id),
        ...(options.registers === false ? {} : { registerClient: (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>) => { const full = client as OAuthClientInformationFull; this.clients.set(full.client_id, full); return full; } }),
      },
      authorize: async (client, params: AuthorizationParams, res) => {
        this.asked.push({ clientId: client.client_id, redirectUri: params.redirectUri, state: params.state, scopes: params.scopes ?? [], resource: params.resource?.href, challenge: params.codeChallenge });
        const back = new URL(params.redirectUri);
        if (params.state) back.searchParams.set('state', params.state);
        if (!this.approves) back.searchParams.set('error', 'access_denied');
        else {
          const code = token('code');
          this.codes.set(code, { clientId: client.client_id, challenge: params.codeChallenge, scopes: params.scopes ?? [], resource: params.resource?.href });
          back.searchParams.set('code', code);
        }
        res.redirect(302, back.href);
      },
      challengeForAuthorizationCode: async (client, code) => {
        const known = this.codes.get(code);
        if (!known || known.clientId !== client.client_id) throw new InvalidGrantError('The code is not one that was given out.');
        return known.challenge;
      },
      exchangeAuthorizationCode: async (client, code, _verifier, _redirectUri, resource) => {
        const known = this.codes.get(code);
        // A code is good once.
        this.codes.delete(code);
        if (!known || known.clientId !== client.client_id) throw new InvalidGrantError('The code is not one that was given out.');
        this.issued.push({ grant: 'code', clientId: client.client_id, resource: resource?.href });
        return this.hand(client.client_id, known.scopes, resource?.href ?? known.resource);
      },
      exchangeRefreshToken: async (client, presented, _scopes, resource) => {
        if (this.troubled) throw new ServerError('The service is having trouble.');
        if (this.slow) await new Promise(resolve => setTimeout(resolve, this.slow));
        const known = this.refresh.get(presented);
        this.refresh.delete(presented);
        if (!known || known.clientId !== client.client_id) throw new InvalidGrantError('The refresh token is not one that works.');
        this.issued.push({ grant: 'refresh', clientId: client.client_id, spent: presented, resource: resource?.href });
        return this.hand(client.client_id, known.scopes, known.resource);
      },
      verifyAccessToken: async presented => this.verify(presented),
    };
    this.app = express();
    this.app.use(mcpAuthRouter({ provider, issuerUrl: new URL(this.base), scopesSupported: this.scopes, authorizationOptions: { rateLimit: false }, tokenOptions: { rateLimit: false }, clientRegistrationOptions: { rateLimit: false } }));
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}

/** What a person's browser does with a sign-in address: goes there, and is sent back with a code or a refusal. Returns where it was sent back to. */
export async function visit(authorizationUrl: string): Promise<URL> {
  const answer = await fetch(authorizationUrl, { redirect: 'manual' });
  await answer.body?.cancel();
  const location = answer.headers.get('location');
  if (answer.status !== 302 || !location) throw new Error('The authorisation server did not send the browser back: ' + answer.status);
  return new URL(location);
}
