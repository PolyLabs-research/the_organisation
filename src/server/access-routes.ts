import { randomBytes } from 'node:crypto';
import express from 'express';
import type { Config } from './config';
import type { Registry } from './registry';
import type { ToolSignInUnderWay } from './access';
import { AccessError } from './access-vault';

const LOCAL = ['127.0.0.1', 'localhost', '::1', '[::1]'];
/** Where a service sends the person's browser back to when they have signed in to a tool server. */
export const SIGN_IN_CALLBACK = '/api/oauth/tools/callback';
const SIGN_IN_COOKIE = 'org_tool_sign_in';
const SIGN_IN_MINUTES = 10;
interface SignInFlow { orgId: string; underWay: ToolSignInUnderWay; cookie: string; redirect: string; expires: number; epoch: number; }

/**
 * Sign-ins to tool servers that are under way. One is started from the dashboard, which is then sent to the
 * service. It is finished when the service sends the browser back with a code, and only if it is the browser that
 * started it, within ten minutes, with the vault still open as it was: the state in the address says which sign-in,
 * and a cookie says which browser.
 */
export function toolSignIns(registry: Registry, config: Config) {
  const flows = new Map<string, SignInFlow>();
  /** How the last sign-in for an organisation ended, for the page the browser lands on to say. Read once. */
  const outcomes = new Map<string, { ok: boolean; message: string }>();
  const cookieOf = (req: express.Request) => new RegExp('(?:^|;\\s*)' + SIGN_IN_COOKIE + '=([a-f0-9]{64})(?:;|$)').exec(req.headers.cookie ?? '')?.[1];

  const start: express.RequestHandler = async (req, res) => {
    const orgId = String(req.params.id), access = registry.get(orgId)!.access;
    access.requireUnlocked();
    for (const [state, flow] of flows) if (flow.expires < Date.now()) flows.delete(state);
    if (flows.size >= 50) throw new AccessError('Too many sign-ins are waiting to be finished. Try again in ten minutes.', 429);
    const state = randomBytes(32).toString('hex'), cookie = randomBytes(32).toString('hex');
    const redirect = req.protocol + '://' + req.headers.host + SIGN_IN_CALLBACK;
    const begun = await access.beginToolSignIn(req.body, req.params.targetId ? String(req.params.targetId) : null, redirect, state);
    flows.set(state, { orgId, underWay: begun.underWay, cookie, redirect, expires: Date.now() + SIGN_IN_MINUTES * 60_000, epoch: access.vault.epoch });
    outcomes.delete(orgId);
    res.cookie(SIGN_IN_COOKIE, cookie, { httpOnly: true, sameSite: 'lax', secure: req.secure, path: SIGN_IN_CALLBACK, maxAge: SIGN_IN_MINUTES * 60_000 });
    res.json({ url: begun.url });
  };

  const outcome: express.RequestHandler = (req, res) => {
    const orgId = String(req.params.id), last = outcomes.get(orgId) ?? null;
    outcomes.delete(orgId);
    res.json({ outcome: last });
  };

  const callback: express.RequestHandler = async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const flow = flows.get(state);
    if (!LOCAL.includes(config.host) || !flow || flow.expires < Date.now() || flow.cookie !== cookieOf(req) || new URL(flow.redirect).host !== req.headers.host) throw new AccessError('This sign-in has expired, or was not started in this browser. Start it again under Tool servers.', 400);
    // A sign-in is finished once, whatever comes of it.
    flows.delete(state);
    res.clearCookie(SIGN_IN_COOKIE, { path: SIGN_IN_CALLBACK });
    const done = (ok: boolean, message: string) => { outcomes.set(flow.orgId, { ok, message }); res.redirect(303, '/?access=tools#/org/' + flow.orgId); };
    const access = registry.get(flow.orgId)?.access;
    if (!access?.vault.unlocked || flow.epoch !== access.vault.epoch) { done(false, 'The vault was locked during the sign-in. Unlock it and sign in again.'); return; }
    if (req.query.error || typeof req.query.code !== 'string' || !req.query.code || req.query.code.length > 4096) { done(false, 'The sign-in was cancelled or refused at the service. Nothing was connected.'); return; }
    try {
      await access.finishToolSignIn(flow.underWay, req.query.code, flow.epoch);
      done(true, flow.underWay.targetId ? 'Signed in to ' + flow.underWay.label + ' again.' : flow.underWay.label + ' is connected. None of its tools is allowed yet.');
    } catch (error) {
      done(false, error instanceof AccessError ? error.message : 'The sign-in could not be completed. Start it again.');
    }
  };
  return { start, outcome, callback };
}

/** Password controls inherit the API's origin check and additionally require a loopback-only server. */
export function accessRoutes(registry: Registry, config: Config, signIns: ReturnType<typeof toolSignIns> = toolSignIns(registry, config)): express.Router {
  const router = express.Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const local = LOCAL.includes(config.host);
    const foreign = req.headers['sec-fetch-site'] === 'cross-site';
    if (!local || foreign) {
      if (req.method === 'GET' && req.path === '/' && !foreign) {
        res.json({ available: false, reason: 'Email and account access requires HOST=127.0.0.1 or another loopback address. This server has no user login.', initialised: false, unlocked: false, mailboxes: [], accounts: [], repositories: [], toolServers: [], drafts: [], requests: [], audit: [] });
        return;
      }
      next(new AccessError('Email and account controls are available only on a loopback server from its own interface.', 403));
      return;
    }
    if (!registry.get(String(req.params.id))) { next(new AccessError('No such organisation.', 404)); return; }
    next();
  });
  const access = (req: express.Request) => registry.get(String(req.params.id))!.access;
  const kind = (req: express.Request): 'mailboxes' | 'accounts' | 'repositories' | 'toolServers' => {
    if (req.params.kind !== 'mailboxes' && req.params.kind !== 'accounts' && req.params.kind !== 'repositories' && req.params.kind !== 'toolServers') throw new AccessError('No such connection type.', 404);
    return req.params.kind;
  };
  router.get('/', async (req, res) => { res.json(await access(req).view()); });
  router.post('/create', async (req, res) => { await access(req).unlock(req.body?.passphrase, true, req.body?.keepUnlocked ?? false); res.status(201).json(await access(req).view()); });
  router.post('/unlock', async (req, res) => { await access(req).unlock(req.body?.passphrase, false, req.body?.keepUnlocked ?? false); res.json(await access(req).view()); });
  router.post('/lock', async (req, res) => { await access(req).lock(); res.json(await access(req).view()); });
  router.get('/backup', async (req, res) => {
    res.attachment('business-vault-' + String((req as express.Request).params.id) + '.json');
    res.send(await access(req).vault.backup());
  });
  router.post('/mailboxes', async (req, res) => { await access(req).addMailbox(req.body); res.status(201).json(await access(req).view()); });
  router.post('/accounts', async (req, res) => { await access(req).addAccount(req.body); res.status(201).json(await access(req).view()); });
  router.post('/repositories', async (req, res) => { await access(req).addRepository(req.body); res.status(201).json(await access(req).view()); });
  router.post('/toolServers', async (req, res) => { await access(req).addToolServer(req.body); res.status(201).json(await access(req).view()); });
  router.post('/toolServers/signin', signIns.start);
  router.get('/toolServers/signin', signIns.outcome);
  router.post('/toolServers/:targetId/signin', signIns.start);
  router.post('/toolServers/:targetId/tools/read', async (req, res) => { await access(req).readTools(String(req.params.targetId)); res.json(await access(req).view()); });
  router.patch('/toolServers/:targetId/tools', async (req, res) => { await access(req).allowTools(String(req.params.targetId), req.body); res.json(await access(req).view()); });
  router.patch('/repositories/:targetId/workflows', async (req, res) => { await access(req).setWorkflows(String(req.params.targetId), req.body); res.json(await access(req).view()); });
  router.patch('/:kind/:targetId', async (req, res) => { await access(req).grant(kind(req), String(req.params.targetId), req.body); res.json(await access(req).view()); });
  router.delete('/:kind/:targetId', async (req, res) => { await access(req).remove(kind(req), String(req.params.targetId)); res.json(await access(req).view()); });
  router.post('/:kind/:targetId/password', async (req, res) => { await access(req).password(kind(req), String(req.params.targetId), req.body?.password); res.json(await access(req).view()); });
  router.post('/accounts/:targetId/reveal', async (req, res) => { res.json({ password: await access(req).reveal(String(req.params.targetId)) }); });
  router.get('/mailboxes/:targetId/messages', async (req, res) => { res.json(await access(req).listMail(String(req.params.targetId), 'person')); });
  router.get('/mailboxes/:targetId/messages/:messageId', async (req, res) => { res.json(await access(req).readMail(String(req.params.targetId), String(req.params.messageId), 'person')); });
  router.post('/drafts', async (req, res) => { await access(req).draft(req.body, 'person'); res.status(201).json(await access(req).view()); });
  router.post('/drafts/:draftId/send', async (req, res) => { await access(req).sendDraft(String(req.params.draftId)); res.json(await access(req).view()); });
  router.post('/drafts/:draftId/remove', async (req, res) => { await access(req).deleteDraft(String(req.params.draftId)); res.json(await access(req).view()); });
  router.post('/requests/:requestId/resolve', async (req, res) => { await access(req).resolveRequest(String(req.params.requestId)); res.json(await access(req).view()); });
  router.post('/browser', async (req, res) => { res.json(await access(req).browse(req.body, 'person', 'person')); });
  return router;
}
