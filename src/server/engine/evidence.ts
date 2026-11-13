import { allows } from '../../shared/privileges';
import type { GateEvidence, Plan, PlanPhase } from '../../shared/types';
import { AccessError } from '../access-vault';
import { ProviderError } from '../providers/types';
import type { EngineContext } from './handlers';
import { execById, isPlanActive } from './state';

// What a gate finds for itself. A lead can send work back, but it cannot pass a phase that the repository says has not
// passed: this comes from GitHub, about the commit at the head of the plan's branch, whatever anyone has reported.

/** A gate is waiting on checks that are still running. No model has been called, and it is tried again later. */
export class WaitingOnChecks extends Error {}

export interface CheckTimes {
  /** How often a gate looks again. */
  pollMs: number;
  /** How long a commit may show no checks at all. They take a moment to appear after a push. */
  graceMs: number;
  /** How long a gate waits for running checks before calling that a failure. */
  waitMs: number;
}
export const CHECK_TIMES: CheckTimes = { pollMs: 20_000, graceMs: 3 * 60_000, waitMs: 30 * 60_000 };

function facts(plan: Plan, ctx: EngineContext) {
  return ctx.access.codeFacts(plan.code!, ctx.signal).catch((error: unknown) => {
    // GitHub having a bad moment is worth another try. A locked vault or a lost connection is for a person, and pauses.
    if (error instanceof AccessError && (error.status >= 500 || error.status === 429)) throw new ProviderError(error.message, 'unavailable', true);
    throw error;
  });
}

/** How much of what a check printed is kept with the gate: the end, where a test run says how it came out. */
const CHECK_OUTPUT_CHARS = 4000;
/** How long a check may run where the lead did not say. */
export const CHECK_SECONDS = 300;

/**
 * A gate the system checks by running something. The lead named the command when it handed the phase out, and the
 * system runs it here, in the plan's sandbox, on the workspace as the agents left it. It passes if the command exits
 * with 0, whatever anyone reported.
 */
async function runEvidence(ctx: EngineContext, plan: Plan, phase: PlanPhase): Promise<GateEvidence> {
  const at = new Date().toISOString();
  const check = phase.check;
  // The check as it is named in what was found: on one line, and without any saved password the lead's words for it held.
  const named = check?.command.trim() ? [{ name: ctx.access.withoutSecrets(check.command).replace(/\s+/g, ' ').trim().slice(0, 200), url: '' }] : [];
  const verdict = (state: 'passed' | 'failed', summary: string, output = '', final = false): GateEvidence => ({
    gate: 'run',
    state,
    sha: null,
    summary,
    checks: named.map((one) => ({ ...one, state })),
    waitedMs: 0,
    at,
    ...(output.trim() ? { output: output.slice(-CHECK_OUTPUT_CHARS) } : {}),
    ...(final ? { final: true } : {}),
  });
  if (!check || !named.length) return verdict('failed', 'No check was named for this gate, so nothing proves the work. Say which command proves it.');
  // The shareholders took the privilege back while the plan was under way. Nothing can be run for this role, so nothing can pass.
  if (!allows(ctx.org, plan.ownerId, 'run_code')) return verdict('failed', `The ${execById(ctx.org, plan.ownerId)?.short ?? plan.ownerId} role may no longer run code, so this gate cannot be checked.`, '', true);
  // Docker having stopped is for a person to put right, and is no mark against the plan: the organisation pauses and says so.
  const blocked = await ctx.sandbox.unusable();
  if (blocked) throw new ProviderError(`The ${phase.name} gate could not be checked. ${blocked}`, 'unavailable', true);
  // As for a command an agent runs: a saved password or token does not go into a sandbox, and one that is printed does not come back.
  if (ctx.access.withoutSecrets(check.command) !== check.command) return verdict('failed', 'The check contains a saved password or token, so it was not run. Name a check that needs none.');
  const seconds = check.seconds || CHECK_SECONDS;
  // Taking the privilege away stops a check that is running, as it stops every other command of the role's. The gate is then looked at again, and finds as much.
  const ran = await ctx.sandbox.run(plan.id, { command: check.command, dir: check.dir, seconds, by: 'gate' }, { signal: ctx.signal, active: () => !ctx.halting() && isPlanActive(plan) && allows(ctx.org, plan.ownerId, 'run_code') });
  const took = `${(ran.ms / 1000).toFixed(1)} s`;
  const printed = ctx.access.withoutSecrets(ran.output);
  const noted = ran.note ? ` ${ran.note}` : '';
  if (ran.ended === 'exited') return ran.exitCode === 0 ? verdict('passed', `The check passed: it exited with 0 after ${took}.${noted}`, printed) : verdict('failed', `The check failed: it exited with ${ran.exitCode} after ${took}.${noted}`, printed);
  if (ran.ended === 'timed_out') return verdict('failed', `The check did not finish in the ${seconds} seconds it was given, and was stopped.`, printed);
  if (ran.ended === 'killed') return verdict('failed', `The check did not run to its end. ${ran.note ?? 'It was killed before it finished.'}`, printed);
  // Stopped with the work: the gate has not been checked, and is checked when the work is taken up again.
  if (ran.ended === 'stopped') throw new ProviderError('The check was stopped with the work.', 'aborted', false);
  // It could not be run at all. A folder that is not there is the plan's to put right. Anything else is the sandbox's, and for a person.
  if (ran.asked) return verdict('failed', `The check could not be run. ${ran.note ?? ''}`.trim());
  throw new ProviderError(`The ${phase.name} gate could not be checked. ${ran.note ?? 'The sandbox could not run the check.'}`, 'unavailable', true);
}

/** Whether a phase's gate can pass. Null if it has nothing to check. Throws WaitingOnChecks while the answer is not in. */
export async function gateEvidence(ctx: EngineContext, plan: Plan, phase: PlanPhase): Promise<GateEvidence | null> {
  const gate = phase.gate;
  if (!gate) return null;
  if (gate === 'run') return runEvidence(ctx, plan, phase);
  // Before anything else: a locked vault means no tools were on offer, and that is for a person, not a mark against the plan.
  ctx.access.requireUnlocked();
  const at = new Date().toISOString();
  const verdict = (state: GateEvidence['state'], summary: string, sha: string | null = null, checks: GateEvidence['checks'] = [], waitedMs = 0): GateEvidence => ({ gate, state, sha, summary, checks, waitedMs, at });
  if (!plan.code?.sha) return verdict('failed', 'Nothing has been pushed for this plan.');

  const found = await facts(plan, ctx);
  if (!found.connected) return { ...verdict('failed', `${plan.code.repository} is no longer connected, so this gate cannot be checked. Connect it again, then ask for the work again.`), final: true };
  // A person has already done what the gates lead to.
  if (found.pull?.state === 'merged') return verdict('passed', `A person has merged pull request #${found.pull.number}.`, found.pull.sha);
  if (!found.sha) return verdict('failed', `Nothing is on the plan's branch, ${plan.code.branch}.`);
  const { sha, checks } = found;
  // A new commit starts the clock again, and time spent paused is not counted: a look after a pause adds no more than a few polls.
  const prior = phase.evidence?.state === 'waiting' && phase.evidence.sha === sha ? phase.evidence : null;
  const waited = prior ? prior.waitedMs + Math.min(Date.now() - new Date(prior.at).getTime(), 3 * ctx.checkTimes.pollMs) : 0;
  const wait = (summary: string): never => {
    phase.evidence = verdict('waiting', summary, sha, checks, waited);
    ctx.touch();
    throw new WaitingOnChecks(summary);
  };

  const failed = checks.filter((c) => c.state === 'failed');
  const pending = checks.filter((c) => c.state === 'pending');
  const proved = checks.filter((c) => c.state === 'passed');
  if (failed.length) return verdict('failed', `${failed.length} of ${checks.length} checks failed: ${failed.map((c) => c.name).join(', ')}.`, sha, checks, waited);
  if (pending.length) {
    if (waited < ctx.checkTimes.waitMs) wait(`Waiting for ${pending.length} of ${checks.length} checks to finish.`);
    return verdict('failed', `${pending.length} of ${checks.length} checks had not finished after ${Math.round(ctx.checkTimes.waitMs / 60_000)} minutes.`, sha, checks, waited);
  }
  if (!proved.length) {
    if (waited < ctx.checkTimes.graceMs) wait('Waiting for checks to start on the latest commit.');
    return verdict('failed', 'No automated check did any work on the latest commit, so nothing proves it works. The repository needs a workflow that runs on a push.', sha, checks, waited);
  }
  const passed = `${proved.length === checks.length ? `All ${checks.length}` : `${proved.length} of ${checks.length}`} checks passed on the latest commit${proved.length === checks.length ? '' : ', and the rest were skipped'}.`;
  if (gate === 'checks') return verdict('passed', passed, sha, checks, waited);
  if (found.pull?.state !== 'open') return verdict('failed', `${passed} No pull request is open for the branch.`, sha, checks, waited);
  return verdict('passed', `${passed} Pull request #${found.pull.number} is open for a person to review and merge.`, sha, checks, waited);
}
