import { createOnlyPaperclips } from './only-paperclips';
import { accessRoutes } from './access-routes';
import { AccessError } from './access-vault';
import { googleRoutes } from './access-google';
import { operatingDigest } from '../shared/business';
import { isIP } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { MAX_AGENTS_PER_LEAD, MAX_LEADS, PROFILES } from '../shared/profiles';
import type { CreateOrgRequest } from '../shared/types';
import type { Config } from './config';
import type { OrgRunner } from './engine/runner';
import { DEFAULT_SETTINGS, ValidationError } from './engine/state';
import { PRICES_CHECKED } from './providers/catalogue';
import { ProviderError } from './providers/types';
import { recommendTeam } from './recommend';
import type { ProviderRouter } from './providers/router';
import type { Registry } from './registry';
import { WorkspaceError } from './workspace';

class NotFound extends Error {}

/** Loopback as it appears in a Host header, and as HOST may be configured. */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
const LOOPBACK_BINDINGS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  // Strip the port, leaving bracketed IPv6 addresses intact.
  return hostHeader.replace(/:\d+$/, '').toLowerCase();
}

export function createApp(registry: Registry, config: Config, router?: ProviderRouter): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // The interface can reveal a saved password and send email with one click. No other page may frame it and steer that click.
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    next();
  });

  // The API has no login: it trusts whoever can reach it. These two checks
  // keep web pages out. A page on another site cannot drive the API by making
  // the browser post to it, and cannot read it by pointing a hostname of its
  // own at this machine, whichever address the server listens on.
  const loopbackOnly = LOOPBACK_BINDINGS.has(config.host);
  const named = new Set([config.host, ...(config.allowedHosts ?? [])].map((name) => name.toLowerCase()));
  /** Whether a request addressed to `host` is one this server answers. */
  const answersTo = (host: string): boolean => {
    if (LOOPBACK.has(host)) return true;
    // Listening on loopback only, nothing else is an honest address for it.
    if (loopbackOnly) return false;
    // Listening beyond loopback, it is reached by address, or by a name it has been told is its own. An address
    // cannot be pointed anywhere else. A name can: that is how a page reaches a server it has no business with.
    return isIP(host.replace(/^\[|\]$/g, '')) !== 0 || named.has(host);
  };

  app.use('/api', (req, res, next) => {
    const host = hostname(req.headers.host);
    if (!answersTo(host)) {
      res.status(403).json({
        error: loopbackOnly
          ? 'This server only answers requests addressed to localhost.'
          : `This server does not answer to the name "${host.slice(0, 100)}". If that name is this machine's, add it to ORG_ALLOWED_HOSTS.`,
      });
      return;
    }
    const origin = req.headers.origin;
    if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
      let originHost = '';
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {
        // an unparseable Origin is treated as foreign
      }
      if (originHost !== (req.headers.host ?? '').toLowerCase()) {
        res.status(403).json({ error: 'Cross-site requests are not accepted.' });
        return;
      }
    }
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  const runnerOf = (req: Request): OrgRunner => {
    const runner = registry.get(String(req.params.id));
    if (!runner) throw new NotFound('No such organisation.');
    return runner;
  };
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');

  /** The model a new organisation starts on: the provider's pick from the keys connected, or the built-in default. */
  const defaultModel = () => registry.provider.defaultModel?.() ?? DEFAULT_SETTINGS.executiveModel;

  app.get('/api/meta', (_req, res) => {
    const model = defaultModel();
    res.json({
      provider: registry.provider.info(),
      providerReason: config.providerReason,
      profiles: PROFILES,
      defaults: { ...DEFAULT_SETTINGS, executiveModel: model, workerModel: model },
      limits: { maxAgentsPerLead: MAX_AGENTS_PER_LEAD, maxLeads: MAX_LEADS },
      // Whether keys can be added from the interface: not when the server was told to simulate regardless.
      keys: router ? { presets: router.presets(), forcedSimulation: config.provider === 'mock', pricesChecked: PRICES_CHECKED } : null,
    });
  });

  app.post('/api/recommend', async (req, res) => {
    const idea = text(req.body?.idea).trim();
    if (idea.length < 10) throw new ValidationError('Describe the idea in a sentence or two first.');
    // The recommendation is made by the model new organisations start on, unless the request names another.
    const model = text(req.body?.model).trim() || defaultModel();
    if (registry.provider.knows && !registry.provider.knows(model)) {
      throw new ValidationError(`The model "${model}" is not one a connected key can call. Add its key under Models and keys, or name another model.`);
    }
    res.json(await recommendTeam(registry.provider, idea.slice(0, 6000), model, DEFAULT_SETTINGS.executiveEffort));
  });

  // ---- API keys ----
  // A key is taken in here and never given out again: what goes back is which provider it is for, the
  // last few characters, and what it can call.

  const keys = (): ProviderRouter => {
    if (!router) throw new NotFound('This server does not manage API keys.');
    return router;
  };
  const connectionsView = () => ({ connections: keys().info().connections ?? [], provider: registry.provider.info() });

  app.get('/api/connections', (_req, res) => {
    res.json(connectionsView());
  });

  app.post('/api/connections', async (req, res) => {
    const body = req.body ?? {};
    await keys().connect({ presetId: text(body.presetId), apiKey: text(body.apiKey), region: text(body.region) || undefined, baseURL: text(body.baseURL) || undefined, label: text(body.label) || undefined });
    res.status(201).json(connectionsView());
  });

  app.post('/api/connections/:connectionId/refresh', async (req, res) => {
    await keys().refresh(String(req.params.connectionId));
    res.json(connectionsView());
  });

  app.patch('/api/connections/:connectionId', async (req, res) => {
    const body = req.body ?? {};
    const id = String(req.params.connectionId);
    // A connection's address is fixed when it is made. Changing it here would send the key held for the old
    // address to the new one, which nobody who cannot already read the key should be able to bring about.
    if (body.baseURL !== undefined) throw new ValidationError('The address of a connection cannot be changed. Remove it and add the key again at the new address.');
    if (body.label !== undefined || body.apiKey !== undefined) {
      await keys().update(id, {
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(typeof body.apiKey === 'string' ? { apiKey: body.apiKey } : {}),
      });
    }
    if (typeof body.addModel === 'string') await keys().addModel(id, body.addModel);
    if (body.price && typeof body.price === 'object' && typeof body.price.model === 'string') {
      const { model, input, output } = body.price as { model: string; input?: unknown; output?: unknown };
      await keys().setPrice(id, model, input === null || input === undefined ? null : { input: Number(input), output: Number(output) });
    }
    res.json(connectionsView());
  });

  app.delete('/api/connections/:connectionId', async (req, res) => {
    await keys().disconnect(String(req.params.connectionId));
    res.json(connectionsView());
  });

  app.post('/api/examples/only-paperclips', async (_req, res) => {
    const runner = await createOnlyPaperclips(registry);
    res.status(201).json(runner.view());
  });

  app.get('/api/orgs', (_req, res) => {
    res.json(registry.list());
  });

  app.post('/api/orgs', async (req, res) => {
    const body = (req.body ?? {}) as CreateOrgRequest;
    const runner = await registry.create({
      name: text(body.name),
      idea: text(body.idea),
      mission: text(body.mission),
      executives: Array.isArray(body.executives) ? body.executives : [],
      settings: body.settings && typeof body.settings === 'object' ? body.settings : undefined,
      steer: text(body.steer),
    });
    res.status(201).json(runner.view());
  });

  app.get('/api/orgs/:id', (req, res) => {
    res.json(runnerOf(req).view());
  });

  app.delete('/api/orgs/:id', async (req, res) => {
    if (!(await registry.remove(String(req.params.id)))) throw new NotFound('No such organisation.');
    res.status(204).end();
  });

  app.post('/api/orgs/:id/start', (req, res) => {
    const runner = runnerOf(req);
    runner.start();
    res.json(runner.view());
  });

  app.post('/api/orgs/:id/pause', (req, res) => {
    const runner = runnerOf(req);
    runner.pause();
    res.json(runner.view());
  });

  app.post('/api/orgs/:id/step', (req, res) => {
    const runner = runnerOf(req);
    runner.step();
    res.json(runner.view());
  });

  app.post('/api/orgs/:id/stop', (req, res) => {
    const runner = runnerOf(req);
    runner.stop();
    res.json(runner.view());
  });

  app.post('/api/orgs/:id/steer', (req, res) => {
    const runner = runnerOf(req);
    runner.steer(text(req.body?.text));
    res.json(runner.view());
  });

  app.patch('/api/orgs/:id/settings', (req, res) => {
    const runner = runnerOf(req);
    if (!req.body || typeof req.body !== 'object') throw new ValidationError('Send the settings to change as a JSON object.');
    runner.updateSettings(req.body);
    res.json(runner.view());
  });

  app.patch('/api/orgs/:id/executives/:execId', (req, res) => {
    const runner = runnerOf(req);
    runner.setAgentCount(String(req.params.execId), Number(req.body?.agentCount));
    res.json(runner.view());
  });

  // What each role may do. Only this route changes it, and no seat or agent has a way to call it.
  app.patch('/api/orgs/:id/privileges', async (req, res) => {
    const runner = runnerOf(req);
    await runner.setPrivilege(req.body?.seatId, req.body?.privilege, req.body?.allowed);
    res.json(runner.view());
  });

  // Which work approaches a role may use.
  app.patch('/api/orgs/:id/work-approaches', (req, res) => {
    const runner = runnerOf(req);
    runner.setWorkApproach(req.body?.seatId, req.body?.approachId, req.body?.allowed);
    res.json(runner.view());
  });

  // The signatory's desk: the person answers a request (it is done, or it is refused and why), takes an answer
  // back, or leaves the organisation a message.
  app.post('/api/orgs/:id/requests/:requestId', (req, res) => {
    const runner = runnerOf(req);
    const requestId = String(req.params.requestId);
    const action = text(req.body?.action);
    if (action === 'done' || action === 'rejected') runner.settleRequest(requestId, action, text(req.body?.note));
    else if (action === 'reopen') runner.reopenRequest(requestId);
    else throw new ValidationError('Say what became of the request: "done", "rejected" or "reopen".');
    res.json(runner.view());
  });

  app.post('/api/orgs/:id/signatory/notes', (req, res) => {
    const runner = runnerOf(req);
    runner.noteFromSignatory(text(req.body?.text));
    res.json(runner.view());
  });

  app.post('/api/orgs/:id/business', async (req, res) => {
    const runner = runnerOf(req);
    await runner.businessCommand(req.body);
    res.json(runner.view());
  });
  app.get('/api/orgs/:id/business', (req, res) => {
    const runner = runnerOf(req);
    res.json({ ...runner.org.business, digest: operatingDigest(runner.org) });
  });
  app.post('/api/orgs/:id/review-now', async (req, res) => {
    const runner = runnerOf(req);
    runner.reviewNow();
    await runner.flush();
    res.json(runner.view());
  });

  googleRoutes(app, registry, config);
  app.use('/api/orgs/:id/access', accessRoutes(registry, config));

  app.get('/api/orgs/:id/activity', (req, res) => {
    res.json(runnerOf(req).activity);
  });

  app.get('/api/orgs/:id/activity/history', async (req, res) => {
    res.json(await runnerOf(req).history());
  });

  app.get('/api/orgs/:id/tasks/:taskId', async (req, res) => {
    const detail = await runnerOf(req).taskDetail(String(req.params.taskId));
    if (!detail) throw new NotFound('No such task.');
    res.json(detail);
  });

  // Archiving is asked for by hand here, for one plan's session or for every plan that is over.
  app.post('/api/orgs/:id/plans/:planId/archive-session', async (req, res) => {
    const runner = runnerOf(req);
    const plan = runner.org.plans.find((p) => p.id === req.params.planId);
    if (!plan) throw new NotFound('No such plan.');
    if (!plan.managed) throw new ValidationError('This plan was not carried out in a hosted session.');
    if (!['done', 'cancelled', 'failed'].includes(plan.status) && !(plan.managed.past ?? []).some((p) => !p.archivedAt)) {
      throw new ValidationError('This plan is still under way. Its session can be archived once the plan has reported or been cancelled.');
    }
    const result = await runner.archiveSessions({ planId: plan.id });
    res.json({ ...result, view: runner.view() });
  });

  app.post('/api/orgs/:id/archive-sessions', async (req, res) => {
    const runner = runnerOf(req);
    const result = await runner.archiveSessions();
    res.json({ ...result, view: runner.view() });
  });

  app.get('/api/orgs/:id/files', async (req, res) => {
    res.json(await runnerOf(req).workspace.list());
  });

  app.get('/api/orgs/:id/file', async (req, res) => {
    res.json(await runnerOf(req).workspace.read(text(req.query.path)));
  });

  // Live updates for an open dashboard, as server-sent events.
  app.get('/api/orgs/:id/events', (req, res) => {
    const runner = runnerOf(req);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send('view', runner.view());
    const unsubscribe = runner.subscribe((event) => {
      if (event.type === 'view') send('view', event.view);
      else if (event.type === 'activity') send('activity', event.entry);
      else res.end(); // the organisation was deleted or the server is shutting down
    });
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.use('/api', (_req, _res, next) => next(new NotFound('No such endpoint.')));

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof AccessError) res.status(err.status).json({ error: message });
    else if (err instanceof NotFound) res.status(404).json({ error: message });
    else if (err instanceof ValidationError || err instanceof WorkspaceError) res.status(400).json({ error: message });
    else if (err instanceof ProviderError) res.status(502).json({ error: message, code: err.code });
    else if ((err as { type?: string }).type === 'entity.parse.failed') res.status(400).json({ error: 'The request body is not valid JSON.' });
    else {
      console.error(err);
      res.status(500).json({ error: 'Something went wrong on the server.' });
    }
  });

  return app;
}
