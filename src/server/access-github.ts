import type { CheckResult } from '../shared/types';
import { serviceURL } from './access-network';
import { AccessError, type RepositorySecret } from './access-vault';

// GitHub's REST API, for the access service. The address is fixed here and never read from settings or from anything
// a person or an agent types, so a token only ever goes to GitHub. Every record passed in is live from the vault.

const API = 'https://api.github.com';
const API_VERSION = '2026-03-10';
const TIMEOUT_MS = 30_000;
const MAX_JSON_BYTES = 8_000_000;
const MAX_LOG_BYTES = 2_000_000;
const MAX_FILES_LISTED = 2000;
const MAX_FILE_CHARS = 120_000;
const MAX_LOG_CHARS = 12_000;
const MAX_PAGES = 5;

type Repo = Pick<RepositorySecret, 'fullName' | 'password' | 'defaultBranch'>;
export interface RepositoryFacts { fullName: string; defaultBranch: string; private: boolean; htmlUrl: string; canPush: boolean; }
export interface RepositoryFile { path: string; bytes: number; }
export interface FileChange { path: string; content: string | null; executable?: boolean; }
export interface PullFacts { number: number; url: string; sha: string; state: 'open' | 'closed' | 'merged'; }
export interface RunFacts { id: number; name: string; status: string; conclusion: string | null; sha: string; url: string; }

/** Everything the program does on a code host. Tests stand in for it, or point it at a local server. */
export interface CodeHost {
  repository(record: Pick<Repo, 'fullName' | 'password'>, signal: AbortSignal): Promise<RepositoryFacts>;
  files(record: Repo, ref: string, signal: AbortSignal): Promise<{ files: RepositoryFile[]; truncated: boolean }>;
  read(record: Repo, path: string, ref: string, signal: AbortSignal): Promise<{ path: string; content: string; truncated: boolean }>;
  head(record: Repo, branch: string, signal: AbortSignal): Promise<string | null>;
  commit(record: Repo, branch: string, message: string, changes: FileChange[], signal: AbortSignal): Promise<string>;
  openPull(record: Repo, branch: string, title: string, body: string, signal: AbortSignal): Promise<PullFacts>;
  findPull(record: Repo, branch: string, signal: AbortSignal): Promise<PullFacts | null>;
  checks(record: Repo, sha: string, signal: AbortSignal): Promise<CheckResult[]>;
  runs(record: Repo, branch: string, signal: AbortSignal): Promise<RunFacts[]>;
  startWorkflow(record: Repo, workflow: string, branch: string, inputs: Inputs, signal: AbortSignal): Promise<number | null>;
  runLog(record: Repo, runId: number, signal: AbortSignal): Promise<{ job: string; conclusion: string | null; log: string }>;
}
type Inputs = { [name: string]: string };

/** A result that could not be read counts against a gate. A check nobody saw is not a check that passed. */
const unreadable = (name: string): CheckResult => ({ name, state: 'failed', url: '' });
type PullAnswer = { number: number; html_url: string; state: string; merged_at: string | null; head: { sha: string } };
const pullFacts = (pull: PullAnswer): PullFacts => ({ number: pull.number, url: pull.html_url, sha: pull.head.sha, state: pull.merged_at ? 'merged' : pull.state === 'open' ? 'open' : 'closed' });

const segments = (value: string) => value.split('/').map(encodeURIComponent).join('/');

/** Neutral and skipped finished without objecting, which is not the same as having shown anything. */
function stateOf(status: string, conclusion: string | null): CheckResult['state'] {
  if (status !== 'completed') return 'pending';
  if (conclusion === 'success') return 'passed';
  return conclusion === 'neutral' || conclusion === 'skipped' ? 'skipped' : 'failed';
}

/** Keeps the last part of a long body, which is the part of a build log that says what went wrong. */
async function tail(response: Response, limit: number): Promise<Buffer> {
  // An answer with no content has no body at all.
  if (!response.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let total = 0;
  for await (const part of response.body as unknown as AsyncIterable<Uint8Array>) {
    parts.push(Buffer.from(part));
    total += part.length;
    while (total - parts[0]!.length >= limit) total -= parts.shift()!.length;
  }
  return Buffer.concat(parts);
}

export class GitHubHost implements CodeHost {
  constructor(private readonly api = API) {}

  private headers(token: string, accept = 'application/vnd.github+json'): HeadersInit {
    return { Accept: accept, 'X-GitHub-Api-Version': API_VERSION, 'User-Agent': 'the_organisation', ...(token ? { Authorization: 'Bearer ' + token } : {}) };
  }
  private refused(status: number, message: string, limited: boolean): AccessError {
    if (status === 401) return new AccessError('GitHub refused the token. It may have expired: replace it under Repositories.', 403);
    if (limited || status === 429) return new AccessError('GitHub’s rate limit has been reached. Try again later.', 429);
    if (status === 403) return new AccessError('The token does not allow this' + (message ? ' (' + message.slice(0, 200) + ').' : '.'), 403);
    if (status === 404) return new AccessError('GitHub cannot find that, or the token cannot see it.', 404);
    if (status === 409 || status === 422) return new AccessError('GitHub would not do that: ' + (message.slice(0, 300) || 'it conflicts with the repository as it stands.'), 409);
    return new AccessError('GitHub could not complete the request.', 502);
  }
  /** One call. An error answers with what GitHub said about it, and never with a request or a header. */
  private async request<T>(token: string, method: string, path: string, signal: AbortSignal, body?: unknown): Promise<T> {
    const response = await fetch(this.api + path, {
      method, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
      headers: { ...this.headers(token), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = (await tail(response, MAX_JSON_BYTES)).toString('utf8');
    if (!response.ok) {
      let message = '';
      try {
        const data = JSON.parse(text) as { message?: unknown; errors?: Array<{ message?: unknown }> };
        message = [data.message, ...(data.errors ?? []).map(item => item.message)].filter(item => typeof item === 'string').join('. ');
      } catch { /* A body that is not JSON says nothing useful. */ }
      throw this.refused(response.status, message, response.headers.get('x-ratelimit-remaining') === '0');
    }
    return (text ? JSON.parse(text) : null) as T;
  }
  private base(record: Pick<Repo, 'fullName'>) { return '/repos/' + segments(record.fullName); }

  async repository(record: Pick<Repo, 'fullName' | 'password'>, signal: AbortSignal): Promise<RepositoryFacts> {
    const data = await this.request<{ full_name: string; default_branch: string; private: boolean; html_url: string; permissions?: { push?: boolean } }>(record.password, 'GET', this.base(record), signal);
    return { fullName: data.full_name, defaultBranch: data.default_branch, private: data.private, htmlUrl: data.html_url, canPush: data.permissions?.push === true };
  }
  async files(record: Repo, ref: string, signal: AbortSignal) {
    try {
      const data = await this.request<{ tree: Array<{ path: string; type: string; size?: number }>; truncated: boolean }>(record.password, 'GET', this.base(record) + '/git/trees/' + segments(ref) + '?recursive=1', signal);
      const files = data.tree.filter(item => item.type === 'blob').map(item => ({ path: item.path, bytes: item.size ?? 0 }));
      return { files: files.slice(0, MAX_FILES_LISTED), truncated: data.truncated || files.length > MAX_FILES_LISTED };
    } catch (error) {
      // A repository with no commits has no tree to list.
      if (error instanceof AccessError && error.status === 409) return { files: [], truncated: false };
      throw error;
    }
  }
  async read(record: Repo, path: string, ref: string, signal: AbortSignal) {
    const data = await this.request<{ type?: string; encoding?: string; content?: string; path?: string }>(record.password, 'GET', this.base(record) + '/contents/' + segments(path) + '?ref=' + encodeURIComponent(ref), signal);
    if (data.type !== 'file') throw new AccessError('That path is not a file.');
    if (data.encoding !== 'base64' || data.content === undefined) throw new AccessError('That file is too large to read here.');
    const text = Buffer.from(data.content, 'base64').toString('utf8');
    return { path, content: text.slice(0, MAX_FILE_CHARS), truncated: text.length > MAX_FILE_CHARS };
  }
  async head(record: Repo, branch: string, signal: AbortSignal): Promise<string | null> {
    try { return (await this.request<{ object: { sha: string } }>(record.password, 'GET', this.base(record) + '/git/ref/heads/' + segments(branch), signal)).object.sha; }
    catch (error) {
      // An empty repository answers 409 to this, and has no such branch either.
      if (error instanceof AccessError && (error.status === 404 || error.status === 409)) return null;
      throw error;
    }
  }
  /** Adds a commit on top of a branch, starting the branch from the main one if it is new. Never forces. */
  async commit(record: Repo, branch: string, message: string, changes: FileChange[], signal: AbortSignal): Promise<string> {
    const head = await this.head(record, branch, signal);
    const parent = head ?? await this.head(record, record.defaultBranch, signal);
    if (!parent) throw new AccessError('This repository has no commits yet. Add a first commit on GitHub, then try again.', 409);
    const base = await this.request<{ tree: { sha: string } }>(record.password, 'GET', this.base(record) + '/git/commits/' + parent, signal);
    // Editing a script must not take away its right to run.
    const existing = await this.request<{ tree: Array<{ path: string; mode: string }> }>(record.password, 'GET', this.base(record) + '/git/trees/' + base.tree.sha + '?recursive=1', signal);
    const runnable = new Set(existing.tree.filter(item => item.mode === '100755').map(item => item.path));
    const tree = await this.request<{ sha: string }>(record.password, 'POST', this.base(record) + '/git/trees', signal, {
      base_tree: base.tree.sha,
      tree: changes.map(change => change.content === null
        ? { path: change.path, mode: '100644', type: 'blob', sha: null }
        : { path: change.path, mode: change.executable || runnable.has(change.path) ? '100755' : '100644', type: 'blob', content: change.content }),
    });
    const commit = await this.request<{ sha: string }>(record.password, 'POST', this.base(record) + '/git/commits', signal, { message, tree: tree.sha, parents: [parent] });
    if (head) await this.request(record.password, 'PATCH', this.base(record) + '/git/refs/heads/' + segments(branch), signal, { sha: commit.sha, force: false });
    else await this.request(record.password, 'POST', this.base(record) + '/git/refs', signal, { ref: 'refs/heads/' + branch, sha: commit.sha });
    return commit.sha;
  }
  /** The latest pull request from a branch, whatever became of it: a person may have merged it already. */
  async findPull(record: Repo, branch: string, signal: AbortSignal): Promise<PullFacts | null> {
    const owner = record.fullName.split('/')[0]!;
    const data = await this.request<PullAnswer[]>(record.password, 'GET', this.base(record) + '/pulls?state=all&per_page=1&head=' + encodeURIComponent(owner + ':' + branch), signal);
    return data[0] ? pullFacts(data[0]) : null;
  }
  async openPull(record: Repo, branch: string, title: string, body: string, signal: AbortSignal): Promise<PullFacts> {
    const known = await this.findPull(record, branch, signal);
    if (known?.state === 'open') return known;
    return pullFacts(await this.request<PullAnswer>(record.password, 'POST', this.base(record) + '/pulls', signal, { title, body, head: branch, base: record.defaultBranch }));
  }
  private async checkRuns(record: Repo, sha: string, signal: AbortSignal): Promise<CheckResult[]> {
    const found: CheckResult[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.request<{ total_count: number; check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }> }>(record.password, 'GET', this.base(record) + '/commits/' + sha + '/check-runs?per_page=100&page=' + page, signal);
      found.push(...data.check_runs.map(run => ({ name: run.name, state: stateOf(run.status, run.conclusion), url: run.html_url ?? '' })));
      if (found.length >= data.total_count || !data.check_runs.length) return found;
    }
    return [...found, unreadable('More check runs than could be read')];
  }
  private async workflowRunsFor(record: Repo, sha: string, signal: AbortSignal): Promise<CheckResult[]> {
    const data = await this.request<{ total_count: number; workflow_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string }> }>(record.password, 'GET', this.base(record) + '/actions/runs?per_page=100&head_sha=' + sha, signal);
    const runs = data.workflow_runs.map(run => ({ name: run.name, state: stateOf(run.status, run.conclusion), url: run.html_url ?? '' }));
    return data.total_count > runs.length ? [...runs, unreadable('More workflow runs than could be read')] : runs;
  }
  private async statuses(record: Repo, sha: string, signal: AbortSignal): Promise<CheckResult[]> {
    const found: CheckResult[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.request<{ total_count: number; statuses: Array<{ context: string; state: string; target_url: string | null }> }>(record.password, 'GET', this.base(record) + '/commits/' + sha + '/status?per_page=100&page=' + page, signal);
      found.push(...data.statuses.map(item => ({ name: item.context, state: item.state === 'success' ? 'passed' as const : item.state === 'pending' ? 'pending' as const : 'failed' as const, url: item.target_url ?? '' })));
      if (found.length >= data.total_count || !data.statuses.length) return found;
    }
    return [...found, unreadable('More commit statuses than could be read')];
  }
  /**
   * Every automated result on a commit. Fine-grained tokens may not be able to list check runs, so Actions' own record
   * of its runs stands in for them. A status list with nothing in it reads "pending" at GitHub, so only its entries count.
   * Statuses that cannot be read at all count against the commit, or a failure there would simply go unseen.
   */
  async checks(record: Repo, sha: string, signal: AbortSignal): Promise<CheckResult[]> {
    let runs: CheckResult[];
    try { runs = await this.checkRuns(record, sha, signal); }
    catch (error) {
      if (!(error instanceof AccessError) || (error.status !== 403 && error.status !== 404)) throw error;
      runs = await this.workflowRunsFor(record, sha, signal);
    }
    try { return [...runs, ...await this.statuses(record, sha, signal)]; }
    catch (error) {
      if (!(error instanceof AccessError) || (error.status !== 403 && error.status !== 404)) throw error;
      return [...runs, unreadable('Commit statuses could not be read: the token needs Commit statuses, read')];
    }
  }
  async runs(record: Repo, branch: string, signal: AbortSignal): Promise<RunFacts[]> {
    const data = await this.request<{ workflow_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; head_sha: string; html_url: string }> }>(record.password, 'GET', this.base(record) + '/actions/runs?per_page=10&branch=' + encodeURIComponent(branch), signal);
    return data.workflow_runs.map(run => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion, sha: run.head_sha, url: run.html_url }));
  }
  async startWorkflow(record: Repo, workflow: string, branch: string, inputs: Inputs, signal: AbortSignal): Promise<number | null> {
    const data = await this.request<{ workflow_run_id?: number } | null>(record.password, 'POST', this.base(record) + '/actions/workflows/' + encodeURIComponent(workflow) + '/dispatches', signal, { ref: branch, inputs });
    return data?.workflow_run_id ?? null;
  }
  /** The end of the log of the job that failed, or of the last job if none did. */
  async runLog(record: Repo, runId: number, signal: AbortSignal) {
    const data = await this.request<{ jobs: Array<{ id: number; name: string; conclusion: string | null }> }>(record.password, 'GET', this.base(record) + '/actions/runs/' + runId + '/jobs?filter=latest&per_page=30', signal);
    const job = data.jobs.find(item => item.conclusion === 'failure') ?? data.jobs.at(-1);
    if (!job) throw new AccessError('That run has no jobs yet.', 404);
    // GitHub answers with a short-lived address on its storage. The token stops here: that address carries its own proof.
    const pointer = await fetch(this.api + this.base(record) + '/actions/jobs/' + job.id + '/logs', { redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]), headers: this.headers(record.password) });
    if (pointer.status >= 400) throw this.refused(pointer.status, '', pointer.headers.get('x-ratelimit-remaining') === '0');
    let response = pointer;
    const location = pointer.headers.get('location');
    if (location) {
      const target = new URL(location, this.api);
      if (target.origin !== new URL(this.api).origin) serviceURL(target.href);
      response = await fetch(target, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) });
      if (!response.ok) throw new AccessError('GitHub would not hand over that log.', 502);
    }
    return { job: job.name, conclusion: job.conclusion, log: (await tail(response, MAX_LOG_BYTES)).toString('utf8').slice(-MAX_LOG_CHARS) };
  }
}
