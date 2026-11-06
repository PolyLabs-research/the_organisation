import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// A stand-in for GitHub's REST API, holding one repository in memory. It answers in the shapes the real API was seen to
// answer in (2026-11-06, read-only, on a public repository), and in those GitHub documents for what could not be tried.
// It refuses any request without the token it was given.

export interface FakeCheck { name: string; status: string; conclusion: string | null; html_url?: string; }
interface Commit { sha: string; tree: Map<string, string>; parents: string[]; message: string; }

export class FakeGitHub {
  server: Server;
  base = '';
  readonly token: string;
  readonly fullName: string;
  readonly refs = new Map<string, string>();
  readonly commits = new Map<string, Commit>();
  readonly trees = new Map<string, Map<string, string>>();
  readonly pulls: Array<{ number: number; branch: string; title: string; body: string; base: string; state?: string; merged_at?: string }> = [];
  /** File modes, for files that are not plain ones. */
  readonly modes = new Map<string, string>();
  /** Answer a workflow dispatch as older API versions do: 204, with no body. */
  dispatchNoContent = false;
  readonly calls: Array<{ method: string; path: string; body: unknown }> = [];
  readonly dispatches: Array<{ workflow: string; ref: string; inputs: unknown }> = [];
  /** Check runs and statuses by commit, or by the branch's latest commit under 'head'. */
  checks: FakeCheck[] = [];
  statuses: Array<{ context: string; state: string; target_url: string | null }> = [];
  runs: Array<{ id: number; name: string; status: string; conclusion: string | null; head_sha: string; head_branch: string; html_url: string }> = [];
  jobLog = 'line 1\nline 2\nError: the tests failed';
  /** Paths that answer 403 for this token, as a fine-grained token might. */
  denied: RegExp[] = [];
  canPush = true;
  private seq = 0;

  constructor(fullName = 'acme/website', token = 'github_pat_test_token_0123456789', files: { [path: string]: string } = { 'README.md': '# Website\n', 'src/app.ts': 'export const answer = 42;\n' }) {
    this.fullName = fullName;
    this.token = token;
    this.server = createServer((req, res) => void this.handle(req, res));
    const tree = new Map(Object.entries(files));
    this.trees.set('tree0', tree);
    const sha = this.nextSha();
    this.commits.set(sha, { sha, tree, parents: [], message: 'First' });
    this.refs.set('main', sha);
  }
  private nextSha(): string { return (++this.seq).toString(16).padStart(40, 'a'); }
  async listen(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
    this.base = 'http://127.0.0.1:' + (this.server.address() as AddressInfo).port;
    return this.base;
  }
  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
  /** What a branch holds, as files. */
  filesOn(branch: string): Map<string, string> | undefined {
    const sha = this.refs.get(branch);
    return sha ? this.commits.get(sha)?.tree : undefined;
  }
  private async body(req: IncomingMessage): Promise<any> {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(part as Buffer);
    return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : undefined;
  }
  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = new URL(req.url!, 'http://localhost');
    const path = decodeURIComponent(url.pathname);
    const send = (status: number, data?: unknown, headers: { [name: string]: string } = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(data === undefined ? undefined : JSON.stringify(data));
    };
    if (path === '/log-storage') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(req.headers.authorization ? 'THE TOKEN REACHED THE STORAGE ADDRESS' : this.jobLog); return; }
    const body = await this.body(req);
    this.calls.push({ method: req.method!, path: path + url.search, body });
    if (req.headers.authorization !== 'Bearer ' + this.token) return send(401, { message: 'Bad credentials' });
    if (req.headers['x-github-api-version'] !== '2026-03-10') return send(400, { message: 'Unsupported API version' });
    const root = '/repos/' + this.fullName;
    if (!path.startsWith(root)) return send(404, { message: 'Not Found' });
    const rest = path.slice(root.length);
    if (this.denied.some(pattern => pattern.test(rest))) return send(403, { message: 'Resource not accessible by personal access token' });
    const commitOf = (ref: string) => this.commits.get(this.refs.get(ref) ?? ref);
    let match: RegExpExecArray | null;

    if (req.method === 'GET' && rest === '') return send(200, { full_name: this.fullName, default_branch: 'main', private: true, html_url: 'https://github.com/' + this.fullName, permissions: { push: this.canPush } });
    if (req.method === 'GET' && (match = /^\/git\/ref\/heads\/(.+)$/.exec(rest))) {
      const sha = this.refs.get(match[1]!);
      return sha ? send(200, { ref: 'refs/heads/' + match[1], object: { sha, type: 'commit' } }) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'GET' && (match = /^\/git\/trees\/(.+)$/.exec(rest))) {
      const commit = commitOf(match[1]!.replace('tree-of-', ''));
      if (!commit) return send(404, { message: 'Not Found' });
      return send(200, { sha: commit.sha, truncated: false, tree: [...commit.tree].map(([p, content]) => ({ path: p, mode: this.modes.get(p) ?? '100644', type: 'blob', size: content.length, sha: 'x' })) });
    }
    if (req.method === 'GET' && (match = /^\/contents\/(.+)$/.exec(rest))) {
      const content = commitOf(url.searchParams.get('ref') ?? 'main')?.tree.get(match[1]!);
      return content === undefined ? send(404, { message: 'Not Found' }) : send(200, { type: 'file', encoding: 'base64', path: match[1], content: Buffer.from(content).toString('base64') });
    }
    if (req.method === 'GET' && (match = /^\/git\/commits\/(.+)$/.exec(rest))) {
      const commit = this.commits.get(match[1]!);
      return commit ? send(200, { sha: commit.sha, tree: { sha: 'tree-of-' + commit.sha } }) : send(404, { message: 'Not Found' });
    }
    if (req.method === 'POST' && rest === '/git/trees') {
      const parent = this.commits.get(String(body.base_tree).replace('tree-of-', ''))!;
      const tree = new Map(parent.tree);
      for (const entry of body.tree) {
        if (entry.sha === null) { if (!tree.delete(entry.path)) return send(422, { message: 'GitRPC::BadObjectState' }); }
        else { tree.set(entry.path, entry.content); this.modes.set(entry.path, entry.mode); }
      }
      const sha = 'tree' + ++this.seq;
      this.trees.set(sha, tree);
      return send(201, { sha });
    }
    if (req.method === 'POST' && rest === '/git/commits') {
      const sha = this.nextSha();
      this.commits.set(sha, { sha, tree: this.trees.get(body.tree)!, parents: body.parents, message: body.message });
      return send(201, { sha });
    }
    if (req.method === 'POST' && rest === '/git/refs') {
      const branch = String(body.ref).replace('refs/heads/', '');
      if (this.refs.has(branch)) return send(422, { message: 'Reference already exists' });
      this.refs.set(branch, body.sha);
      return send(201, { ref: body.ref, object: { sha: body.sha } });
    }
    if (req.method === 'PATCH' && (match = /^\/git\/refs\/heads\/(.+)$/.exec(rest))) {
      const head = this.refs.get(match[1]!);
      if (!body.force && !this.commits.get(body.sha)?.parents.includes(head!)) return send(422, { message: 'Update is not a fast forward' });
      this.refs.set(match[1]!, body.sha);
      return send(200, { object: { sha: body.sha } });
    }
    if (req.method === 'GET' && rest === '/pulls') {
      const owner = this.fullName.split('/')[0]!;
      const wanted = url.searchParams.get('state');
      const open = this.pulls.filter(pull => owner + ':' + pull.branch === url.searchParams.get('head') && (wanted === 'all' || (pull.state ?? 'open') === wanted)).reverse();
      return send(200, open.map(pull => ({ number: pull.number, state: pull.state ?? 'open', merged_at: pull.merged_at ?? null, html_url: 'https://github.com/' + this.fullName + '/pull/' + pull.number, head: { sha: this.refs.get(pull.branch) ?? 'gone' } })));
    }
    if (req.method === 'POST' && rest === '/pulls') {
      const pull = { number: this.pulls.length + 1, branch: body.head, title: body.title, body: body.body, base: body.base };
      this.pulls.push(pull);
      return send(201, { number: pull.number, state: 'open', merged_at: null, html_url: 'https://github.com/' + this.fullName + '/pull/' + pull.number, head: { sha: this.refs.get(pull.branch) } });
    }
    const page = <T,>(items: T[]) => {
      const size = Number(url.searchParams.get('per_page') ?? 30), number = Number(url.searchParams.get('page') ?? 1);
      return items.slice((number - 1) * size, number * size);
    };
    if (req.method === 'GET' && /^\/commits\/[^/]+\/check-runs$/.test(rest)) return send(200, { total_count: this.checks.length, check_runs: page(this.checks).map(check => ({ html_url: 'https://github.com/run', ...check })) });
    // As the real one does: "pending" for a commit with no statuses at all.
    if (req.method === 'GET' && /^\/commits\/[^/]+\/status$/.test(rest)) return send(200, { state: this.statuses.length ? 'success' : 'pending', total_count: this.statuses.length, statuses: page(this.statuses) });
    if (req.method === 'GET' && rest === '/actions/runs') {
      const sha = url.searchParams.get('head_sha'), branch = url.searchParams.get('branch');
      const runs = this.runs.filter(run => (!sha || run.head_sha === sha) && (!branch || run.head_branch === branch));
      return send(200, { total_count: runs.length, workflow_runs: page(runs) });
    }
    if (req.method === 'POST' && (match = /^\/actions\/workflows\/(.+)\/dispatches$/.exec(rest))) {
      this.dispatches.push({ workflow: match[1]!, ref: body.ref, inputs: body.inputs });
      return this.dispatchNoContent ? send(204) : send(200, { workflow_run_id: 9001, run_url: 'x', html_url: 'x' });
    }
    if (req.method === 'GET' && /^\/actions\/runs\/\d+\/jobs$/.test(rest)) return send(200, { total_count: 2, jobs: [{ id: 1, name: 'lint', conclusion: 'success' }, { id: 2, name: 'test', conclusion: 'failure' }] });
    if (req.method === 'GET' && /^\/actions\/jobs\/\d+\/logs$/.test(rest)) return send(302, undefined, { Location: this.base + '/log-storage?sig=short-lived' });
    send(404, { message: 'Not Found' });
  }
}
