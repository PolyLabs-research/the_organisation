import { discoverAuthorizationServerMetadata, discoverOAuthProtectedResourceMetadata, exchangeAuthorization, extractWWWAuthenticateParams, refreshAuthorization, registerClient, selectResourceURL, startAuthorization, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { OAuthError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationServerMetadata, OAuthClientInformationMixed, OAuthProtectedResourceMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { capped } from './access-mcp';
import { reachOf, signInURL, toolServerURL, type Reach, type Resolver } from './access-network';
import { AccessError, type ToolSignIn } from './access-vault';

// Signing in to a tool server through the browser (OAuth 2.1, as the Model Context Protocol asks for it). A server
// that wants a sign-in says which authorisation server does it. This program registers itself there, sends the
// person's browser to it, and is handed a code when they have agreed, which it exchanges for a token. The requests
// themselves are the protocol's own client's. What is decided here is where they may go and what is kept.
//
// - Every address in a sign-in is named by the tool server, not by a person, so each is held to the rule in
//   signInURL: a server may not point this program, or the browser, further in than the server itself is.
// - What is kept says where the person signed in. A sign-in is renewed there and nowhere else, whatever the tool
//   server says later: a refresh token is never sent to an address a server has only just named.
// - Nothing an agent does can start a sign-in. An agent's call renews one that is about to run out, or is told
//   that a person has to sign in again.

const CLIENT = { name: 'the_organisation', version: '1.0.0' };
/** Said when a sign-in could not be renewed for reasons that are the service's own, and may pass. */
export const NOT_JUST_NOW = 'The sign-in to this tool server could not be renewed just now. Try again shortly.';
const REQUEST_MS = 20_000;
/** Starting a sign-in takes several requests, to two services. All of them together are not waited on for longer than this. */
const BEGIN_MS = 45_000;
const MAX_TOKEN_CHARS = 16_000;

/** A sign-in that has been started and waits for the person to come back from the service with a code. */
export interface PendingGrant extends Pick<ToolSignIn, 'issuer' | 'tokenEndpoint' | 'authMethods' | 'clientId' | 'clientSecret' | 'clientAuthMethod' | 'clientGiven' | 'resource' | 'scope'> {
  /** The secret half of the proof that whoever brings the code back is whoever was sent off. */
  codeVerifier: string;
  redirectUri: string;
}
/** What a completed or renewed sign-in gives. */
export interface Granted { accessToken: string; refreshToken: string; expiresAt: string | null; scope: string; }
export interface SignInOffer {
  /** Where the service sends the browser back to, and what it must bring back unchanged. */
  redirectUri: string; state: string;
  /** A client a person registered at the service, for a server that will not register this program by itself. */
  clientId: string; clientSecret: string;
  /** What to ask to be allowed. Empty to ask for what the server says it needs. */
  scope: string;
}

/** Everything the program does with an authorisation server. Tests point it at a local one. */
export interface ToolAuth {
  /** Find out where a server's sign-in is and make ready for it. Returns where to send the person's browser. */
  begin(serverUrl: string, offer: SignInOffer, signal: AbortSignal): Promise<{ authorizationUrl: string; grant: PendingGrant }>;
  /** Exchange the code the person came back with for a token. */
  finish(grant: PendingGrant, code: string, signal: AbortSignal): Promise<Granted>;
  /** Renew a sign-in where it was made. Throws SignInLapsed when it can no longer be renewed. */
  renew(signIn: ToolSignIn, signal: AbortSignal): Promise<Granted>;
}

/** The sign-in cannot be renewed: it was withdrawn at the service, or has run its course. Only a person can sign in again. */
export class SignInLapsed extends AccessError {
  constructor() { super('The sign-in to this tool server has lapsed. A person has to sign in again, under Email & accounts.', 403); }
}

const client = (from: Pick<ToolSignIn, 'clientId' | 'clientSecret' | 'clientAuthMethod'>): OAuthClientInformationMixed => ({
  client_id: from.clientId,
  ...(from.clientSecret ? { client_secret: from.clientSecret } : {}),
  ...(from.clientAuthMethod ? { token_endpoint_auth_method: from.clientAuthMethod } : {}),
});
/** As much of an authorisation server's description as asking it for a token takes: where, and how a client proves itself. */
const pinned = (from: Pick<ToolSignIn, 'issuer' | 'tokenEndpoint' | 'authMethods'>) => ({
  issuer: from.issuer, token_endpoint: from.tokenEndpoint, token_endpoint_auth_methods_supported: from.authMethods, authorization_endpoint: from.issuer, response_types_supported: ['code'],
}) as AuthorizationServerMetadata;

function granted(tokens: OAuthTokens, asked: string, before = ''): Granted {
  if (tokens.token_type.toLowerCase() !== 'bearer') throw new AccessError('The service gave a kind of token this cannot use.', 502);
  if (!tokens.access_token || tokens.access_token.length > MAX_TOKEN_CHARS || (tokens.refresh_token ?? '').length > MAX_TOKEN_CHARS || /\s/.test(tokens.access_token)) throw new AccessError('The service gave a token this cannot keep.', 502);
  const lasts = Number(tokens.expires_in);
  return {
    accessToken: tokens.access_token,
    // A service that does not send a new refresh token means the one in use to go on being used.
    refreshToken: tokens.refresh_token ?? before,
    expiresAt: Number.isFinite(lasts) && lasts > 0 ? new Date(Date.now() + lasts * 1000).toISOString() : null,
    scope: (tokens.scope ?? asked).slice(0, 1000),
  };
}

export class McpToolAuth implements ToolAuth {
  constructor(private readonly resolve?: Resolver) {}

  /** A fetch for one sign-in: every address it is asked for is held to the rule, every answer is cut to size, and none is waited on for long. */
  private fetcher(from: Reach | null, signal: AbortSignal): typeof fetch {
    return async (input, init) => {
      const address = input instanceof Request ? input.url : String(input);
      const url = from ? await signInURL(address, from, this.resolve) : toolServerURL(address);
      return capped(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_MS)]) });
    };
  }

  async begin(serverUrl: string, offer: SignInOffer, signal: AbortSignal): Promise<{ authorizationUrl: string; grant: PendingGrant }> {
    const server = toolServerURL(serverUrl);
    const from = await reachOf(server, this.resolve);
    const inTime = AbortSignal.timeout(BEGIN_MS);
    const fetchFn = this.fetcher(from, AbortSignal.any([signal, inTime]));
    const unreadable = new AccessError('This server does not say how to sign in to it, so it cannot be signed in to from here. It may want a token instead.', 502);
    try {
      // Asked without a token, a server that wants a sign-in says so, and may say where its sign-in is described and what to ask for.
      const asked = await fetchFn(server, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT } }),
      });
      const challenge = asked.status === 401 ? extractWWWAuthenticateParams(asked) : {};
      const session = asked.headers.get('mcp-session-id');
      await asked.body?.cancel().catch(() => {});
      if (asked.ok) {
        // It let the program in as it was. The session that opened is closed again, and the person is told there is nothing to sign in to.
        if (session) await fetchFn(server, { method: 'DELETE', headers: { 'mcp-session-id': session } }).then(answer => answer.body?.cancel(), () => {});
        throw new AccessError('This server does not ask for a sign-in. Connect it without one.', 409);
      }
      if (asked.status === 404 || asked.status === 405) throw new AccessError('There is no tool server at that address. Check the path: many answer at /mcp.', 404);

      // Where the server's sign-in is described has to be on the server itself: the description says who signs people in, and that is the server's to say.
      const described = challenge.resourceMetadataUrl?.origin === server.origin ? challenge.resourceMetadataUrl : undefined;
      let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
      try { resourceMetadata = await discoverOAuthProtectedResourceMetadata(server, { resourceMetadataUrl: described }, fetchFn); }
      catch (error) { if (error instanceof AccessError || signal.aborted) throw error; /* A server from before this was asked of them does not say. Its own address is then where its sign-in is. */ }
      const issuer = (await signInURL(resourceMetadata?.authorization_servers?.[0] ?? new URL('/', server), from, this.resolve)).href;
      const metadata = await discoverAuthorizationServerMetadata(issuer, { fetchFn });
      if (!metadata?.authorization_endpoint || !metadata.token_endpoint) throw unreadable;
      // The browser is sent to one of these and a code is posted to the other. Neither may be further in than the server.
      await signInURL(metadata.authorization_endpoint, from, this.resolve);
      const tokenEndpoint = (await signInURL(metadata.token_endpoint, from, this.resolve)).href;

      // A token is asked for this server and no other, so that it is of no use anywhere else. The server's own word for itself is sent as it wrote it.
      let resource = '';
      try {
        const selected = await selectResourceURL(server, {} as OAuthClientProvider, resourceMetadata);
        resource = selected && resourceMetadata ? resourceMetadata.resource : selected?.href ?? '';
      } catch { throw new AccessError('The server’s sign-in is for another address than the one given, so a sign-in there would not be for this server.', 502); }
      let scope = offer.scope || challenge.scope || resourceMetadata?.scopes_supported?.join(' ') || '';
      // Many services give a way to renew a sign-in only when it is asked for by name. Without one the sign-in lasts as long as its first token, an hour or so,
      // and the organisation is meant to work while nobody is there. A person who says what to ask for is taken at their word.
      if (scope && !offer.scope && metadata.scopes_supported?.includes('offline_access') && !scope.split(' ').includes('offline_access')) scope += ' offline_access';

      const authMethods = (metadata.token_endpoint_auth_methods_supported ?? []).filter(item => typeof item === 'string').slice(0, 20);
      let registered: OAuthClientInformationMixed;
      if (offer.clientId) registered = { client_id: offer.clientId, ...(offer.clientSecret ? { client_secret: offer.clientSecret } : {}) };
      else {
        if (!metadata.registration_endpoint) throw new AccessError('This service will not register a program by itself. Register this one at the service, with ' + offer.redirectUri + ' as its redirect address, and give the client id it issues.', 409);
        // A program with nothing to keep secret, where the service takes one: there is no client secret for anyone to take.
        const secretless = !authMethods.length || authMethods.includes('none');
        registered = await registerClient(issuer, {
          metadata, fetchFn, scope: scope || undefined,
          clientMetadata: { client_name: CLIENT.name, redirect_uris: [offer.redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: secretless ? 'none' : authMethods.includes('client_secret_basic') ? 'client_secret_basic' : 'client_secret_post' },
        });
      }
      const { authorizationUrl, codeVerifier } = await startAuthorization(issuer, { metadata, clientInformation: registered, redirectUrl: offer.redirectUri, scope: scope || undefined, state: offer.state, resource: resource || undefined });
      const method = 'token_endpoint_auth_method' in registered && typeof registered.token_endpoint_auth_method === 'string' ? registered.token_endpoint_auth_method : '';
      return {
        authorizationUrl: authorizationUrl.href,
        grant: { issuer, tokenEndpoint, authMethods, clientId: registered.client_id, clientSecret: registered.client_secret ?? '', clientAuthMethod: method, clientGiven: !!offer.clientId, resource, scope, codeVerifier, redirectUri: offer.redirectUri },
      };
    } catch (error) {
      if (error instanceof AccessError || signal.aborted) throw error;
      if (inTime.aborted) throw new AccessError('The server and its sign-in took too long to answer.', 504);
      if (error instanceof OAuthError) throw new AccessError('The service would not register this program (' + error.errorCode + '). Register it at the service yourself and give the client id it issues.', 502);
      // The protocol's client found the sign-in described, and not of the kind it carries out: a code for a token, with proof of who asked.
      if (error instanceof Error && error.message.startsWith('Incompatible auth server')) throw new AccessError('The service’s sign-in is of a kind that cannot be used from here.', 502);
      throw unreadable;
    }
  }

  async finish(grant: PendingGrant, code: string, signal: AbortSignal): Promise<Granted> {
    try {
      // To the address that was checked when the sign-in began, and to no other.
      return granted(await exchangeAuthorization(grant.issuer, { metadata: pinned(grant), clientInformation: client(grant), authorizationCode: code, codeVerifier: grant.codeVerifier, redirectUri: grant.redirectUri, resource: grant.resource || undefined, fetchFn: this.fetcher(null, signal) }), grant.scope);
    } catch (error) {
      if (error instanceof AccessError || signal.aborted) throw error;
      throw new AccessError(error instanceof OAuthError ? 'The service would not complete the sign-in (' + error.errorCode + '). Start it again.' : 'The service could not be reached to complete the sign-in. Start it again.', 502);
    }
  }

  async renew(signIn: ToolSignIn, signal: AbortSignal): Promise<Granted> {
    if (!signIn.refreshToken) throw new SignInLapsed();
    try {
      return granted(await refreshAuthorization(signIn.issuer, { metadata: pinned(signIn), clientInformation: client(signIn), refreshToken: signIn.refreshToken, resource: signIn.resource || undefined, fetchFn: this.fetcher(null, signal) }), signIn.scope, signIn.refreshToken);
    } catch (error) {
      if (error instanceof AccessError || signal.aborted) throw error;
      // The service has said no to the sign-in itself, which no amount of asking again will change.
      if (error instanceof OAuthError && ['invalid_grant', 'invalid_client', 'unauthorized_client', 'access_denied'].includes(error.errorCode)) throw new SignInLapsed();
      throw new AccessError(NOT_JUST_NOW, 502);
    }
  }
}
