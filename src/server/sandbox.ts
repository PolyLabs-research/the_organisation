import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { SANDBOX_DEFAULT_IMAGE, SANDBOX_DEFAULT_SECONDS, SANDBOX_MAX_SECONDS, imageName, type SandboxRun, type SandboxStatus } from '../shared/sandbox';
import type { AgentTool } from './providers/types';
import { WorkspaceError, type Workspace } from './workspace';

// Running what agents write, on this machine, where it can do no harm.
//
// Each command runs in a container of its own, started for it and gone when it ends. The container has no network
// unless the shareholders opened it, no capabilities, a root filesystem it cannot write to, limits on memory,
// processors, processes and time, and it runs as an ordinary user. Nothing of this machine's is mounted in it: the
// workspace's files are sent in as an archive, and what a command produces comes out only when an agent asks for a
// file by name, through the same checks as any other file an agent writes. What a plan's commands leave behind (the
// packages they installed, what they built) is kept in a volume that belongs to the plan and is removed with it.
//
// It is driven through the `docker` command, or one that takes the same arguments, and never through a shell: every
// argument is an argument, whatever is in it.

/** What a sandbox may use. A command that goes past one of these is stopped, and the agent is told which. */
export interface SandboxLimits {
  memoryMb: number;
  cpus: number;
  /** Processes and threads at one time. */
  processes: number;
  /** The room in /tmp, which is kept in memory and lost with the command. */
  tmpMb: number;
  /** All that a plan's commands may leave behind them. */
  workMb: number;
  /** How many commands run at one time, on the whole server. The rest wait their turn. */
  atOnce: number;
}
export const SANDBOX_LIMITS: SandboxLimits = { memoryMb: 2048, cpus: 2, processes: 512, tmpMb: 512, workMb: 4096, atOnce: 4 };

export interface SandboxOptions {
  /** The command that runs containers: docker, or one that takes the same arguments. */
  command?: string;
  /** Why code may not be run on this server at all, if it may not. */
  blocked?: string | null;
  limits?: Partial<SandboxLimits>;
  /** How often a running command is looked at: whether its work still stands, and how much it has written. */
  watchMs?: number;
  /** How long to wait for an image that has to be fetched. */
  pullMs?: number;
}

export class SandboxError extends Error {}

/** How much of a command's output is kept: the beginning, where the first thing went wrong, and the end, where it says how it came out. */
const OUTPUT_HEAD = 6_000;
const OUTPUT_TAIL = 14_000;
/** A file larger than this is not sent into a sandbox, or brought out of one. It is the most a workspace file can be. */
const MAX_FILE_BYTES = 25_000_000;
const MAX_SAVED_FILES = 50;
const MAX_SAVED_BYTES = 100_000_000;
/** The container stops itself this long after its time is up, in case nothing outside is left to stop it. */
const BACKSTOP_SECONDS = 10;
const LABEL = 'the-organisation';
const MARK = '@@org-sandbox';

// ---- an archive of files, as tar reads one ----

const BLOCK = 512;
const octal = (value: number, width: number) => Math.max(0, Math.floor(value)).toString(8).padStart(width - 1, '0') + '\0';
function tarHeader(name: Buffer, size: number, seconds: number, mode: number, type: string): Buffer {
  const header = Buffer.alloc(BLOCK);
  name.copy(header, 0, 0, Math.min(name.length, 100));
  header.write(octal(mode & 0o777, 8), 100, 'latin1');
  header.write(octal(0, 8), 108, 'latin1');
  header.write(octal(0, 8), 116, 'latin1');
  header.write(octal(size, 12), 124, 'latin1');
  header.write(octal(seconds, 12), 136, 'latin1');
  header.fill(0x20, 148, 156);
  header.write(type, 156, 'latin1');
  header.write('ustar\u000000', 257, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
  return header;
}
const padded = (bytes: Buffer) => (bytes.length % BLOCK ? Buffer.concat([bytes, Buffer.alloc(BLOCK - (bytes.length % BLOCK))]) : bytes);
/** One file as it goes into an archive. A name too long for the header goes ahead of it in an entry of its own, as GNU tar writes one: every tar a sandbox is likely to have reads that. */
export function tarFile(name: string, bytes: Buffer, modifiedMs: number, executable = false): Buffer {
  const raw = Buffer.from(name, 'utf8');
  const parts: Buffer[] = [];
  if (raw.length > 100) parts.push(tarHeader(Buffer.from('././@LongLink'), raw.length + 1, 0, 0o644, 'L'), padded(Buffer.concat([raw, Buffer.from([0])])));
  parts.push(tarHeader(raw, bytes.length, modifiedMs / 1000, executable ? 0o755 : 0o644, '0'), padded(bytes));
  return Buffer.concat(parts);
}
export const TAR_END = Buffer.alloc(BLOCK * 2);

// ---- what a command printed ----

/** Keeps the beginning and the end of what is printed, however much comes between. */
class Printed {
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  total = 0;
  add(chunk: Buffer): void {
    this.total += chunk.length;
    if (this.headBytes < OUTPUT_HEAD) {
      const take = chunk.subarray(0, OUTPUT_HEAD - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (!chunk.length) return;
    this.tail.push(chunk);
    this.tailBytes += chunk.length;
    while (this.tailBytes - this.tail[0]!.length >= OUTPUT_TAIL) this.tailBytes -= this.tail.shift()!.length;
  }
  read(): { text: string; dropped: number } {
    const tail = Buffer.concat(this.tail);
    const kept = tail.subarray(Math.max(0, tail.length - OUTPUT_TAIL));
    const dropped = this.total - this.headBytes - kept.length;
    const head = legible(Buffer.concat(this.head).toString('utf8'));
    return { text: dropped > 0 ? `${head}\n[… ${dropped} characters of output left out here …]\n${legible(kept.toString('utf8'))}` : legible(Buffer.concat([...this.head, kept]).toString('utf8')), dropped: Math.max(0, dropped) };
  }
}
/** What a terminal would have shown: colours and cursor movements taken out, and a line that was written over shown as it ended up. */
export function legible(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[@-Z\\-_]/g, '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.slice(line.lastIndexOf('\r') + 1))
    .join('\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\ufffd]/g, '');
}

// ---- the command that runs containers ----

interface Ran { code: number | null; stdout: Buffer; stderr: string; missing: boolean; timedOut: boolean; }
interface Run { args: string[]; input?: AsyncIterable<Buffer>; timeoutMs?: number; signal?: AbortSignal; onStdout?: (chunk: Buffer) => void; onStderr?: (text: string) => void; started?: (stop: () => void) => void; }

/** The first thing the container command said went wrong, without what it prints before every message. */
function complaint(stderr: string): string {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith(MARK) && !/^WARNING:/i.test(line) && !/^See '|^Run '/.test(line));
  return (lines[0] ?? '').replace(/^(docker|podman): /i, '').replace(/^Error response from daemon: /i, '').slice(0, 300);
}

/** What this server runs containers with, shared by every organisation on it. */
export class SandboxRuntime {
  readonly command: string;
  readonly limits: SandboxLimits;
  readonly watchMs: number;
  private readonly pullMs: number;
  private readonly blocked: string | null;
  private known: { at: number; status: SandboxStatus } | null = null;
  private asking: Promise<SandboxStatus> | null = null;
  /** Images that are here and have what a sandbox needs, and those being fetched. */
  private readonly images = new Map<string, Promise<void>>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(options: SandboxOptions = {}) {
    this.command = options.command?.trim() || 'docker';
    this.limits = { ...SANDBOX_LIMITS, ...options.limits };
    this.watchMs = options.watchMs ?? 5000;
    this.pullMs = options.pullMs ?? 15 * 60_000;
    this.blocked = options.blocked ?? null;
  }

  /** Run the container command with these arguments. It resolves however the command ends: only a caller knows what an exit code means. */
  exec(run: Run): Promise<Ran> {
    return new Promise((resolve) => {
      const out: Buffer[] = [];
      let stderr = '';
      let timedOut = false;
      let settled = false;
      const child = spawn(this.command, run.args, { stdio: [run.input ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
      const done = (code: number | null, missing = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        run.signal?.removeEventListener('abort', kill);
        resolve({ code, stdout: Buffer.concat(out), stderr, missing, timedOut });
      };
      const kill = () => { child.kill('SIGKILL'); };
      const timer = run.timeoutMs ? setTimeout(() => { timedOut = true; kill(); }, run.timeoutMs) : undefined;
      if (run.signal?.aborted) kill();
      else run.signal?.addEventListener('abort', kill, { once: true });
      child.on('error', (error: NodeJS.ErrnoException) => done(null, error.code === 'ENOENT' || error.code === 'EACCES'));
      child.on('close', (code) => done(code));
      child.stdout!.on('data', (chunk: Buffer) => (run.onStdout ? run.onStdout(chunk) : out.push(chunk)));
      child.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8');
        if (stderr.length < 64_000) stderr += text;
        run.onStderr?.(text);
      });
      run.started?.(kill);
      if (run.input && child.stdin) {
        const stdin = child.stdin;
        // The command may stop reading before everything has been written. That is its answer, and comes back as its exit code.
        stdin.on('error', () => {});
        void (async () => {
          try {
            for await (const chunk of run.input!) {
              if (stdin.destroyed) break;
              if (!stdin.write(chunk)) await new Promise<void>((next) => stdin.once('drain', next));
            }
          } catch { /* A file that could not be read ends the archive early: what was sent is still extracted, and the next command sends the rest. */ }
          stdin.end();
        })();
      }
    });
  }

  /** Whether code can be run here. Asked of the container service itself, and remembered for a little while. */
  status(fresh = false): Promise<SandboxStatus> {
    if (this.blocked) return Promise.resolve({ available: false, runtime: null, reason: this.blocked });
    if (!fresh && this.known && Date.now() - this.known.at < (this.known.status.available ? 60_000 : 10_000)) return Promise.resolve(this.known.status);
    this.asking ??= this.exec({ args: ['version', '--format', '{{.Server.Version}}'], timeoutMs: 8000 })
      .then((ran): SandboxStatus => {
        const name = this.command.split(/[\\/]/).pop()!.replace(/\.(exe|cmd|mjs|js)$/i, '');
        const named = name.charAt(0).toUpperCase() + name.slice(1);
        if (ran.missing) return { available: false, runtime: null, reason: `Running code needs Docker, and no ${this.command} command was found on this machine. Install Docker (or set ORG_SANDBOX_COMMAND to a command that takes the same arguments), and start it.` };
        const version = ran.stdout.toString('utf8').trim().split('\n')[0] ?? '';
        if (ran.code !== 0 || !version) return { available: false, runtime: null, reason: `${named} is installed, but its service did not answer${ran.timedOut ? ' in time' : complaint(ran.stderr) ? ` (${complaint(ran.stderr)})` : ''}. Start it, and code can be run.` };
        return { available: true, runtime: `${named} ${version}`.slice(0, 80), reason: null };
      })
      .then((status) => {
        this.known = { at: Date.now(), status };
        this.asking = null;
        return status;
      });
    return this.asking;
  }

  /**
   * Have an image here, fetching it the first time, and make sure it has the few tools a sandbox is run with. Every
   * organisation on the server that names the image waits on the same look at it, so it is nobody's to stop: one
   * whose work is stopped leaves off waiting, and the others, and its own next command, find the image here.
   */
  image(image: string): Promise<void> {
    const known = this.images.get(image);
    if (known) return known;
    const ready = (async () => {
      const here = await this.exec({ args: ['image', 'inspect', '--format', '{{.Id}}', image], timeoutMs: 20_000 });
      if (here.code !== 0) {
        const pulled = await this.exec({ args: ['pull', '--quiet', image], timeoutMs: this.pullMs });
        if (pulled.code !== 0) throw new SandboxError(`The sandbox's image, ${image}, is not on this machine and could not be fetched${pulled.timedOut ? ' in time' : complaint(pulled.stderr) ? `: ${complaint(pulled.stderr)}` : ''}.`);
      }
      const checked = await this.exec({ args: ['run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pull', 'never', '--log-driver', 'none', '--entrypoint', 'sh', image, '-c', NEEDS], timeoutMs: 60_000 });
      const lacking = checked.stdout.toString('utf8').trim();
      if (checked.code !== 0) throw new SandboxError(`The sandbox's image, ${image}, could not be started${complaint(checked.stderr) ? `: ${complaint(checked.stderr)}` : ''}.`);
      if (lacking) throw new SandboxError(`The sandbox's image, ${image}, has no ${lacking.split(/\s+/).join(', ')}, which a sandbox is run with. Choose an image that has a shell and the usual tools.`);
    })();
    this.images.set(image, ready);
    // One that failed is tried again the next time it is wanted: the service may have been away, or the name put right.
    ready.catch(() => this.images.delete(image));
    return ready;
  }

  /** Wait for a turn to run a command. Returns what gives the turn back. */
  async turn(signal?: AbortSignal): Promise<() => void> {
    if (this.running >= this.limits.atOnce) {
      await new Promise<void>((resolve, reject) => {
        const go = () => { signal?.removeEventListener('abort', leave); resolve(); };
        const leave = () => { this.waiting.splice(this.waiting.indexOf(go), 1); reject(new SandboxError('The work was stopped before the command had its turn.')); };
        this.waiting.push(go);
        signal?.addEventListener('abort', leave, { once: true });
      });
    } else this.running++;
    let given = false;
    return () => {
      if (given) return;
      given = true;
      // The turn goes straight to whoever is next, so the count stays as it is.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    };
  }
}

/** Wait for what others are waiting for too, for as long as this caller's own work stands. What is waited for goes on for the others. */
function whileWanted<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const leave = () => reject(new SandboxError('The work was stopped while it waited.'));
    if (signal.aborted) return leave();
    signal.addEventListener('abort', leave, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
  });
}

/** The tools a sandbox is run with. What is printed is what the image lacks. */
const NEEDS = 'for tool in tar timeout cat wc find sort du tr cut grep head rm mkdir chmod; do command -v "$tool" >/dev/null 2>&1 || printf "%s " "$tool"; done';

/**
 * What runs in the container around an agent's command. It is the same every time: the command, the folder and the
 * time come to it as arguments, and nothing an agent wrote is ever part of its text.
 *   $1 the folder, within the workspace's copy   $2 seconds before it stops itself   $3 the command
 *   $4 "files" if an archive follows   $5 "fresh" to empty the copy first
 * What it has to say for itself goes to the error stream, each line marked. Everything the command prints, on either
 * stream, goes to the output.
 */
const WRAPPER = `
W=/sandbox/work
say() { printf '${MARK} %s\\n' "$*" >&2; }
umask 022
if [ "$5" = fresh ]; then chmod -R u+rwX "$W" 2>/dev/null; rm -rf "$W" 2>/dev/null; fi
mkdir -p "$W" /sandbox/home 2>/dev/null || { say sync-failed the sandbox has nowhere to write; exit 97; }
if [ "$4" = files ]; then
  tar -xf - -C "$W" 2>/tmp/.sync || { say sync-failed "$(tr '\\n' ' ' < /tmp/.sync | cut -c1-300)"; exit 97; }
  if [ -f "$W/.org-sandbox-removed" ]; then
    while IFS= read -r gone; do [ -n "$gone" ] && rm -f -- "$W/$gone"; done < "$W/.org-sandbox-removed"
    rm -f -- "$W/.org-sandbox-removed"
  fi
fi
say synced
cd -- "$W/$1" 2>/dev/null || { say no-dir; exit 98; }
say started
timeout -s KILL "$2" sh -c "$3" </dev/null 2>&1
code=$?
for counted in /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory/memory.oom_control; do
  if [ -r "$counted" ] && grep -q '^oom_kill [1-9]' "$counted" 2>/dev/null; then say oom; break; fi
done
exit "$code"
`;

/**
 * What brings files out of a sandbox. Each is announced on a line of its own with its size, and then follows as it is:
 *   F <bytes> <path>   a file, whose bytes follow, and a new line after them
 *   B <bytes> <path>   one too big to bring out      N <path>   not a file      M   no more are taken
 *   $1 the most bytes one file may have   $2 the most files   the rest: what to bring out
 */
const BRING = `
cd /sandbox/work 2>/dev/null || exit 0
most=$1; left=$2; shift 2
nl='
'
emit() {
  case "$1" in *"$nl"*) return;; esac
  if [ -L "$1" ] || [ ! -f "$1" ]; then printf 'N %s\\n' "$1"; return; fi
  if [ "$left" -le 0 ]; then printf 'M\\n'; exit 0; fi
  size=$(wc -c < "$1" 2>/dev/null | tr -d ' ')
  case "$size" in ''|*[!0-9]*) printf 'N %s\\n' "$1"; return;; esac
  if [ "$size" -gt "$most" ]; then printf 'B %s %s\\n' "$size" "$1"; return; fi
  left=$((left - 1))
  printf 'F %s %s\\n' "$size" "$1"
  cat -- "$1"
  printf '\\n'
}
for wanted in "$@"; do
  if [ -d "$wanted" ] && [ ! -L "$wanted" ]; then
    find "$wanted" -type f | sort > /tmp/.found
    while IFS= read -r found; do emit "$found"; done < /tmp/.found
  else
    emit "$wanted"
  fi
done
`;

/** A workspace path as a sandbox is given it: within the workspace, and never an option to the command it is handed to. */
function within(workspace: Workspace, input: unknown): string {
  if (input === undefined || input === null || input === '' || input === '.' || input === './' || input === '/') return '';
  if (typeof input !== 'string' || /[\n\r]/.test(input)) throw new WorkspaceError('path must be one line of text');
  return workspace.normalise(input);
}

export interface RunSpec {
  command: string;
  /** Where to run it, as a workspace path. Empty for the top. */
  dir?: string;
  seconds?: number;
  /** Start the sandbox's copy again from the workspace, losing what earlier commands left. */
  fresh?: boolean;
  /** Who is running it: an agent at its task, or the system at a gate. */
  by?: 'gate';
}
export interface RunControl {
  signal: AbortSignal;
  /** Whether the work this is for still stands. Asked while the command runs. */
  active: () => boolean;
}
export interface RunResult extends SandboxRun {
  output: string;
  /** How many characters of output were left out of the middle. */
  dropped: number;
  /** What the agent should know beyond the output: why it was stopped, or why it could not be run. */
  note: string | null;
  /** For one that could not be run: true where that was because of what was asked (a folder that is not there), and not because of the sandbox. */
  asked?: boolean;
}
export interface Brought { saved: Array<{ path: string; bytes: number }>; skipped: Array<{ path: string; why: string }>; }

/** One organisation's sandboxes: a work volume for each plan that has run anything, and the commands run in them. */
export class OrgSandbox {
  /** What each plan's sandbox was last sent of the workspace, by path: its size and when it was changed. */
  private readonly sent = new Map<string, Map<string, string>>();
  /** The volumes that have been made ready since this server started. */
  private readonly prepared = new Set<string>();
  private readonly preparing = new Map<string, Promise<void>>();

  constructor(
    private readonly orgId: string,
    readonly runtime: SandboxRuntime,
    private readonly workspace: Workspace,
    private readonly settings: () => { image: string; network: boolean },
  ) {}

  /** Who commands run as: this server's own user where that is not root, so that nothing in a sandbox is root even inside it. */
  private readonly user = `${typeof process.getuid === 'function' && process.getuid() !== 0 ? process.getuid() : 1000}:${typeof process.getgid === 'function' && process.getgid() !== 0 ? process.getgid() : 1000}`;

  private volume(planId: string): string {
    return `theorg_${this.orgId}_${planId}`.replace(/[^A-Za-z0-9_.-]/g, '_');
  }
  private labels(planId: string): string[] {
    return ['--label', `${LABEL}=sandbox`, '--label', `${LABEL}.org=${this.orgId}`, '--label', `${LABEL}.plan=${planId}`];
  }
  private image(): string {
    const image = imageName(this.settings().image || SANDBOX_DEFAULT_IMAGE);
    if (!image) throw new SandboxError(`The sandbox image named in the settings, "${String(this.settings().image).slice(0, 80)}", is not a name an image can have.`);
    return image;
  }

  /** Whether this organisation's commands can reach the internet. */
  get open(): boolean {
    return this.settings().network;
  }

  /**
   * Find out whether code can be run for this organisation, and have its image here before the first command wants it:
   * fetching one can take minutes. Returns what stands in the way, or null.
   */
  async warm(): Promise<string | null> {
    const blocked = await this.unusable();
    if (blocked) return blocked;
    return this.runtime.image(this.image()).then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));
  }

  /** Why code cannot be run for this organisation now, or null if it can. */
  async unusable(): Promise<string | null> {
    const status = await this.runtime.status();
    if (!status.available) return status.reason;
    try { this.image(); } catch (error) { return (error as Error).message; }
    return null;
  }

  /** How every container is started, whatever it is for. Nothing here is an agent's to choose. */
  private confined(planId: string, name: string, options: { network: boolean; readOnly?: boolean; root?: boolean }): string[] {
    const { limits } = this.runtime;
    return [
      'run', '--rm', '--init', '--pull', 'never', '--name', name,
      '--network', options.network ? 'bridge' : 'none',
      '--read-only', '--tmpfs', `/tmp:rw,exec,nosuid,nodev,size=${limits.tmpMb}m,mode=1777`,
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--pids-limit', String(limits.processes), '--memory', `${limits.memoryMb}m`, '--memory-swap', `${limits.memoryMb}m`, '--cpus', String(limits.cpus),
      '--ulimit', 'nofile=4096:4096', '--ulimit', `fsize=${limits.workMb * 1024 * 1024}`,
      // The one container that is root is the one that makes a volume ready. It may change who owns a folder, and nothing else.
      ...(options.root ? ['--cap-add', 'CHOWN', '--cap-add', 'DAC_OVERRIDE'] : []),
      '--user', options.root ? '0:0' : this.user, '--hostname', 'sandbox', '--workdir', '/', '--log-driver', 'none',
      '--env', 'HOME=/sandbox/home', '--env', 'USER=sandbox', '--env', 'LOGNAME=sandbox', '--env', 'TMPDIR=/tmp', '--env', 'CI=1', '--env', 'TERM=dumb', '--env', 'NO_COLOR=1', '--env', 'LANG=C.UTF-8',
      ...this.labels(planId),
      // The one thing mounted: the plan's own volume. No folder of this machine's is ever given to a container.
      '--volume', `${this.volume(planId)}:/sandbox${options.readOnly ? ':ro' : ''}`,
      '--entrypoint', 'sh',
    ];
  }

  /** Make a plan's volume, once, and open it to the user commands run as. */
  private prepare(planId: string, image: string): Promise<void> {
    const volume = this.volume(planId);
    if (this.prepared.has(volume)) return Promise.resolve();
    let making = this.preparing.get(volume);
    if (!making) {
      making = (async () => {
        const made = await this.runtime.exec({ args: ['volume', 'create', ...this.labels(planId), volume], timeoutMs: 30_000 });
        if (made.code !== 0) throw new SandboxError(`The sandbox could not be given somewhere to work${complaint(made.stderr) ? `: ${complaint(made.stderr)}` : ''}.`);
        // The volume is root's when it is made, and is handed to the user commands run as. This is the one container that runs as root, and it
        // runs these words and no others. It is done again after a restart, for a volume that is already there, and must not mind that.
        const opened = await this.runtime.exec({ args: [...this.confined(planId, `theorg-prepare-${randomBytes(5).toString('hex')}`, { network: false, root: true }), image, '-c', 'mkdir -p /sandbox/work /sandbox/home && chown "$1" /sandbox /sandbox/work /sandbox/home', 'sandbox', this.user], timeoutMs: 60_000 });
        if (opened.code !== 0) throw new SandboxError(`The sandbox could not be made ready${complaint(opened.stderr) ? `: ${complaint(opened.stderr)}` : ''}.`);
        this.prepared.add(volume);
      })().finally(() => this.preparing.delete(volume));
      this.preparing.set(volume, making);
    }
    return making;
  }

  /** What of the workspace a plan's sandbox has not been sent, or has an older copy of, and what it still has that the workspace no longer does. */
  private async changes(planId: string): Promise<{ changed: Array<{ path: string; signature: string }>; removed: string[]; note: string | null }> {
    const before = this.sent.get(this.volume(planId)) ?? new Map<string, string>();
    const listed = await this.workspace.list();
    const now = new Map(listed.filter((file) => file.size <= MAX_FILE_BYTES && !/[\n\r]/.test(file.path)).map((file) => [file.path, `${file.size}:${file.modifiedAt}`]));
    const tooBig = listed.filter((file) => file.size > MAX_FILE_BYTES).map((file) => file.path);
    return {
      changed: [...now].filter(([path, signature]) => before.get(path) !== signature).map(([path, signature]) => ({ path, signature })),
      removed: [...before.keys()].filter((path) => !now.has(path)),
      note: tooBig.length ? `${tooBig.length === 1 ? `${tooBig[0]} is` : `${tooBig.length} files are`} too large to put in the sandbox, and ${tooBig.length === 1 ? 'is' : 'are'} not there.` : null,
    };
  }

  private async *archive(changed: Array<{ path: string }>, removed: string[], sent: string[]): AsyncGenerator<Buffer> {
    for (const { path } of changed) {
      // A file that has gone, or grown too large, since it was listed is passed over. The next command looks again.
      const file = await this.workspace.readBytes(path, MAX_FILE_BYTES).catch(() => null);
      if (!file) continue;
      sent.push(path);
      yield tarFile(path, file.bytes, file.modifiedMs, file.executable);
    }
    if (removed.length) yield tarFile('.org-sandbox-removed', Buffer.from(removed.join('\n') + '\n', 'utf8'), Date.now());
    yield TAR_END;
  }

  /** Stop a container by name, and go on asking until its command has ended: it may not have started yet when it is first told. */
  private stopper(name: string, ended: () => boolean, killClient: () => void): () => void {
    let stopping = false;
    return () => {
      if (stopping) return;
      stopping = true;
      void (async () => {
        for (let tries = 0; tries < 40 && !ended(); tries++) {
          await this.runtime.exec({ args: ['kill', name], timeoutMs: 10_000 });
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        // Nothing answers to the name. Letting go of the command at least gives the caller its answer: the container stops itself when its time is up.
        if (!ended()) killClient();
      })();
    };
  }

  /** Run a command in a plan's sandbox, on a copy of the workspace as it now is. It always answers: what went wrong is part of the answer. */
  async run(planId: string, spec: RunSpec, control: RunControl): Promise<RunResult> {
    const begun = Date.now();
    const at = new Date().toISOString();
    const command = spec.command.length > 500 ? spec.command.slice(0, 500) + ' …' : spec.command;
    let dir = '';
    const answer = (ended: RunResult['ended'], exitCode: number | null, output = '', dropped = 0, note: string | null = null): RunResult => ({ at, command, dir, ended, exitCode, ms: Date.now() - begun, output, dropped, note, ...(spec.by ? { by: spec.by } : {}) });
    const seconds = Math.min(SANDBOX_MAX_SECONDS, Math.max(1, Math.round(Number(spec.seconds) || SANDBOX_DEFAULT_SECONDS)));
    let give: (() => void) | null = null;
    try {
      dir = within(this.workspace, spec.dir);
    } catch (error) {
      return { ...answer('failed', null, '', 0, error instanceof WorkspaceError ? `The folder to run it in cannot be used: ${error.message}.` : 'The folder to run it in cannot be used.'), asked: true };
    }
    try {
      // Work that has been stopped starts nothing more, however quickly the command would have been over.
      if (control.signal.aborted || !control.active()) return answer('stopped', null, '', 0, 'It was not run: the work it was for had been stopped.');
      const blocked = await this.unusable();
      if (blocked) return answer('failed', null, '', 0, blocked);
      const image = this.image();
      const { network } = this.settings();
      await whileWanted(this.runtime.image(image), control.signal);
      give = await this.runtime.turn(control.signal);
      await this.prepare(planId, image);
      // Starting again means sending everything again, into a copy the command empties first.
      if (spec.fresh) this.sent.delete(this.volume(planId));
      const { changed, removed, note: left } = await this.changes(planId);
      const sending = changed.length > 0 || removed.length > 0;
      const sent: string[] = [];

      const name = `theorg-${randomBytes(8).toString('hex')}`;
      const printed = new Printed();
      let said = '';
      let closed = false;
      let why: 'timed_out' | 'stopped' | 'full' | null = null;
      let killClient = () => {};
      const stop = this.stopper(name, () => closed, () => killClient());
      const halt = (reason: NonNullable<typeof why>) => { why ??= reason; stop(); };
      const onAbort = () => halt('stopped');
      control.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => halt('timed_out'), seconds * 1000);
      let looking = false;
      const watch = setInterval(() => {
        if (!control.active()) return halt('stopped');
        if (looking || closed) return;
        looking = true;
        // How much the plan's commands have written, asked of the container itself. A command that fills the disk is stopped a few seconds in, not when its time is up.
        void this.runtime.exec({ args: ['exec', name, 'du', '-sk', '/sandbox'], timeoutMs: this.runtime.watchMs * 2 }).then((measured) => {
          looking = false;
          const kilobytes = Number(/^(\d+)/.exec(measured.stdout.toString('utf8'))?.[1]);
          if (Number.isFinite(kilobytes) && kilobytes / 1024 > this.runtime.limits.workMb) halt('full');
        });
      }, this.runtime.watchMs);
      const ran = await this.runtime.exec({
        args: [...this.confined(planId, name, { network }), ...(sending ? ['--interactive'] : []), image, '-c', WRAPPER, 'sandbox', dir, String(seconds + BACKSTOP_SECONDS), spec.command, sending ? 'files' : 'none', spec.fresh ? 'fresh' : 'kept'],
        ...(sending ? { input: this.archive(changed, removed, sent) } : {}),
        onStdout: (chunk) => printed.add(chunk),
        onStderr: (text) => { if (said.length < 64_000) said += text; },
        started: (kill) => { killClient = kill; if (control.signal.aborted) onAbort(); },
      }).finally(() => {
        closed = true;
        clearTimeout(timer);
        clearInterval(watch);
        control.signal.removeEventListener('abort', onAbort);
      });

      const marks = new Set(said.split('\n').filter((line) => line.startsWith(MARK + ' ')).map((line) => line.slice(MARK.length + 1).split(' ')[0]));
      // What reached the sandbox is remembered, so that the next command sends only what has changed since.
      if (marks.has('synced')) {
        const held = this.sent.get(this.volume(planId)) ?? new Map<string, string>();
        const signatures = new Map(changed.map((file) => [file.path, file.signature]));
        for (const path of sent) held.set(path, signatures.get(path)!);
        for (const path of removed) held.delete(path);
        this.sent.set(this.volume(planId), held);
      }
      const { text, dropped } = printed.read();
      const { limits } = this.runtime;
      const stopped = why as 'timed_out' | 'stopped' | 'full' | null;
      if (ran.missing) return answer('failed', null, '', 0, `The ${this.runtime.command} command could not be run.`);
      if (stopped === 'timed_out') return answer('timed_out', null, text, dropped, `It was stopped after ${seconds} seconds, which is all it was given. Nothing of it is still running. If it needs longer, say so with timeout_seconds, up to ${SANDBOX_MAX_SECONDS}.`);
      if (stopped === 'full') return answer('killed', null, text, dropped, `It was stopped because what this plan's commands have written came to more than the ${limits.workMb} MB a sandbox may hold. Delete what is not needed, or start again with fresh.`);
      if (stopped === 'stopped') return answer('stopped', null, text, dropped, 'It was stopped because the work it was for was stopped.');
      if (!marks.has('started')) {
        const sync = /@@org-sandbox sync-failed (.*)/.exec(said)?.[1]?.trim();
        if (marks.has('sync-failed')) return answer('failed', null, '', 0, `The workspace's files could not be put in the sandbox${sync ? ` (${sync})` : ''}. It may be full: start again with fresh.`);
        if (marks.has('no-dir')) return { ...answer('failed', null, '', 0, `There is no folder ${dir} in the workspace. Give dir as a folder that has files in it, or leave it out to run at the top.`), asked: true };
        return answer('failed', null, '', 0, `The sandbox could not be started${complaint(said) ? `: ${complaint(said)}` : ''}.`);
      }
      const starved = marks.has('oom');
      if (ran.code === 137 || ran.code === null) return answer('killed', null, text, dropped, starved ? `It was killed for using more memory than the ${limits.memoryMb} MB a sandbox may use.` : 'It was killed before it finished.');
      return answer('exited', ran.code, text, dropped, [starved ? `A process it started was killed for using more memory than the ${limits.memoryMb} MB a sandbox may use.` : null, left].filter(Boolean).join(' ') || null);
    } catch (error) {
      // Stopped while it waited: for the image to be looked at, for its turn, for its sandbox to be made ready. That is the work stopping,
      // and no failure of the sandbox's, so nothing is said to have gone wrong.
      if (control.signal.aborted || !control.active()) return answer('stopped', null, '', 0, 'It was stopped because the work it was for was stopped.');
      if (!(error instanceof SandboxError) && !(error instanceof WorkspaceError)) console.warn(`A sandbox command for ${this.orgId} failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
      return answer('failed', null, '', 0, error instanceof SandboxError || error instanceof WorkspaceError ? error.message : 'The sandbox could not run the command.');
    } finally {
      give?.();
    }
  }

  /** Bring files out of a plan's sandbox, as bytes. Nothing is written anywhere here: what becomes of them is the caller's to decide. */
  async bring(planId: string, paths: unknown[], signal: AbortSignal): Promise<{ files: Array<{ path: string; bytes: Buffer }>; skipped: Brought['skipped'] }> {
    const wanted = [...new Set(paths.map((given) => within(this.workspace, given)).filter(Boolean))].slice(0, MAX_SAVED_FILES);
    if (!wanted.length) throw new SandboxError('Name the files to bring out, as workspace paths.');
    const blocked = await this.unusable();
    if (blocked) throw new SandboxError(blocked);
    if (!this.prepared.has(this.volume(planId)) && !(await this.exists(planId))) throw new SandboxError('Nothing has been run in this plan’s sandbox yet, so there is nothing to bring out of it.');
    const image = this.image();
    await whileWanted(this.runtime.image(image), signal);
    const chunks: Buffer[] = [];
    let total = 0;
    const name = `theorg-${randomBytes(8).toString('hex')}`;
    const ran = await this.runtime.exec({
      args: [...this.confined(planId, name, { network: false, readOnly: true }), image, '-c', BRING, 'sandbox', String(MAX_FILE_BYTES), String(MAX_SAVED_FILES), ...wanted.map((path) => './' + path)],
      timeoutMs: 120_000,
      signal,
      onStdout: (chunk) => { total += chunk.length; if (total <= MAX_SAVED_BYTES + 1_000_000) chunks.push(chunk); },
    });
    if (ran.timedOut || signal.aborted) void this.runtime.exec({ args: ['kill', name], timeoutMs: 10_000 });
    if (ran.code !== 0) throw new SandboxError(`The files could not be brought out of the sandbox${ran.timedOut ? ' in time' : complaint(ran.stderr) ? `: ${complaint(ran.stderr)}` : ''}.`);
    if (total > MAX_SAVED_BYTES + 1_000_000) throw new SandboxError(`That is more than ${Math.round(MAX_SAVED_BYTES / 1_000_000)} MB at once. Bring out fewer files at a time.`);
    return parseBrought(Buffer.concat(chunks));
  }

  private async exists(planId: string): Promise<boolean> {
    const found = await this.runtime.exec({ args: ['volume', 'inspect', '--format', '{{.Name}}', this.volume(planId)], timeoutMs: 20_000 });
    return found.code === 0;
  }

  /** Stop whatever a plan has running and remove what its commands left. Safe to ask of a plan that never ran anything. */
  async release(planId: string): Promise<void> {
    const volume = this.volume(planId);
    this.sent.delete(volume);
    this.prepared.delete(volume);
    const running = await this.runtime.exec({ args: ['ps', '--quiet', '--filter', `label=${LABEL}.org=${this.orgId}`, '--filter', `label=${LABEL}.plan=${planId}`], timeoutMs: 20_000 });
    const ids = running.stdout.toString('utf8').split(/\s+/).filter((id) => /^[a-f0-9]+$/i.test(id));
    if (ids.length) await this.runtime.exec({ args: ['kill', ...ids], timeoutMs: 20_000 });
    for (let tries = 0; tries < 10; tries++) {
      const removed = await this.runtime.exec({ args: ['volume', 'rm', '--force', volume], timeoutMs: 30_000 });
      // A container that has just been killed still holds its volume for a moment.
      if (removed.code === 0 || !/in use/i.test(removed.stderr)) return;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  /** Remove what is left of plans that are over. `active` says which plans may still run something. */
  async sweep(active: (planId: string) => boolean): Promise<void> {
    if (!(await this.runtime.status()).available) return;
    const prefix = this.volume('');
    const listed = await this.runtime.exec({ args: ['volume', 'ls', '--quiet', '--filter', `label=${LABEL}.org=${this.orgId}`], timeoutMs: 20_000 });
    for (const volume of listed.stdout.toString('utf8').split(/\s+/).filter((name) => name.startsWith(prefix))) {
      const planId = volume.slice(prefix.length);
      if (!active(planId)) await this.release(planId);
    }
  }
}

/** Read what came out of a sandbox: each file announced on a line of its own, then its bytes. */
export function parseBrought(stream: Buffer): { files: Array<{ path: string; bytes: Buffer }>; skipped: Brought['skipped'] } {
  const files: Array<{ path: string; bytes: Buffer }> = [];
  const skipped: Brought['skipped'] = [];
  const clean = (path: string) => path.replace(/^\.\//, '');
  let at = 0;
  while (at < stream.length) {
    const end = stream.indexOf(0x0a, at);
    if (end < 0) break;
    const line = stream.subarray(at, end).toString('utf8');
    at = end + 1;
    if (line === 'M') { skipped.push({ path: '', why: `no more than ${MAX_SAVED_FILES} files are brought out at once` }); break; }
    const not = /^N (.+)$/.exec(line);
    if (not) { skipped.push({ path: clean(not[1]!), why: 'there is no such file in the sandbox' }); continue; }
    const big = /^B (\d+) (.+)$/.exec(line);
    if (big) { skipped.push({ path: clean(big[2]!), why: `it is ${big[1]} bytes; the most a file may be is ${MAX_FILE_BYTES}` }); continue; }
    const file = /^F (\d+) (.+)$/.exec(line);
    const size = Number(file?.[1]);
    // Anything else is not what was asked for: the files changed under the reading, or something printed where nothing should.
    if (!file || !Number.isSafeInteger(size) || at + size >= stream.length || stream[at + size] !== 0x0a) throw new SandboxError('The files changed while they were being brought out. Try again when nothing is writing them.');
    files.push({ path: clean(file[2]!), bytes: Buffer.from(stream.subarray(at, at + size)) });
    at += size + 1;
  }
  return { files, skipped };
}

// ---- what an agent is given ----

export interface SandboxToolOptions {
  planId: string;
  workspace: Workspace;
  signal: AbortSignal;
  active: () => boolean;
  /** A saved password or token, taken out of text. What a command prints must not be how one gets back to a model. */
  redact: (text: string) => string;
  /** Told each command as it ends, for the task's record of what was run. */
  ran: (run: SandboxRun) => void;
  /** Told each workspace path a file is brought out to, as the file tools tell of what they write. */
  wrote: (path: string) => void;
}

/** The tools a role that may run code is given: one to run a command, one to bring out what a command produced. */
export function sandboxTools(sandbox: OrgSandbox, options: SandboxToolOptions): AgentTool[] {
  const { planId, workspace, signal, active, redact } = options;
  const limits = sandbox.runtime.limits;
  const refuse = (why: string) => JSON.stringify({ error: why });
  const RunInput = z.object({
    command: z.string().min(1).max(4000).describe('The command, as you would type it in a shell. It is run with sh -c'),
    dir: z.string().max(400).optional().describe('The workspace folder to run it in, e.g. "engineering/app". Leave out to run at the top of the workspace'),
    timeout_seconds: z.number().int().min(1).max(SANDBOX_MAX_SECONDS).optional().describe(`How long it may run. ${SANDBOX_DEFAULT_SECONDS} if left out, ${SANDBOX_MAX_SECONDS} at most`),
    fresh: z.boolean().optional().describe('True to throw away everything earlier commands left in the sandbox and start again from the workspace as it is'),
  });
  const BringInput = z.object({ paths: z.array(z.string().max(400)).min(1).max(20).describe('Files or folders in the sandbox, as workspace paths, e.g. "engineering/app/report.txt"') });
  return [
    {
      name: 'run_command',
      description:
        `Run a command in the plan’s sandbox: a container on this machine that holds a copy of the workspace. Use it to run and test what you write. The copy is brought up to date with the workspace before each command, so write and change files with your file tools and then run them. What a command writes or installs stays in the sandbox for the plan’s later commands, and never reaches the workspace by itself: bring a file you want kept out with save_from_sandbox. ${sandbox.open ? 'The sandbox can reach the internet.' : 'The sandbox cannot reach the internet, so nothing can be downloaded or installed from it: use what the image has.'} A command may use ${limits.memoryMb} MB of memory, and nothing it starts keeps running after it ends. It returns the exit code and what was printed. An exit code other than 0 means the command failed: report what actually happened.`,
      schema: RunInput,
      async run(input) {
        if (!active() || signal.aborted) return refuse('This task is no longer active.');
        const given = RunInput.safeParse(input);
        if (!given.success) return refuse('Give the command to run, as text.');
        if (redact(given.data.command) !== given.data.command) return refuse('A command cannot contain a saved password or token.');
        const result = await sandbox.run(planId, { command: given.data.command, dir: given.data.dir, seconds: given.data.timeout_seconds, fresh: given.data.fresh }, { signal, active });
        const { output, dropped, note, asked, ...run } = result;
        options.ran(run);
        if (result.ended === 'failed') return refuse(note ?? 'The command could not be run.');
        return JSON.stringify({
          ...(result.ended === 'exited' ? { exitCode: result.exitCode } : { ended: result.ended }),
          seconds: Math.round(result.ms / 100) / 10,
          output: redact(output),
          ...(note ? { note } : {}),
        });
      },
    },
    {
      name: 'save_from_sandbox',
      description: `Bring files that a command produced in the sandbox into the workspace, at the same paths, where the rest of the organisation can read them. Name files, or a folder to bring every file in it. Bring out work products and results, not what a build can make again (installed packages, caches). No more than ${MAX_SAVED_FILES} files at once, none over ${Math.round(MAX_FILE_BYTES / 1_000_000)} MB.`,
      schema: BringInput,
      async run(input) {
        if (!active() || signal.aborted) return refuse('This task is no longer active.');
        const given = BringInput.safeParse(input);
        if (!given.success) return refuse('Name the files to bring out, as a list of workspace paths.');
        try {
          const { files, skipped } = await sandbox.bring(planId, given.data.paths, signal);
          const saved: Brought['saved'] = [];
          for (const file of files) {
            try {
              const written = await workspace.writeBytes(file.path, file.bytes);
              options.wrote(written.path);
              saved.push({ path: written.path, bytes: written.bytes });
            } catch (error) {
              skipped.push({ path: file.path, why: error instanceof WorkspaceError ? error.message : 'it could not be written to the workspace' });
            }
          }
          return JSON.stringify({ saved, ...(skipped.length ? { notSaved: skipped } : {}) });
        } catch (error) {
          return refuse(error instanceof SandboxError || error instanceof WorkspaceError ? error.message : 'The files could not be brought out of the sandbox.');
        }
      },
    },
  ];
}
