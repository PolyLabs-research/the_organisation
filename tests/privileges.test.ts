import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app';
import { BusinessAccess } from '../src/server/access';
import { accessTools } from '../src/server/access-tools';
import type { AccountBrowser } from '../src/server/access-browser';
import type { MailTransport } from '../src/server/access-mail';
import type { Config } from '../src/server/config';
import { applyBusinessUpdates, businessTools } from '../src/server/engine/business';
import { changePrivilege } from '../src/server/engine/privileges';
import { sessionSystem, systemFor, systemForAgent } from '../src/server/engine/prompts';
import { raiseRequests } from '../src/server/engine/signatory';
import { ValidationError, normaliseLoaded } from '../src/server/engine/state';
import { MockProvider } from '../src/server/providers/mock';
import type { PlanJob, PlanOutcome } from '../src/server/providers/types';
import { PRIVILEGES, allows, rolesOf, type Privilege } from '../src/shared/privileges';
import type { OrgView } from '../src/shared/types';
import { QUIET, harness, runToRest, waitFor, type Harness } from './helpers';

// What a role may do, set by a person. Telling an agent is not what stops it, so these go to each place the thing is
// actually done: the tools it is offered, the access service behind them, and the records and requests it can file.

let h: Harness | undefined;
afterEach(async () => { await h?.cleanup(); h = undefined; vi.restoreAllMocks(); });

const leadOf = (run: Harness) => run.org.executives.find((seat) => seat.kind === 'lead')!;
const ceoOf = (run: Harness) => run.org.executives.find((seat) => seat.kind === 'ceo')!;

describe('what a role may do', () => {
  it('starts with reading and asking allowed, and with anything an agent would do unchecked switched off', async () => {
    h = await harness();
    const lead = leadOf(h);
    const on = PRIVILEGES.filter((p) => allows(h!.org, lead.id, p.id)).map((p) => p.id);
    expect(on).toEqual(['web_search', 'update_records', 'ask_signatory', 'read_mail', 'draft_mail', 'sign_in', 'read_code']);
    expect(allows(h.org, lead.id, 'act')).toBe(false);
    expect(allows(h.org, lead.id, 'create_accounts')).toBe(false);
    expect(h.org.privileges).toEqual({});
  });

  it('shows the CEO and the leads, and not the seats with no tools to limit', async () => {
    h = await harness({ executives: [{ profileId: 'engineering' }], settings: {} });
    const kinds = new Set(rolesOf(h.org).map((seat) => seat.kind));
    expect(kinds).toEqual(new Set(['ceo', 'lead']));
    expect(h.org.executives.some((seat) => !kinds.has(seat.kind))).toBe(true);
  });

  it('brings in what a privilege needs, and takes away what depends on one', async () => {
    h = await harness();
    const lead = leadOf(h), org = h.org;
    changePrivilege(org, lead.id, 'sign_in', false);
    changePrivilege(org, lead.id, 'act', true);
    expect(allows(org, lead.id, 'sign_in')).toBe(true);
    changePrivilege(org, lead.id, 'create_accounts', true);
    expect(changePrivilege(org, lead.id, 'sign_in', false)).toEqual({ changed: true, removed: true });
    expect(allows(org, lead.id, 'act')).toBe(false);
    expect(allows(org, lead.id, 'create_accounts')).toBe(false);
  });

  it('follows that all the way along a chain', async () => {
    h = await harness();
    const lead = leadOf(h), org = h.org;
    changePrivilege(org, lead.id, 'read_code', false);
    changePrivilege(org, lead.id, 'edit_pipelines', true);
    expect(allows(org, lead.id, 'push_code')).toBe(true);
    expect(allows(org, lead.id, 'read_code')).toBe(true);
    changePrivilege(org, lead.id, 'read_code', false);
    expect(allows(org, lead.id, 'push_code')).toBe(false);
    expect(allows(org, lead.id, 'edit_pipelines')).toBe(false);
    expect(allows(org, lead.id, 'run_workflows')).toBe(false);
  });

  it('tells the board what changed, and says nothing when nothing did', async () => {
    h = await harness();
    const lead = leadOf(h), org = h.org, before = org.board.length;
    expect(changePrivilege(org, lead.id, 'sign_in', true)).toEqual({ changed: false, removed: false });
    expect(org.board).toHaveLength(before);
    expect(org.privileges).toEqual({});
    expect(changePrivilege(org, lead.id, 'act', true)).toEqual({ changed: true, removed: false });
    expect(org.board.at(-1)).toMatchObject({ title: `What the ${lead.short} may do has changed`, body: expect.stringContaining('Act on accounts: now allowed') });
  });

  it('refuses a seat, a privilege or an answer that is not one', async () => {
    h = await harness();
    const lead = leadOf(h), ceo = ceoOf(h), org = h.org;
    expect(() => changePrivilege(org, 'nobody', 'act', true)).toThrow(ValidationError);
    expect(() => changePrivilege(org, lead.id, 'launch_missiles', true)).toThrow(ValidationError);
    expect(() => changePrivilege(org, lead.id, 'toString', true)).toThrow(ValidationError);
    expect(() => changePrivilege(org, lead.id, 'act', 'yes')).toThrow(ValidationError);
    expect(() => changePrivilege(org, ceo.id, 'act', true)).toThrow(/no agents/);
    expect(changePrivilege(org, ceo.id, 'update_records', false).changed).toBe(true);
  });

  it('loads an organisation saved before there were privileges, at the defaults', async () => {
    h = await harness();
    const saved = JSON.parse(JSON.stringify(h.org));
    delete saved.privileges;
    const loaded = normaliseLoaded(saved);
    expect(loaded.privileges).toEqual({});
    expect(allows(loaded, leadOf(h).id, 'act')).toBe(false);
  });
});

describe('an agent told its limits', () => {
  it('hears them in its own prompt, and a hosted session hears only those that apply there', async () => {
    h = await harness();
    const lead = leadOf(h), org = h.org;
    changePrivilege(org, lead.id, 'update_records', false);
    changePrivilege(org, lead.id, 'read_mail', false);
    expect(systemFor(org, lead).role).toContain('you may not change business records');
    expect(systemFor(org, lead).role).toContain('read business email');
    expect(systemForAgent(org, lead).role).toContain('you may not change business records');
    expect(sessionSystem(org, lead)).toContain('you may not change business records');
    expect(sessionSystem(org, lead)).not.toContain('read business email');
  });

  it('is not told about what its role was never given, since it is not offered that', async () => {
    h = await harness();
    expect(systemForAgent(h.org, leadOf(h)).role).not.toContain('Limits on your role');
    changePrivilege(h.org, leadOf(h).id, 'push_code', true);
    changePrivilege(h.org, leadOf(h).id, 'push_code', false);
    expect(systemForAgent(h.org, leadOf(h)).role).toContain('you may not push code');
  });
});

describe('the business records', () => {
  const memory = (ownerId: string) => ({ kind: 'memory', record: { ownerId, title: 'A lesson', category: 'lesson', content: 'Keep this in shared knowledge.', source: 'test' } });

  it('are refused to a role without the privilege, on the board where a person can see it', async () => {
    h = await harness();
    const lead = leadOf(h), org = h.org;
    changePrivilege(org, lead.id, 'update_records', false);
    applyBusinessUpdates(org, [memory(lead.id)], { id: lead.id });
    expect(org.business.memory).toHaveLength(0);
    expect(org.board.at(-1)?.title).toBe('Operating update refused');
  });

  it('are not offered to an agent without it, and an offered tool stops when the privilege goes', async () => {
    h = await harness();
    const lead = leadOf(h), org = h.org;
    const tools = businessTools(org, { id: lead.id, worker: true }, () => {}, () => true);
    const update = tools.find((tool) => tool.name === 'update_business')!;
    changePrivilege(org, lead.id, 'update_records', false);
    expect(businessTools(org, { id: lead.id, worker: true }, () => {}, () => true).map((tool) => tool.name)).toEqual(['read_business']);
    await expect(update.run({ operations: [memory(lead.id)] })).rejects.toThrow(/no longer authorised/);
    expect(org.business.memory).toHaveLength(0);
  });
});

describe('the signatory', () => {
  it('hears nothing from a role without the privilege, and the board hears what was refused', async () => {
    h = await harness();
    const lead = leadOf(h), org = h.org;
    changePrivilege(org, lead.id, 'ask_signatory', false);
    const plan = { id: 'plan_x', ownerId: lead.id, cycle: 1, title: 'A plan' } as never;
    expect(raiseRequests(org, lead, plan, 'Build', [{ kind: 'payment', title: 'Pay the supplier', reason: 'Needed', amount: '£10', party: 'Supplier' } as never])).toEqual([]);
    expect(org.signatory.requests).toHaveLength(0);
    expect(org.board.at(-1)).toMatchObject({ title: `${lead.short} may not ask the signatory`, body: expect.stringContaining('Pay the supplier') });
  });
});

describe('a hosted session', () => {
  class Scripted extends MockProvider {
    jobs: PlanJob[] = [];
    results: unknown[] = [];
    constructor() { super(QUIET); }
    override async executePlan(job: PlanJob): Promise<PlanOutcome> {
      this.jobs.push(job);
      job.hooks.session({ id: 'privileges-session', consoleUrl: null, budgetUsd: job.budgetUsd });
      const phases = job.context.phases as Array<{ name: string }>;
      this.results.push(job.hooks.phase({
        phase: phases[0]!.name, summary: 'Reviewed.', decisions: [],
        operations: [{ kind: 'memory', record: { ownerId: 'cto', title: 'Hosted lesson', category: 'lesson', content: 'Kept.', source: 'Hosted' } }],
        requests: [{ kind: 'payment', title: 'Pay the host', reason: 'Needed', amount: '£10', party: 'Host' }],
      } as never));
      for (const phase of phases.slice(1)) job.hooks.phase({ phase: phase.name, summary: 'Checked.', decisions: [] });
      job.hooks.report({ headline: 'Delivered', summary: 'Done.', outcomes: [], asks: [] });
      return { status: 'reported' };
    }
  }

  it('loses the web, the records and the signatory with the role, and is told so', async () => {
    const provider = new Scripted();
    h = await harness({ provider, settings: { execution: 'managed', webResearch: true }, executives: [{ profileId: 'engineering' }] });
    for (const privilege of ['web_search', 'update_records', 'ask_signatory'] as const) changePrivilege(h.org, 'cto', privilege, false);
    await runToRest(h.runner);
    expect(provider.jobs[0]!.web).toBe(false);
    expect(h.org.business.memory).toHaveLength(0);
    expect(h.org.signatory.requests).toHaveLength(0);
    const reply = JSON.stringify(provider.results[0]);
    expect(reply).toContain('may not change business records');
    expect(reply).toContain('may not ask the signatory');
  });

  it('keeps them while the role has them', async () => {
    const provider = new Scripted();
    h = await harness({ provider, settings: { execution: 'managed', webResearch: true }, executives: [{ profileId: 'engineering' }] });
    await runToRest(h.runner);
    expect(provider.jobs[0]!.web).toBe(true);
    expect(h.org.business.memory.some((m) => m.title === 'Hosted lesson')).toBe(true);
  });

  /** An organisation paused with its one lead's plan part-way through a session. */
  async function midPlan(webResearch: boolean) {
    const run = await harness({ settings: { execution: 'managed', webResearch }, executives: [{ profileId: 'engineering' }], mock: { delayMs: 2, runs: 'never' } });
    h = run;
    run.runner.start();
    await waitFor(() => run.org.plans.find((p) => p.ownerId === 'cto')?.phases[0]?.status === 'done', 'the first phase');
    run.runner.pause();
    await run.runner.idle();
    const plan = run.org.plans.find((p) => p.ownerId === 'cto')!;
    expect(plan.status).toBe('executing');
    return { run, plan, notes: () => run.org.board.filter((m) => /web access/.test(m.title)) };
  }

  it('keeps the web access it started with when that is taken away, and the board says so', async () => {
    const { run, plan, notes } = await midPlan(true);
    expect(plan.managed!.web).toBe(true);
    // Taking away something that has nothing to do with the web says nothing of it.
    await run.runner.setPrivilege('cto', 'ask_signatory', false);
    expect(notes()).toHaveLength(0);

    await run.runner.setPrivilege('cto', 'web_search', false);
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toMatchObject({ title: 'The CTO session keeps the web access it started with', body: expect.stringContaining('pause the organisation') });
    // The session is as it was: nothing here can change what it was started with.
    expect(plan.managed!.web).toBe(true);

    // Given back, then taken away from the whole organisation: the same is said again. A change that takes nothing away says nothing.
    await run.runner.setPrivilege('cto', 'web_search', true);
    run.runner.updateSettings({ webResearch: false });
    expect(notes()).toHaveLength(2);
    run.runner.updateSettings({ budgetUsd: 2000 });
    expect(notes()).toHaveLength(2);
  });

  it('is not said to keep web access it never had', async () => {
    const { run, plan, notes } = await midPlan(false);
    expect(plan.managed!.web).toBe(false);
    run.runner.updateSettings({ webResearch: true });
    await run.runner.setPrivilege('cto', 'web_search', false);
    run.runner.updateSettings({ webResearch: false });
    expect(notes()).toHaveLength(0);
  });
});

describe('a local agent', () => {
  class Watching extends MockProvider {
    seen: Array<{ tools: string[]; search: boolean }> = [];
    override agent(request: Parameters<MockProvider['agent']>[0]) {
      this.seen.push({ tools: request.tools.map((tool) => tool.name), search: !!request.webSearch });
      return super.agent(request);
    }
  }

  it('is offered only what its role may do, and no web search without the privilege', async () => {
    const provider = new Watching(QUIET);
    h = await harness({ provider, settings: { webResearch: true }, executives: [{ profileId: 'engineering' }] });
    for (const privilege of ['web_search', 'update_records', 'read_mail', 'draft_mail', 'sign_in'] as const) changePrivilege(h.org, 'cto', privilege, false);
    await runToRest(h.runner);
    expect(provider.seen.length).toBeGreaterThan(0);
    for (const { tools, search } of provider.seen) {
      expect(search).toBe(false);
      expect(tools).toContain('read_business');
      expect(tools).toContain('business_access');
      for (const gone of ['update_business', 'read_business_email', 'draft_business_email', 'account_browser']) expect(tools).not.toContain(gone);
    }
  });

  it('has the lot at the defaults', async () => {
    const provider = new Watching(QUIET);
    h = await harness({ provider, settings: { webResearch: true }, executives: [{ profileId: 'engineering' }] });
    await runToRest(h.runner);
    expect(provider.seen[0]!.search).toBe(true);
    expect(provider.seen[0]!.tools).toEqual(expect.arrayContaining(['update_business', 'read_business_email', 'draft_business_email', 'account_browser']));
  });
});

describe('the access service', () => {
  const mailbox = { label: 'Business', address: 'office@paperclips.example', username: 'office@paperclips.example', password: 'test-only-mail-secret', imapHost: 'imap.paperclips.example', smtpHost: 'smtp.paperclips.example', ownerIds: ['coo'] };
  const account = { label: 'Supplier', loginUrl: 'https://supplies.example/login', signupUrl: 'https://supplies.example/signup', allowSignup: true, username: 'paperclips', password: 'test-only-site-secret', ownerIds: ['coo'] };
  const page = { title: 'Page', url: 'https://supplies.example/', text: '', elements: [], notice: '' };
  let dir: string, access: BusinessAccess, held: Set<Privilege>;
  let mail: MailTransport, browser: AccountBrowser & { run: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
  const open = async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'privileges-'));
    held = new Set(['read_mail', 'draft_mail', 'sign_in']);
    mail = { check: vi.fn(async () => {}), list: vi.fn(async () => []), read: vi.fn(async () => ({ id: '1', from: '', subject: '', date: '', text: '', truncated: false })), send: vi.fn(async () => {}) };
    browser = { run: vi.fn(async () => page), close: vi.fn(async () => {}) };
    access = new BusinessAccess(path.join(dir, 'vault.json'), 'org_test', () => ['ceo', 'coo'], { mail, browser, allows: (_actor, privilege) => held.has(privilege) });
    await access.unlock('a long business vault passphrase', true);
    return { box: await access.addMailbox(mailbox), site: await access.addAccount(account) };
  };
  afterEach(async () => { await access?.dispose(); await rm(dir, { recursive: true, force: true }).catch(() => {}); });

  it('refuses each thing to a role without its privilege, even with the connection assigned', async () => {
    const { box, site } = await open();
    held.clear();
    const forbidden = expect.objectContaining({ status: 403 });
    await expect(access.listMail(box.id, 'coo')).rejects.toEqual(forbidden);
    await expect(access.readMail(box.id, '1', 'coo')).rejects.toEqual(forbidden);
    await expect(access.draft({ mailboxId: box.id, to: 'a@example.com', subject: 'Hello', text: 'Hi' }, 'coo')).rejects.toEqual(forbidden);
    await expect(access.browse({ accountId: site.id, action: 'login' }, 'coo', 'task1')).rejects.toEqual(forbidden);
    expect(mail.list).not.toHaveBeenCalled();
    expect(mail.read).not.toHaveBeenCalled();
    expect(browser.run).not.toHaveBeenCalled();
  });

  it('needs Create accounts to open a sign-up page, whatever else the role may do', async () => {
    const { site } = await open();
    held.add('act');
    await expect(access.browse({ accountId: site.id, action: 'signup' }, 'coo', 'task1')).rejects.toMatchObject({ status: 403 });
    held.add('create_accounts');
    await access.browse({ accountId: site.id, action: 'signup' }, 'coo', 'task1');
    expect(browser.run).toHaveBeenCalledOnce();
  });

  it('gives the browser the role’s standing, afresh at every step', async () => {
    const { site } = await open();
    const writes = () => browser.run.mock.calls.map((call) => call[5]);
    await access.browse({ accountId: site.id, action: 'login' }, 'coo', 'task1');
    held.add('act');
    await access.browse({ accountId: site.id, action: 'inspect' }, 'coo', 'task1');
    held.delete('act');
    await access.browse({ accountId: site.id, action: 'inspect' }, 'coo', 'task1');
    expect(writes()).toEqual([{ write: false }, { write: true }, { write: false }]);
  });

  it('holds a person to none of it, and a role named Person cannot pass as one', async () => {
    const { box, site } = await open();
    held.clear();
    await access.listMail(box.id, 'person');
    await access.browse({ accountId: site.id, action: 'login' }, 'person', 'desk');
    expect(browser.run.mock.calls[0]![5]).toEqual({ write: true });
    expect(access.may('Person', 'read_mail')).toBe(false);
  });

  it('where nothing is said, stands at the defaults: a role cannot act', async () => {
    await open();
    const plain = new BusinessAccess(path.join(dir, 'plain.json'), 'org_plain', () => ['coo'], { mail, browser });
    expect(plain.may('coo', 'sign_in')).toBe(true);
    expect(plain.may('coo', 'act')).toBe(false);
    await plain.dispose();
  });

  it('lists only what the role may reach, and sign-up only where it may use it', async () => {
    const { box, site } = await open();
    const seen = () => JSON.parse(/\{.*\}/.exec(access.context('coo'))![0]);
    expect(seen().accounts[0]).toMatchObject({ id: site.id, allowSignup: false, mayAct: false });
    held.add('act'); held.add('create_accounts');
    expect(seen().accounts[0]).toMatchObject({ allowSignup: true, mayAct: true });
    held.delete('sign_in');
    expect(seen().accounts).toEqual([]);
    expect(seen().mailboxes[0].id).toBe(box.id);
    held.delete('read_mail'); held.delete('draft_mail');
    expect(seen().mailboxes).toEqual([]);
  });

  it('offers no tool the role may not use, and refuses one offered before the privilege went', async () => {
    const { box } = await open();
    const tools = () => accessTools(access, 'coo', 'task1', new AbortController().signal, () => true);
    const names = () => tools().map((tool) => tool.name);
    const read = tools().find((tool) => tool.name === 'read_business_email')!;
    expect(names()).toEqual(['business_access', 'read_business_email', 'draft_business_email', 'account_browser']);
    held.clear();
    expect(names()).toEqual(['business_access']);
    expect(await read.run({ mailboxId: box.id })).toMatch(/may not read business email/);
  });

  it('tells a read-only role so in the tool it is given', async () => {
    await open();
    const description = () => accessTools(access, 'coo', 'task1', new AbortController().signal, () => true).find((tool) => tool.name === 'account_browser')!.description;
    expect(description()).toContain('sign in and read only');
    expect(description()).not.toContain('login/signup');
    held.add('act'); held.add('create_accounts');
    expect(description()).not.toContain('sign in and read only');
    expect(description()).toContain('login/signup');
  });

  it('stops what a role has under way when it loses the privilege, and closes only its own sessions', async () => {
    const { box, site } = await open();
    let reached = false, seen: AbortSignal | undefined;
    (mail.list as ReturnType<typeof vi.fn>).mockImplementation((_box: unknown, signal: AbortSignal) => {
      seen = signal; reached = true;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    const reading = access.listMail(box.id, 'coo');
    const outcome = reading.catch((error) => error);
    await waitFor(() => reached, 'the read to begin');
    await access.browse({ accountId: site.id, action: 'login' }, 'coo', 'task1');
    await access.browse({ accountId: site.id, action: 'login' }, 'ceo', 'task9').catch(() => {});
    browser.close.mockClear();
    held.delete('read_mail');
    await access.revoke('coo');
    expect(seen!.aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(browser.close).toHaveBeenCalledWith(undefined, 'task1');
    expect(browser.close).not.toHaveBeenCalledWith(undefined, 'task9');
  });

  it('does not hand back what arrives after the privilege has gone', async () => {
    const { box } = await open();
    let finish = () => {};
    (mail.list as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise((resolve) => { finish = () => resolve([{ id: '1', from: 'a', subject: 'Private', date: '' }]); }));
    const reading = access.listMail(box.id, 'coo').catch((error) => error);
    await waitFor(() => (mail.list as ReturnType<typeof vi.fn>).mock.calls.length > 0, 'the read to begin');
    held.delete('read_mail');
    finish();
    expect(await reading).toMatchObject({ status: 403 });
  });
});

describe('the privileges route', () => {
  let server: Server;
  const call = async (base: string, id: string, body: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(`${base}/api/orgs/${id}/privileges`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  const serve = async (run: Harness) => {
    const config: Config = { port: 0, host: '127.0.0.1', dataDir: run.dir, provider: 'mock', providerReason: 'test', production: false, workspace: 'default', anthropicAmbient: false, claudeCode: { command: 'claude', extraUsage: false, blocked: null } };
    server = createApp(run.registry, config).listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  afterEach(async () => { server?.closeAllConnections(); await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())); });

  it('sets a privilege, returns the view, and keeps it through a save', async () => {
    h = await harness();
    const base = await serve(h), lead = leadOf(h);
    const { status, data } = await call(base, h.org.id, { seatId: lead.id, privilege: 'act', allowed: true });
    expect(status).toBe(200);
    expect((data as OrgView).org.privileges[lead.id]).toEqual({ act: true });
    await h.runner.flush();
    const saved = (await h.store.loadAll()).find((org) => org.id === h!.org.id);
    expect(saved?.privileges[lead.id]).toEqual({ act: true });
  });

  it('turns away what is not a privilege, and a request from another site', async () => {
    h = await harness();
    const base = await serve(h), lead = leadOf(h);
    expect((await call(base, h.org.id, { seatId: lead.id, privilege: 'nothing', allowed: true })).status).toBe(400);
    expect((await call(base, h.org.id, { seatId: lead.id, privilege: 'act', allowed: true }, { Origin: 'https://foreign.example' })).status).toBe(403);
    expect(allows(h.org, lead.id, 'act')).toBe(false);
  });

  it('stops a browser session the moment its role loses the privilege', async () => {
    h = await harness();
    const base = await serve(h), lead = leadOf(h);
    const revoke = vi.spyOn(h.runner.access, 'revoke');
    await call(base, h.org.id, { seatId: lead.id, privilege: 'web_search', allowed: false });
    expect(revoke).not.toHaveBeenCalled();
    await call(base, h.org.id, { seatId: lead.id, privilege: 'sign_in', allowed: false });
    expect(revoke).toHaveBeenCalledWith(lead.id);
  });
});
