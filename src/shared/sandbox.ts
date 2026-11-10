// Running what agents write. On this machine an agent could only read and write files: whether its code ran, or its
// tests passed, was whatever it said. A role that is allowed to can now run commands in a sandbox, a container with
// no way to the rest of the machine, and the system keeps its own note of what was run and how it ended.

/** The image a sandbox is started from where the shareholders have named no other: Node.js, with Python's standard library, git and the usual build tools. */
export const SANDBOX_DEFAULT_IMAGE = 'node:22-bookworm';

/** How long a command may run where the agent does not say, and the longest it may ask for, in seconds. */
export const SANDBOX_DEFAULT_SECONDS = 120;
export const SANDBOX_MAX_SECONDS = 900;

/** A registry with its port if it has one, a repository in lower case, and a tag or a digest, as `docker pull` takes them. */
const IMAGE = /^(?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;

/**
 * The name as an image's, or null where it could not be one. It is handed to a command as an argument of its own,
 * so it has to be a name and nothing else: one that began with a dash would be taken for an option.
 */
export function imageName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name.length <= 200 && IMAGE.test(name) ? name : null;
}

/** One command that was run in a sandbox, as the system saw it: what was run and how it ended. Never what an agent said of it. */
export interface SandboxRun {
  at: string;
  /** The command, cut short if it was long. */
  command: string;
  /** Where in the workspace's copy it was run. Empty for the top. */
  dir: string;
  /**
   * How it ended. exited: by itself, with `exitCode`. timed_out: stopped at its time limit. stopped: stopped because the
   * work was (a pause, a cancelled plan). killed: ended from outside, as a process that uses more memory than it may is.
   * failed: it could not be run at all.
   */
  ended: 'exited' | 'timed_out' | 'stopped' | 'killed' | 'failed';
  /** What the command exited with. Null unless it ended by itself. */
  exitCode: number | null;
  ms: number;
  /** For a command the system ran itself at a gate, and not an agent. */
  by?: 'gate';
}

/** Whether this server can run code in a sandbox, and if not, why not. */
export interface SandboxStatus {
  available: boolean;
  /** What would run the containers, as it names itself: "Docker 29.9.2". Null where none was found. */
  runtime: string | null;
  /** Why code cannot be run here, for a person to act on. Null where it can. */
  reason: string | null;
}

/** Whether a run shows that what it ran works: it ended by itself, with nothing to report. */
export const runPassed = (run: SandboxRun): boolean => run.ended === 'exited' && run.exitCode === 0;

/** How a run ended, in words. */
export function runOutcome(run: SandboxRun): string {
  if (run.ended === 'exited') return run.exitCode === 0 ? 'passed (exit 0)' : `failed (exit ${run.exitCode})`;
  if (run.ended === 'timed_out') return 'stopped at its time limit';
  if (run.ended === 'stopped') return 'stopped with the work';
  if (run.ended === 'killed') return 'killed, most likely for using more memory than the sandbox allows';
  return 'could not be run';
}

/** How a run reads in a line, wherever one is listed. */
export function describeRun(run: SandboxRun): string {
  const took = run.ms >= 1000 ? `${(run.ms / 1000).toFixed(1)} s` : `${run.ms} ms`;
  return `${run.command}${run.dir ? ` (in ${run.dir})` : ''}: ${runOutcome(run)}, ${took}`;
}
