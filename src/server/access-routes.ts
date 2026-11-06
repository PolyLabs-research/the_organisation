import express from 'express';
import type { Config } from './config';
import type { Registry } from './registry';
import { AccessError } from './access-vault';

/** Password controls inherit the API's origin check and additionally require a loopback-only server. */
export function accessRoutes(registry: Registry, config: Config): express.Router {
  const router = express.Router({ mergeParams: true });
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(config.host);
    const foreign = req.headers['sec-fetch-site'] === 'cross-site';
    if (!local || foreign) {
      if (req.method === 'GET' && req.path === '/' && !foreign) {
        res.json({ available: false, reason: 'Email and account access requires HOST=127.0.0.1 or another loopback address. This server has no user login.', initialised: false, unlocked: false, mailboxes: [], accounts: [], repositories: [], drafts: [], requests: [], audit: [] });
        return;
      }
      next(new AccessError('Email and account controls are available only on a loopback server from its own interface.', 403));
      return;
    }
    if (!registry.get(String(req.params.id))) { next(new AccessError('No such organisation.', 404)); return; }
    next();
  });
  const access = (req: express.Request) => registry.get(String(req.params.id))!.access;
  const kind = (req: express.Request): 'mailboxes' | 'accounts' | 'repositories' => {
    if (req.params.kind !== 'mailboxes' && req.params.kind !== 'accounts' && req.params.kind !== 'repositories') throw new AccessError('No such connection type.', 404);
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
