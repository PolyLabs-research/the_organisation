import type { GateEvidence, Plan, PlanPhase } from '../../shared/types';
import { AccessError } from '../access-vault';
import { ProviderError } from '../providers/types';
import type { EngineContext } from './handlers';

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

/** Whether a phase's gate can pass. Null if it has nothing to check. Throws WaitingOnChecks while the answer is not in. */
export async function gateEvidence(ctx: EngineContext, plan: Plan, phase: PlanPhase): Promise<GateEvidence | null> {
  const gate = phase.gate;
  if (!gate) return null;
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
