import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BusinessAccess } from '../src/server/access';
import { codeTools, type PlanBranch } from '../src/server/access-code-tools';
import { GitHubHost } from '../src/server/access-github';
import { Workspace } from '../src/server/workspace';
import type { Privilege } from '../src/shared/privileges';
import type { PlanCode } from '../src/shared/types';
import { FakeGitHub } from './fake-github-api';

// A repository connected to the vault. These run the real client against a local stand-in for GitHub.

const phrase = 'a long business vault passphrase';
const branch = 'agents/org_test/p1';
let dir: string, github: FakeGitHub, access: BusinessAccess, held: Set<Privilege>, workspace: Workspace, code: PlanCode | null, branchOpen: boolean;
const signal = () => new AbortController().signal;
const connect = async (over: object = {}) => {
  await access.addRepository({ label: 'Website', repository: 'acme/website', token: github.token, workflows: ['ci.yml'], ownerIds: ['cto'], ...over });
  return access.vault.read().repositories[0]!;
};
const plan: PlanBranch = { branch, code: () => code, record: next => { code = next; }, open: () => branchOpen };
const tools = () => codeTools(access, 'cto', plan, workspace, signal(), () => true);
const use = async (name: string, input: object) => JSON.parse(await tools().find(tool => tool.name === name)!.run(input as { [key: string]: unknown }));

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'code-'));
  github = new FakeGitHub();
  await github.listen();
  held = new Set(['read_code', 'push_code', 'run_workflows']);
  code = null;
  branchOpen = true;
  access = new BusinessAccess(path.join(dir, 'vault.json'), 'org_test', () => ['ceo', 'cto'], { code: new GitHubHost(github.base), allows: (_actor, privilege) => held.has(privilege) });
  await access.unlock(phrase, true);
  workspace = new Workspace(path.join(dir, 'workspace'));
  await workspace.init?.();
});
afterEach(async () => { await access.dispose(); await github.close(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); });

describe('connecting a repository', () => {
  it('asks GitHub first, keeps the token out of every view, and encrypts it', async () => {
    const saved = await access.addRepository({ label: 'Website', repository: 'https://github.com/acme/website.git', token: github.token, ownerIds: ['cto'] });
    expect(saved).toMatchObject({ fullName: 'acme/website', defaultBranch: 'main', private: true, canPush: true });
    expect(JSON.stringify(saved)).not.toContain(github.token);
    expect(JSON.stringify(await access.view())).not.toContain(github.token);
    const { readFile } = await import('node:fs/promises');
    expect(await readFile(access.vault.file, 'utf8')).not.toContain(github.token);
    expect(access.context('cto')).not.toContain(github.token);
  });
  it('refuses a token GitHub refuses, and saves nothing', async () => {
    await expect(access.addRepository({ label: 'Website', repository: 'acme/website', token: 'github_pat_wrong_token_00000000', ownerIds: [] })).rejects.toMatchObject({ status: 403, message: expect.stringContaining('refused the token') });
    expect((await access.view()).repositories).toEqual([]);
  });
  it('turns away what is not a repository, a team that does not exist and a second copy', async () => {
    for (const repository of ['nothing', 'a/b/c', '../etc/passwd', 'acme/..']) await expect(access.addRepository({ label: 'x', repository, token: github.token, ownerIds: [] })).rejects.toMatchObject({ status: 400 });
    await expect(connect({ ownerIds: ['nobody'] })).rejects.toThrow(/existing executive team/);
    await connect();
    await expect(access.addRepository({ label: 'Again', repository: 'ACME/website', token: github.token, ownerIds: [] })).rejects.toThrow();
  });
  it('checks a new token before keeping it, and takes up what it can do', async () => {
    const repo = await connect();
    await expect(access.password('repositories', repo.id, 'github_pat_wrong_token_00000000')).rejects.toThrow(/refused the token/);
    expect(access.vault.read().repositories[0]!.password).toBe(github.token);
    github.canPush = false;
    await access.password('repositories', repo.id, github.token);
    expect(access.vault.read().repositories[0]!.canPush).toBe(false);
    expect(access.canCode('cto')).toBe(false);
  });
  it('opens an older vault that has no repositories in it', async () => {
    const stale = new (await import('../src/server/access-vault')).AccessVault(path.join(dir, 'old.json'), 'org_old');
    await stale.unlock(phrase, true);
    await stale.change(data => { delete (data as Partial<typeof data>).repositories; });
    stale.lock();
    await stale.unlock(phrase);
    expect(stale.read().repositories).toEqual([]);
  });
});

describe('what a role is offered', () => {
  it('nothing without a repository assigned, however privileged', async () => {
    held = new Set(['read_code', 'push_code', 'run_workflows', 'edit_pipelines']);
    expect(tools()).toEqual([]);
    await connect({ ownerIds: ['ceo'] });
    expect(tools()).toEqual([]);
  });
  it('the tool for each thing it holds, and only those', async () => {
    await connect();
    expect(tools().map(tool => tool.name)).toEqual(['read_repository', 'push_to_repository', 'run_repository_workflow']);
    held.delete('run_workflows');
    expect(tools().map(tool => tool.name)).toEqual(['read_repository', 'push_to_repository']);
    held.delete('push_code');
    expect(tools().map(tool => tool.name)).toEqual(['read_repository']);
    held.clear();
    expect(tools()).toEqual([]);
  });
  it('a list of what it may do in its context, and none of it when the vault is locked', async () => {
    const repo = await connect();
    expect(access.context('cto')).toContain('"repository":"acme/website"');
    expect(access.context('cto')).toContain('"workflows":["ci.yml"]');
    held.delete('run_workflows');
    expect(access.context('cto')).toContain('"workflows":[]');
    held.delete('read_code');
    expect(access.context('cto')).not.toContain(repo.id);
    await access.lock();
    expect(access.canCode('cto')).toBe(false);
    expect(access.hasRepository('cto')).toBe(false);
  });
});

describe('reading', () => {
  it('lists and reads the main branch until the plan has a branch of its own', async () => {
    const repo = await connect();
    expect((await use('read_repository', { repositoryId: repo.id, action: 'files' })).untrustedContent.files.map((f: { path: string }) => f.path)).toEqual(['README.md', 'src/app.ts']);
    expect((await use('read_repository', { repositoryId: repo.id, action: 'read', path: 'src/app.ts' })).untrustedContent.content).toContain('answer = 42');
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Change', files: [{ path: 'src/app.ts', content: 'export const answer = 43;\n' }] });
    expect((await use('read_repository', { repositoryId: repo.id, action: 'read', path: 'src/app.ts' })).untrustedContent.content).toContain('answer = 43');
  });
  it('refuses a path that climbs out, without asking GitHub', async () => {
    const repo = await connect();
    const before = github.calls.length;
    for (const bad of ['../secrets', 'a/../../b', '/etc/passwd', '.git/config', 'a\\b']) expect((await use('read_repository', { repositoryId: repo.id, action: 'read', path: bad })).error).toMatch(/inside the repository/);
    expect(github.calls).toHaveLength(before);
  });
  it('refuses a ref that would reach anything but this repository, without asking GitHub', async () => {
    const repo = await connect();
    const before = github.calls.length;
    for (const ref of ['../../../../user', '../../other/private/git/trees/main', 'a/../../b', 'main?x=1', 'main#x', '-x', '%2e%2e/user', 'a//b']) {
      for (const action of ['files', 'checks', 'runs']) expect((await use('read_repository', { repositoryId: repo.id, action, ref })).error, ref + ' ' + action).toMatch(/branch, tag or commit/);
      expect((await use('read_repository', { repositoryId: repo.id, action: 'read', path: 'README.md', ref })).error, ref).toMatch(/branch, tag or commit/);
    }
    expect(github.calls).toHaveLength(before);
  });
  it('reads checks by branch or by commit', async () => {
    const repo = await connect();
    github.checks = [{ name: 'ci', status: 'completed', conclusion: 'success' }];
    const sha = github.refs.get('main')!;
    expect((await use('read_repository', { repositoryId: repo.id, action: 'checks', ref: 'main' })).untrustedContent.sha).toBe(sha);
    expect((await use('read_repository', { repositoryId: repo.id, action: 'checks', ref: sha })).untrustedContent.checks).toHaveLength(1);
  });
  it('takes a saved secret out of what it hands back', async () => {
    const repo = await connect();
    github.commits.get(github.refs.get('main')!)!.tree.set('leak.txt', 'token: ' + github.token);
    const read = await use('read_repository', { repositoryId: repo.id, action: 'read', path: 'leak.txt' });
    expect(read.untrustedContent.content).toBe('token: [redacted]');
  });
  it('is closed to a team without the repository, and when it is disabled', async () => {
    const repo = await connect({ ownerIds: ['ceo'] });
    await expect(access.repositoryFiles(repo.id, undefined, 'cto')).rejects.toMatchObject({ status: 403 });
    await access.grant('repositories', repo.id, { ownerIds: ['cto'], enabled: false });
    await expect(access.repositoryFiles(repo.id, undefined, 'cto')).rejects.toMatchObject({ status: 403 });
  });
  it('reads the end of a failed run’s log, and the token does not follow the redirect', async () => {
    const repo = await connect();
    const log = (await use('read_repository', { repositoryId: repo.id, action: 'log', runId: 7 })).untrustedContent;
    expect(log).toMatchObject({ job: 'test', conclusion: 'failure' });
    expect(log.log).toContain('Error: the tests failed');
    expect(log.log).not.toContain('THE TOKEN');
  });
});

describe('pushing', () => {
  it('starts the plan’s branch from main, keeps main as it was, and records the work on the plan', async () => {
    const repo = await connect();
    const main = github.refs.get('main');
    const pushed = await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Add a page', files: [{ path: 'src/page.ts', content: 'export const page = 1;\n' }, { path: 'README.md', remove: true }] });
    expect(pushed.branch).toBe(branch);
    expect(github.refs.get('main')).toBe(main);
    expect([...github.filesOn(branch)!.keys()].sort()).toEqual(['src/app.ts', 'src/page.ts']);
    expect(code).toMatchObject({ repositoryId: repo.id, repository: 'acme/website', branch, sha: pushed.commit, pull: null, branchUrl: 'https://github.com/acme/website/tree/' + branch });
  });
  it('adds to the branch from then on, without ever forcing', async () => {
    const repo = await connect();
    const commit = (name: string) => use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: name, files: [{ path: name, content: name }] });
    await commit('one.txt');
    await commit('two.txt');
    expect([...github.filesOn(branch)!.keys()]).toEqual(expect.arrayContaining(['one.txt', 'two.txt']));
    expect(github.calls.filter(call => call.method === 'PATCH').every(call => (call.body as { force: boolean }).force === false)).toBe(true);
  });
  it('lets agents commit at the same moment without losing one', async () => {
    const repo = await connect();
    const names = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
    const results = await Promise.all(names.map(name => use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: name, files: [{ path: name, content: name }] })));
    expect(results.every(result => result.commit)).toBe(true);
    expect([...github.filesOn(branch)!.keys()]).toEqual(expect.arrayContaining(names));
  });
  it('takes a file from the workspace whole, and refuses one it could not send whole', async () => {
    const repo = await connect();
    await workspace.write('big.txt', 'x'.repeat(200_000));
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Big', files: [{ path: 'big.txt', workspacePath: 'big.txt' }] });
    expect(github.filesOn(branch)!.get('big.txt')).toHaveLength(200_000);
    await writeFile(path.join(workspace.root, 'picture.png'), Buffer.from([0x89, 0x50, 0x00, 0xff]));
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Picture', files: [{ path: 'picture.png', workspacePath: 'picture.png' }] })).error).toMatch(/not a text file/);
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Outside', files: [{ path: 'x', workspacePath: '../vault.json' }] })).error).toBeTruthy();
  });
  it('has no way to name a branch, and the service refuses any but an agent’s', async () => {
    const repo = await connect();
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', branch: 'main', message: 'Hello', files: [{ path: 'x', content: 'x' }] });
    expect(github.filesOn('main')!.has('x')).toBe(false);
    for (const target of ['main', 'release', 'refs/heads/main']) await expect(access.pushCode(repo.id, { branch: target, message: 'x', changes: [{ path: 'x', content: 'x' }] }, 'cto')).rejects.toMatchObject({ status: 403 });
    await expect(access.openPull(repo.id, { branch: 'main', title: 'x', body: '' }, 'cto')).rejects.toMatchObject({ status: 403 });
    await expect(access.startWorkflow(repo.id, { workflow: 'ci.yml', branch: 'main', inputs: {} }, 'cto')).rejects.toMatchObject({ status: 403 });
  });
  it('keeps files under .github to the role that may change pipelines', async () => {
    const repo = await connect();
    for (const file of ['.github/workflows/ci.yml', '.GitHub/Workflows/ci.yml', '.github/actions/x/action.yml']) {
      expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'CI', files: [{ path: file, content: 'x' }] })).error).toMatch(/may not change files under .github/);
    }
    // Replacing the folder itself would take every workflow with it.
    for (const change of [{ path: '.github', content: 'x' }, { path: '.github', remove: true }, { path: '.GITHUB', content: 'x' }]) {
      expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'CI', files: [change] })).error).toMatch(/may not change files under .github/);
    }
    expect((await access.view()).audit.map(item => item.action), 'a refused push leaves no record of a push').not.toContain('code_pushed');
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Fine', files: [{ path: '.github-notes', content: 'x' }] })).commit).toBeTruthy();
    held.add('edit_pipelines');
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'CI', files: [{ path: '.github/workflows/ci.yml', content: 'x' }] })).commit).toBeTruthy();
  });
  it('will not carry a saved secret out, however it is dressed', async () => {
    const repo = await connect();
    await access.addAccount({ label: 'Supplier', loginUrl: 'https://supplies.example/login', username: 'paperclips', password: 'a-saved-site-password!', ownerIds: [] });
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Oops', files: [{ path: 'env', content: 'PASS=' + encodeURIComponent('a-saved-site-password!') }] })).error).toMatch(/saved password or token/);
    const secret = (await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Oops', files: [{ path: 'env', content: 'TOKEN=' + github.token }] })).error;
    expect(secret).toMatch(/saved password or token/);
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: github.token, files: [{ path: 'env', content: 'x' }] })).error).toMatch(/saved password or token/);
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Oops', files: [{ path: 'keys/' + github.token, content: 'x' }] })).error).toMatch(/saved password or token/);
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'Fine', files: [{ path: 'env', content: 'x' }] });
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'open_pull_request', title: 'x', body: 'token ' + github.token })).error).toMatch(/saved password or token/);
    expect(github.pulls).toEqual([]);
    // Written out as JSON, a password with a quote in it would no longer match itself.
    await access.addAccount({ label: 'Other', loginUrl: 'https://other.example/login', username: 'x', password: 'pass"word\\one-1234', ownerIds: [] });
    expect((await use('run_repository_workflow', { repositoryId: repo.id, workflow: 'ci.yml', inputs: { note: 'pass"word\\one-1234' } })).error).toMatch(/saved password or token/);
    expect((await use('run_repository_workflow', { repositoryId: repo.id, workflow: 'ci.yml', inputs: { [github.token]: 'x' } })).error).toMatch(/saved password or token/);
    expect(github.dispatches).toEqual([]);
  });
  it('holds a plan to one repository', async () => {
    const repo = await connect();
    code = { repositoryId: 'repo_other', repository: 'acme/other', branch, branchUrl: '', sha: 'abc', pull: null };
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] })).error).toMatch(/one repository/);
  });
  it('holds it there when two agents reach for two repositories at once', async () => {
    const repo = await connect();
    await access.vault.change(data => { data.repositories.push({ ...data.repositories[0]!, id: 'repo_other', fullName: 'acme/other' }); });
    const push = (id: string) => use('push_to_repository', { repositoryId: id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] });
    const [first, second] = await Promise.all([push(repo.id), push('repo_other')]);
    expect(first.commit).toBeTruthy();
    expect(second.error).toMatch(/one repository/);
    expect(code!.repository).toBe('acme/website');
  });
  it('goes on working on a repository connected again under a new id', async () => {
    const repo = await connect();
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'one', files: [{ path: 'one', content: 'x' }] });
    await access.remove('repositories', repo.id);
    const again = await connect();
    expect((await use('push_to_repository', { repositoryId: again.id, action: 'commit', message: 'two', files: [{ path: 'two', content: 'x' }] })).commit).toBeTruthy();
    expect([...github.filesOn(branch)!.keys()]).toEqual(expect.arrayContaining(['one', 'two']));
    expect((await use('read_repository', { repositoryId: again.id, action: 'read', path: 'two' })).untrustedContent.content).toBe('x');
  });
  it('closes the branch once the change has passed its gates, since nothing after that would be checked', async () => {
    const repo = await connect();
    branchOpen = false;
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] })).error).toMatch(/passed its gates/);
    expect(github.refs.has(branch)).toBe(false);
  });
  it('keeps a script’s right to run, and gives it to a new one only when asked', async () => {
    const repo = await connect();
    github.commits.get(github.refs.get('main')!)!.tree.set('run.sh', 'old');
    github.modes.set('run.sh', '100755');
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'run.sh', content: 'new' }, { path: 'plain.sh', content: 'x' }, { path: 'made.sh', content: 'x', executable: true }] });
    expect(['run.sh', 'plain.sh', 'made.sh'].map(file => github.modes.get(file))).toEqual(['100755', '100644', '100755']);
  });
  it('says so plainly when a role has lost the privilege mid-task, or the push is refused', async () => {
    const repo = await connect();
    const offered = tools().find(tool => tool.name === 'push_to_repository')!;
    held.delete('push_code');
    expect(JSON.parse(await offered.run({ repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] })).error).toMatch(/may not push code/);
    held.add('push_code');
    github.denied = [/^\/git\/trees$/];
    expect(JSON.parse(await offered.run({ repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] })).error).toMatch(/token does not allow/);
  });
});

describe('pull requests', () => {
  it('open from the plan’s branch to main, once, and go on the plan', async () => {
    const repo = await connect();
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'open_pull_request', title: 'x' })).error).toMatch(/Push a commit first/);
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] });
    const opened = await use('push_to_repository', { repositoryId: repo.id, action: 'open_pull_request', title: 'Add x', body: 'Why' });
    expect(opened.pullRequest).toBe(1);
    expect(github.pulls[0]).toMatchObject({ branch, base: 'main', title: 'Add x' });
    expect(code!.pull).toEqual({ number: 1, url: 'https://github.com/acme/website/pull/1' });
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'open_pull_request', title: 'Again', body: '' })).pullRequest).toBe(1);
    expect(github.pulls).toHaveLength(1);
  });
  it('cannot be merged by anything an agent has', () => {
    const everything = JSON.stringify(tools().map(tool => tool.name));
    expect(everything).not.toContain('merge');
    expect(github.calls.some(call => call.path.includes('/merge'))).toBe(false);
  });
});

describe('workflows', () => {
  it('start only from the list, only on the plan’s branch, and only once something is there', async () => {
    const repo = await connect();
    expect((await use('run_repository_workflow', { repositoryId: repo.id, workflow: 'ci.yml' })).error).toMatch(/Push a commit first/);
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] });
    expect((await use('run_repository_workflow', { repositoryId: repo.id, workflow: 'deploy.yml' })).error).toMatch(/not on the list/);
    expect((await access.view()).audit.map(item => item.action), 'a refused workflow leaves no record of one started').not.toContain('workflow_started');
    expect(await use('run_repository_workflow', { repositoryId: repo.id, workflow: 'ci.yml', inputs: { target: 'all' } })).toEqual({ runId: 9001 });
    expect(github.dispatches).toEqual([{ workflow: 'ci.yml', ref: branch, inputs: { target: 'all' } }]);
    await access.setWorkflows(repo.id, { workflows: [] });
    expect((await use('run_repository_workflow', { repositoryId: repo.id, workflow: 'ci.yml' })).error).toMatch(/not on the list/);
  });
  it('do not read as failed when GitHub answers with nothing', async () => {
    const repo = await connect();
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] });
    github.dispatchNoContent = true;
    expect(await use('run_repository_workflow', { repositoryId: repo.id, workflow: 'ci.yml' })).toEqual({ runId: null });
    expect(github.dispatches).toHaveLength(1);
  });
  it('are checked again at the last moment, against the live list and the live privilege', async () => {
    const repo = await connect();
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] });
    const start = () => access.startWorkflow(repo.id, { workflow: 'ci.yml', branch, inputs: {} }, 'cto');
    const real = access.vault.change.bind(access.vault);
    const during = (step: () => Promise<unknown> | void) => vi.spyOn(access.vault, 'change').mockImplementationOnce(async change => { const result = await real(change); await step(); return result; });
    during(() => { held.delete('run_workflows'); });
    await expect(start()).rejects.toMatchObject({ status: 403 });
    held.add('run_workflows');
    during(() => access.setWorkflows(repo.id, { workflows: [] }));
    await expect(start()).rejects.toMatchObject({ status: 403 });
    expect(github.dispatches).toEqual([]);
  });
});

describe('checks', () => {
  const head = async () => { const repo = await connect(); await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] }); return repo; };
  const facts = (repo: { id: string; fullName?: string }) => access.codeFacts({ repositoryId: repo.id, repository: repo.fullName ?? 'acme/website', branch }, signal());
  it('treat a commit with no statuses as having none, not as pending, as GitHub’s own summary would', async () => {
    expect((await facts(await head())).checks).toEqual([]);
  });
  it('read every result on the commit: passed, failed, pending, and statuses from outside Actions', async () => {
    const repo = await head();
    github.checks = [{ name: 'lint', status: 'completed', conclusion: 'success' }, { name: 'skip', status: 'completed', conclusion: 'skipped' }, { name: 'quiet', status: 'completed', conclusion: 'neutral' }, { name: 'test', status: 'completed', conclusion: 'failure' }, { name: 'late', status: 'completed', conclusion: 'timed_out' }, { name: 'build', status: 'in_progress', conclusion: null }, { name: 'queue', status: 'queued', conclusion: null }];
    github.statuses = [{ context: 'ci/outside', state: 'success', target_url: null }, { context: 'ci/broken', state: 'error', target_url: null }, { context: 'ci/slow', state: 'pending', target_url: null }];
    const states = Object.fromEntries((await facts(repo)).checks.map(check => [check.name, check.state]));
    expect(states).toEqual({ lint: 'passed', skip: 'skipped', quiet: 'skipped', test: 'failed', late: 'failed', build: 'pending', queue: 'pending', 'ci/outside': 'passed', 'ci/broken': 'failed', 'ci/slow': 'pending' });
  });
  it('fall back on Actions’ own record where a token cannot list check runs', async () => {
    const repo = await head();
    const sha = github.refs.get(branch)!;
    github.denied = [/check-runs$/];
    github.runs = [{ id: 1, name: 'CI', status: 'completed', conclusion: 'failure', head_sha: sha, head_branch: branch, html_url: 'https://github.com/run/1' }, { id: 2, name: 'Other commit', status: 'completed', conclusion: 'success', head_sha: 'other', head_branch: branch, html_url: '' }];
    expect((await facts(repo)).checks).toEqual([{ name: 'CI', state: 'failed', url: 'https://github.com/run/1' }]);
  });
  it('count statuses they cannot read against the commit, or a failure there would go unseen', async () => {
    const repo = await head();
    github.denied = [/\/status$/];
    github.checks = [{ name: 'lint', status: 'completed', conclusion: 'success' }];
    expect((await facts(repo)).checks).toEqual(expect.arrayContaining([expect.objectContaining({ state: 'failed', name: expect.stringContaining('Commit statuses could not be read') })]));
  });
  it('read every page, so that a failure at the end is not missed', async () => {
    const repo = await head();
    github.statuses = Array.from({ length: 130 }, (_, i) => ({ context: 'ci/' + i, state: i === 129 ? 'failure' : 'success', target_url: null }));
    github.checks = Array.from({ length: 130 }, (_, i) => ({ name: 'job ' + i, status: 'completed', conclusion: i === 129 ? 'failure' : 'success' }));
    const { checks } = await facts(repo);
    expect(checks).toHaveLength(260);
    expect(checks.filter(check => check.state === 'failed').map(check => check.name)).toEqual(['job 129', 'ci/129']);
  });
  it('count what is too long to read against the commit', async () => {
    const repo = await head();
    github.checks = Array.from({ length: 501 }, (_, i) => ({ name: 'job ' + i, status: 'completed', conclusion: 'success' }));
    expect((await facts(repo)).checks.at(-1)).toMatchObject({ state: 'failed', name: 'More check runs than could be read' });
    github.checks = [];
    github.statuses = Array.from({ length: 501 }, (_, i) => ({ context: 'ci/' + i, state: 'success', target_url: null }));
    expect((await facts(repo)).checks.at(-1)).toMatchObject({ state: 'failed', name: 'More commit statuses than could be read' });
    github.statuses = [];
    github.denied = [/check-runs$/];
    github.runs = Array.from({ length: 101 }, (_, i) => ({ id: i, name: 'run ' + i, status: 'completed', conclusion: 'success', head_sha: github.refs.get(branch)!, head_branch: branch, html_url: '' }));
    const fewer = (await facts(repo)).checks;
    expect(fewer.at(-1)).toMatchObject({ state: 'failed', name: 'More workflow runs than could be read' });
  });
  it('find a repository connected again under a new id, and say so when it is gone', async () => {
    const repo = await head();
    await access.remove('repositories', repo.id);
    expect(await facts(repo)).toMatchObject({ connected: false, sha: null });
    const again = await connect();
    expect(again.id).not.toBe(repo.id);
    expect(await facts(repo)).toMatchObject({ connected: true, sha: github.refs.get(branch) });
    await access.grant('repositories', again.id, { ownerIds: ['cto'], enabled: false });
    expect(await facts(again)).toMatchObject({ connected: false });
  });
  it('need the vault open', async () => {
    const repo = await head();
    await access.lock();
    await expect(facts(repo)).rejects.toMatchObject({ status: 423 });
  });
  it('find the pull request for the branch, and what became of it', async () => {
    const repo = await head();
    expect((await facts(repo)).pull).toBeNull();
    await use('push_to_repository', { repositoryId: repo.id, action: 'open_pull_request', title: 'x', body: '' });
    expect((await facts(repo)).pull).toMatchObject({ number: 1, state: 'open' });
    github.pulls[0]!.state = 'closed';
    expect((await facts(repo)).pull).toMatchObject({ state: 'closed' });
    expect((await use('push_to_repository', { repositoryId: repo.id, action: 'open_pull_request', title: 'Again', body: '' })).pullRequest).toBe(2);
    github.pulls[1]!.state = 'closed';
    github.pulls[1]!.merged_at = '2026-11-06T17:39:04Z';
    expect((await facts(repo)).pull).toMatchObject({ number: 2, state: 'merged' });
  });
});

describe('a role without the privilege', () => {
  const quiet = () => github.calls.length;
  const audited = async () => (await access.view()).audit.map(item => item.action);
  it('gets nothing from GitHub: it is refused before anything is asked', async () => {
    const repo = await connect();
    held.delete('read_code');
    const before = quiet();
    for (const read of [access.repositoryFiles(repo.id, undefined, 'cto'), access.repositoryFile(repo.id, 'README.md', undefined, 'cto'), access.repositoryChecks(repo.id, undefined, 'cto'), access.repositoryRuns(repo.id, undefined, 'cto'), access.repositoryLog(repo.id, 7, 'cto')]) {
      await expect(read).rejects.toMatchObject({ status: 403, message: expect.stringContaining('may not read code') });
    }
    expect(quiet()).toBe(before);
  });
  it('does not get what arrives after the privilege has gone', async () => {
    const repo = await connect();
    let release = () => {};
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const host = (access as unknown as { code: GitHubHost }).code;
    const original = host.read.bind(host);
    vi.spyOn(host, 'read').mockImplementation(async (...args) => { await stalled; return original(...args); });
    const reading = access.repositoryFile(repo.id, 'README.md', undefined, 'cto').catch(error => error);
    await vi.waitFor(() => expect(host.read).toHaveBeenCalled());
    held.delete('read_code');
    release();
    expect(await reading).toMatchObject({ status: 403 });
  });
  it('cannot push, and the attempt leaves no mark on GitHub or in the history', async () => {
    const repo = await connect();
    held.delete('push_code');
    const before = quiet();
    await expect(access.pushCode(repo.id, { branch, message: 'x', changes: [{ path: 'x', content: 'x' }] }, 'cto')).rejects.toMatchObject({ status: 403 });
    expect(quiet()).toBe(before);
    expect(await audited()).not.toContain('code_pushed');
  });
  it('cannot open a pull request', async () => {
    const repo = await connect();
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] });
    held.delete('push_code');
    await expect(access.openPull(repo.id, { branch, title: 'x', body: '' }, 'cto')).rejects.toMatchObject({ status: 403 });
    expect(github.pulls).toEqual([]);
    expect(await audited()).not.toContain('pull_request_opened');
  });
  it('cannot start a workflow', async () => {
    const repo = await connect();
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] });
    held.delete('run_workflows');
    await expect(access.startWorkflow(repo.id, { workflow: 'ci.yml', branch, inputs: {} }, 'cto')).rejects.toMatchObject({ status: 403 });
    expect(github.dispatches).toEqual([]);
    expect(await audited()).not.toContain('workflow_started');
  });
});

describe('losing access', () => {
  it('stops a push under way when the repository’s access changes', async () => {
    const repo = await connect();
    let release = () => {};
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const host = (access as unknown as { code: GitHubHost }).code;
    const original = host.commit.bind(host);
    vi.spyOn(host, 'commit').mockImplementation(async (record, name, message, changes, abort) => { await stalled; abort.throwIfAborted(); return original(record, name, message, changes, abort); });
    const pushing = access.pushCode(repo.id, { branch, message: 'x', changes: [{ path: 'x', content: 'x' }] }, 'cto').catch(error => error);
    await vi.waitFor(() => expect(host.commit).toHaveBeenCalled());
    await access.grant('repositories', repo.id, { ownerIds: [], enabled: true });
    release();
    expect(await pushing).toMatchObject({ status: 409 });
    expect(github.refs.has(branch)).toBe(false);
  });
  it('holds a queued push to what the role may do when its turn comes', async () => {
    held.add('edit_pipelines');
    const repo = await connect();
    let release = () => {};
    const stalled = new Promise<void>(resolve => { release = resolve; });
    const host = (access as unknown as { code: GitHubHost }).code;
    const original = host.commit.bind(host);
    vi.spyOn(host, 'commit').mockImplementationOnce(async (...args) => { await stalled; return original(...args); });
    const first = access.pushCode(repo.id, { branch, message: 'one', changes: [{ path: 'one', content: 'x' }] }, 'cto');
    await vi.waitFor(() => expect(host.commit).toHaveBeenCalled());
    const second = access.pushCode(repo.id, { branch, message: 'two', changes: [{ path: '.github/workflows/ci.yml', content: 'x' }] }, 'cto').catch(error => error);
    held.delete('edit_pipelines');
    release();
    await first;
    expect(await second).toMatchObject({ status: 403 });
    expect(github.filesOn(branch)!.has('.github/workflows/ci.yml')).toBe(false);
  });
  it('removes the token with the connection, and leaves the repository alone', async () => {
    const repo = await connect();
    const calls = github.calls.length;
    await access.remove('repositories', repo.id);
    expect(access.vault.read().repositories).toEqual([]);
    expect(github.calls).toHaveLength(calls);
  });
  it('records every outward step in the access history', async () => {
    const repo = await connect();
    await use('push_to_repository', { repositoryId: repo.id, action: 'commit', message: 'x', files: [{ path: 'x', content: 'x' }] });
    await use('push_to_repository', { repositoryId: repo.id, action: 'open_pull_request', title: 'x', body: '' });
    await use('run_repository_workflow', { repositoryId: repo.id, workflow: 'ci.yml' });
    const actions = (await access.view()).audit.map(item => item.action);
    expect(actions).toEqual(expect.arrayContaining(['repository_connected', 'code_pushed', 'pull_request_opened', 'workflow_started']));
  });
});
