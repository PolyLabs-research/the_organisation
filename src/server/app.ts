import express, { type NextFunction, type Request, type Response } from 'express';
import { MAX_AGENTS_PER_LEAD, MAX_LEADS, PROFILES } from '../shared/profiles';
import type { CreateOrgRequest } from '../shared/types';
import type { Config } from './config';
import type { OrgRunner } from './engine/runner';
import { DEFAULT_SETTINGS, ValidationError, planById } from './engine/state';
import { ProviderError } from './providers/types';
import { recommendTeam } from './recommend';
import type { Registry } from './registry';
import { WorkspaceError } from './workspace';

class NotFound extends Error {}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function hostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  // Strip the port, leaving bracketed IPv6 addresses intact.
  return hostHeader.replace(/:\d+$/, '').toLowerCase();
}

export function createApp(registry: Registry, config: Config): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // The API has no login: it trusts whoever can reach it. These two checks
  // keep web pages out. A page on another site cannot drive the API by making
  // the browser post to it, and (when bound to loopback) cannot read it by
  // pointing a hostname of its own at 127.0.0.1.
  app.use('/api', (req, res, next) => {
    const host = hostname(req.headers.host);
    if (LOOPBACK.has(config.host) && !LOOPBACK.has(host)) {
      res.status(403).json({ error: 'This server only answers requests addressed to localhost.' });
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

  app.get('/api/meta', (_req, res) => {
    res.json({
      provider: registry.provider.info(),
      providerReason: config.providerReason,
      profiles: PROFILES,
      defaults: DEFAULT_SETTINGS,
      limits: { maxAgentsPerLead: MAX_AGENTS_PER_LEAD, maxLeads: MAX_LEADS },
    });
  });

  app.post('/api/recommend', async (req, res) => {
    const idea = text(req.body?.idea).trim();
    if (idea.length < 10) throw new ValidationError('Describe the idea in a sentence or two first.');
    res.json(await recommendTeam(registry.provider, idea.slice(0, 6000), DEFAULT_SETTINGS.executiveModel, DEFAULT_SETTINGS.executiveEffort));
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

  app.get('/api/orgs/:id/activity', (req, res) => {
    res.json(runnerOf(req).activity);
  });

  app.get('/api/orgs/:id/tasks/:taskId', (req, res) => {
    const runner = runnerOf(req);
    for (const plan of runner.org.plans) {
      for (const phase of plan.phases) {
        const task = phase.tasks.find((t) => t.id === req.params.taskId);
        if (task) {
          res.json({ task, planId: planById(runner.org, plan.id)?.id, phase: phase.name });
          return;
        }
      }
    }
    throw new NotFound('No such task.');
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
    if (err instanceof NotFound) res.status(404).json({ error: message });
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
