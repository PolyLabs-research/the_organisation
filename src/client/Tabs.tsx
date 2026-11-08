import { CircleCheck, CircleDashed, CirclePause, CircleX, ExternalLink, FileText, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { STANDARD_APPROACH, approachLabel } from '../shared/approaches';
import { describeWait, waitMet } from '../shared/waits';
import type {
  GateEvidence,
  ActivityEntry,
  BoardMessage,
  BoardMessageType,
  Decision,
  Organisation,
  Plan,
  PlanPhase,
  Task,
  WorkspaceFile,
} from '../shared/types';
import { api, useAction } from './api';
import { MESSAGE_LABEL, METHOD, PLAN_ACTION, PLAN_STATUS, RUN_STATUS, SESSION_STATE, STANCE } from './labels';
import { Empty, Markdown, SeatBadge, Sop, clock, duration, money, seatFor, seatName, tokens } from './ui';

// ---- Board ----

const FILTERS: Array<{ id: string; label: string; types: BoardMessageType[] | null }> = [
  { id: 'all', label: 'Everything', types: null },
  { id: 'direction', label: 'Direction', types: ['ceo_question', 'consult', 'direction'] },
  { id: 'plans', label: 'Plans', types: ['plan', 'review'] },
  { id: 'decisions', label: 'Decisions', types: ['decision'] },
  { id: 'reports', label: 'Reports', types: ['report', 'reaction'] },
  { id: 'steer', label: 'Steer', types: ['steer', 'steer_response'] },
  { id: 'signatory', label: 'Signing and paying', types: ['signatory'] },
];

export function Board({ org, onOpenPlan }: { org: Organisation; onOpenPlan: (planId: string) => void }) {
  const [filter, setFilter] = useState('all');
  const types = FILTERS.find((f) => f.id === filter)?.types ?? null;
  const messages = useMemo(() => {
    const list = types ? org.board.filter((m) => types.includes(m.type)) : org.board;
    return [...list].reverse();
  }, [org.board, types]);

  return (
    <div className="board">
      <div className="chips" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={`chip${filter === f.id ? ' is-on' : ''}`} onClick={() => setFilter(f.id)} aria-pressed={filter === f.id}>
            {f.label}
          </button>
        ))}
      </div>
      {messages.length === 0 ? (
        <Empty title={org.board.length ? 'Nothing of this kind yet.' : 'The board has not met yet.'}>
          {org.status === 'idle' ? 'Start the organisation and the CEO will open the first cycle.' : undefined}
        </Empty>
      ) : (
        <ol className="feed">
          {messages.map((m, i) => {
            const newCycle = i === 0 || messages[i - 1]!.cycle !== m.cycle;
            return (
              <li key={m.id}>
                {newCycle ? <div className="cycle-rule">Cycle {m.cycle}</div> : null}
                <Message org={org} message={m} onOpenPlan={onOpenPlan} />
              </li>
            );
          })}
        </ol>
      )}
      {filter === 'all' && org.history.length ? (
        <section className="history">
          <h2 className="section-title">Completed cycles</h2>
          {[...org.history].reverse().map((record) => (
            <details key={record.number} className="cycle-record">
              <summary>
                <strong>Cycle {record.number}</strong>
                <span className="muted clamp-1">{record.intent}</span>
              </summary>
              <span className="field-label">The shareholders wanted</span>
              <p>{record.intent}</p>
              <span className="field-label">Delivered</span>
              <Markdown>{record.summary}</Markdown>
            </details>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function Message({ org, message, onOpenPlan }: { org: Organisation; message: BoardMessage; onOpenPlan: (planId: string) => void }) {
  const livePlan = message.planId && org.plans.some((p) => p.id === message.planId);
  return (
    <article className={`msg msg-${message.type}`}>
      <SeatBadge seat={seatFor(org, message.fromId)} />
      <div className="msg-body">
        <header>
          <span className="msg-kind">{MESSAGE_LABEL[message.type]}</span>
          <h3>{message.title}</h3>
          <time dateTime={message.at}>{clock(message.at)}</time>
        </header>
        {/* What is asked of the signatory is acted on with money. It is shown as written, so that nothing in it can pass for a link. */}
        {message.type === 'signatory' ? <p className="pre-wrap">{message.body}</p> : <Markdown>{message.body}</Markdown>}
        {livePlan ? (
          <button type="button" className="link" onClick={() => onOpenPlan(message.planId!)}>
            Open the plan
          </button>
        ) : null}
      </div>
    </article>
  );
}

// ---- Plans ----

function TaskIcon({ status, held }: { status: Task['status']; held: boolean }) {
  if (status === 'done') return <CircleCheck size={16} className="icon-ok" aria-label="Done" />;
  if (status === 'failed') return <CircleX size={16} className="icon-bad" aria-label="Failed" />;
  // Part-way through in a session that is being held: it carries on when the session does.
  if (status === 'running' && held) return <CirclePause size={16} className="icon-idle" aria-label="Held with its session" />;
  if (status === 'running') return <LoaderCircle size={16} className="icon-run spin" aria-label="Running" />;
  return <CircleDashed size={16} className="icon-idle" aria-label="Queued" />;
}

function TaskRow({ orgId, task, held, onOpenFile }: { orgId: string; task: Task; held: boolean; onOpenFile: (path: string) => void }) {
  const [fetched, setFetched] = useState<Task | null>(null);
  const [loading, setLoading] = useState(false);
  const [nothing, setNothing] = useState(false);
  const shown = fetched ?? task;
  const load = () => {
    setLoading(true);
    api.task(orgId, task.id).then(
      (r) => {
        setFetched(r.task);
        setNothing(!r.task.result);
        setLoading(false);
      },
      () => setLoading(false),
    );
  };
  // An agent in a workflow run is given its work by the run, so what it was asked and what it returned are read on request.
  const inRun = !!task.threadId && task.agent === null;
  return (
    <li className="task">
      <details>
        <summary>
          <TaskIcon status={task.status} held={held && !!task.threadId} />
          <span className="task-title">{task.title}</span>
          {task.rework ? <span className="tag">Rework</span> : null}
          {task.agent ? <span className="agent-tag">Agent {task.agent}</span> : inRun ? <span className="agent-tag">In a run</span> : null}
        </summary>
        <div className="task-detail">
          <p className="field-label">Brief</p>
          <p className="pre-wrap">{shown.brief}</p>
          {task.error ? <p className="note note-bad">{task.error}</p> : null}
          {shown.result ? (
            <>
              <p className="field-label">Report to the lead</p>
              <Markdown>{shown.result}</Markdown>
              {task.resultTruncated && fetched === null ? (
                <button type="button" className="link" onClick={load} disabled={loading}>
                  {loading ? 'Loading…' : 'Read the whole report'}
                </button>
              ) : null}
            </>
          ) : task.threadId && task.status !== 'running' ? (
            nothing ? (
              <p className="muted">Nothing more could be read from the session for this agent.</p>
            ) : (
              <button type="button" className="link" onClick={load} disabled={loading}>
                {loading ? 'Reading from the session…' : inRun ? 'Read what it was asked and what it returned' : 'Read what it returned'}
              </button>
            )
          ) : null}
          {task.files.length ? (
            <ul className="file-links">
              {task.files.map((path) => (
                <li key={path}>
                  <button type="button" className="link" onClick={() => onOpenFile(path)}>
                    <FileText size={14} aria-hidden="true" /> {path}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </details>
    </li>
  );
}

/** The hosted session carrying out a plan: where it stands, what it has spent, and the workflow runs its lead started. */
function SessionBlock({ orgId, plan, simulated, onOpenFile }: { orgId: string; plan: Plan; simulated: boolean; onOpenFile: (path: string) => void }) {
  const archive = useAction();
  const [left, setLeft] = useState(false);
  const session = plan.managed;
  if (!session) return null;
  const live = plan.status === 'executing';
  const past = session.past ?? [];
  const over = plan.status === 'done' || plan.status === 'cancelled' || plan.status === 'failed';
  // What could be archived now: this plan's session once the plan is over, and any earlier session it lost.
  const open = (over && session.sessionId && !session.archivedAt ? 1 : 0) + past.filter((p) => !p.archivedAt).length;
  const state = live ? SESSION_STATE[session.state] : 'Finished';
  const tone = !live || session.state === 'finished' ? 'done' : session.state === 'running' || session.state === 'starting' ? 'live' : 'held';
  return (
    <div className="session">
      <div className="session-head">
        <span className="field-label">{simulated ? 'Hosted session (simulated)' : 'Hosted session'}</span>
        <span className={`status status-session-${tone}`}>{state}</span>
        {session.archivedAt ? <span className="tag">Archived {clock(session.archivedAt)}</span> : null}
        {session.consoleUrl ? (
          <a href={session.consoleUrl} target="_blank" rel="noreferrer">
            Watch it in the Anthropic Console <ExternalLink size={13} aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <dl className="session-facts">
        <div>
          <dt>Spent</dt>
          <dd className="num">
            {money(session.spentUsd)}
            {live && session.budgetUsd > 0 ? ` of a ${money(session.budgetUsd)} cap` : ''}
          </dd>
        </div>
        <div>
          <dt>Agents used</dt>
          <dd className="num">{session.agents.length}</dd>
        </div>
        {session.declined ? (
          <div>
            <dt>Tool calls declined</dt>
            <dd title={session.lastDeclined ?? undefined}>
              <span className="num">{session.declined}</span>
              {session.lastDeclined ? <span className="muted"> · last: {session.lastDeclined}</span> : null}
            </dd>
          </div>
        ) : null}
      </dl>
      {live && session.state === 'at_budget' ? (
        <p className="muted">The session has spent its share of the budget and waits there, intact. It carries on when the budget is raised or another plan finishes under its share.</p>
      ) : null}
      {live && session.state === 'paused' ? <p className="muted">The session is capped at what it has spent, so nothing in it can run until the organisation is resumed.</p> : null}
      {session.note && live ? (
        <p className="session-note">
          <span className="field-label">The lead’s latest note</span>
          {session.note}
        </p>
      ) : null}
      {session.runs.length ? (
        <>
          <span className="field-label">Workflow runs</span>
          <ul className="runs">
            {session.runs.map((run) => {
              // Nothing in a session that is held or at its cap can run, whatever was last heard of the run.
              const status = run.status === 'running' && tone !== 'live' ? (live ? 'paused' : 'stopped') : run.status;
              return (
                <li key={run.id}>
                  <div className="run-head">
                    <strong>{run.name}</strong>
                    <span className={`status status-run-${status}`}>{RUN_STATUS[status]}</span>
                    <span className="muted">
                      {plan.phases[run.phaseIndex]?.name ?? 'Plan'} phase · {run.agents} agent{run.agents === 1 ? '' : 's'}
                    </span>
                  </div>
                  {run.description ? <p className="muted">{run.description}</p> : null}
                  {run.steps.length ? (
                    <ol className="run-steps">
                      {run.steps.map((step) => (
                        <li key={step.id} className={`is-${step.status}`}>
                          {step.name}
                        </li>
                      ))}
                    </ol>
                  ) : null}
                  {run.error ? <p className="note note-bad">{run.error}</p> : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {past.length ? (
        <p className="muted">
          {past.length === 1 ? 'An earlier session of this plan was lost and replaced' : `${past.length} earlier sessions of this plan were lost and replaced`}
          {past.some((p) => p.archivedAt) ? ` (${past.filter((p) => p.archivedAt).length} archived)` : ''}.
        </p>
      ) : null}
      {open ? (
        <div className="session-archive">
          <button
            type="button"
            className="button"
            disabled={archive.busy}
            onClick={() =>
              void archive.run(async () => {
                const result = await api.archiveSession(orgId, plan.id);
                setLeft(result.left > 0);
              })
            }
          >
            {archive.busy ? 'Archiving…' : open === 1 ? 'Archive this session' : `Archive these ${open} sessions`}
          </button>
          <span className="muted">
            {left
              ? 'A session was still working and was left as it is. Try again in a moment.'
              : 'An archived session stays readable in the Console but can no longer be changed. This cannot be undone.'}
          </span>
          {archive.error ? <span className="note note-bad">{archive.error}</span> : null}
        </div>
      ) : null}
      {session.files.length ? (
        <details className="session-files">
          <summary>
            {session.files.length} file{session.files.length === 1 ? '' : 's'} brought home from the session
          </summary>
          <ul className="file-links">
            {session.files.map((path) => (
              <li key={path}>
                <button type="button" className="link" onClick={() => onOpenFile(path)}>
                  <FileText size={14} aria-hidden="true" /> {path}
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

const EVIDENCE_HEADING: Record<GateEvidence['state'], string> = { passed: 'Checked by the system', waiting: 'Waiting on the repository', failed: 'Not passed' };

/** A link from GitHub's own answer. Anything that is not a plain web address is shown as text. */
function Outward({ url, children }: { url: string; children: ReactNode }) {
  return /^https:\/\//.test(url) ? <a href={url} target="_blank" rel="noreferrer">{children}</a> : <>{children}</>;
}

/** What the system found at a gate, which is not what anyone reported. */
function GateResult({ evidence }: { evidence: GateEvidence }) {
  return (
    <div className={`gate-evidence gate-evidence-${evidence.state}`}>
      <span className="field-label">{EVIDENCE_HEADING[evidence.state]}</span>
      <p>{evidence.summary}</p>
      {evidence.checks.length ? (
        <ul className="gate-checks">
          {evidence.checks.map((check) => (
            <li key={check.name + check.url}>
              <Outward url={check.url}>{check.name}</Outward>
              <span className="muted">{check.state}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function PhaseBlock({ orgId, phase, index, held, waitsFor, onOpenFile }: { orgId: string; phase: PlanPhase; index: number; held: boolean; waitsFor: string[]; onOpenFile: (path: string) => void }) {
  const waiting = phase.status === 'working' && phase.evidence?.state === 'waiting';
  const state =
    phase.status === 'done'
      ? 'Passed'
      : waiting
        ? 'Waiting for checks'
        : phase.status === 'working'
          ? phase.reworkRounds
            ? 'Rework under way'
            : 'Under way'
          : waitsFor.length
            ? `Waits for ${waitsFor.join('; ')}`
            : 'Not started';
  return (
    <li className={`phase phase-${phase.status}`}>
      <header>
        <span className="phase-n">{index + 1}</span>
        <h4>{phase.name}</h4>
        <span className="muted">{state}</span>
      </header>
      <p className="muted">{phase.intent}</p>
      {phase.tasks.length ? (
        <ul className="tasks">
          {phase.tasks.map((task) => (
            <TaskRow key={task.id} orgId={orgId} task={task} held={held} onOpenFile={onOpenFile} />
          ))}
        </ul>
      ) : null}
      {phase.summary ? (
        <div className="gate">
          <span className="field-label">{phase.status === 'done' ? 'Gate review' : 'Sent back for rework'}</span>
          <Markdown>{phase.summary}</Markdown>
        </div>
      ) : null}
      {phase.evidence ? <GateResult evidence={phase.evidence} /> : phase.gate ? <p className="muted">The system checks this gate for itself, against the repository.</p> : null}
    </li>
  );
}

function PlanCard({ org, plan, open, simulated, onOpenFile }: { org: Organisation; plan: Plan; open: boolean; simulated: boolean; onOpenFile: (path: string) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const owner = seatFor(org, plan.ownerId);
  const report = org.reports.find((r) => r.id === plan.reportId);
  const done = plan.phases.filter((p) => p.status === 'done').length;
  const current = plan.status === 'executing' ? plan.phases.findIndex((p) => p.status !== 'done') : -1;
  const ended = plan.status === 'done' || plan.status === 'cancelled' || plan.status === 'failed';
  const held = !!plan.managed && plan.managed.state !== 'running' && plan.managed.state !== 'starting';

  useEffect(() => {
    if (open && ref.current) {
      ref.current.open = true;
      ref.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [open]);

  return (
    <details ref={ref} className={`plan plan-${plan.status}${open ? ' is-target' : ''}`} open={!ended || undefined}>
      <summary>
        <SeatBadge seat={owner} />
        <div className="plan-head">
          <h3>{plan.objective}</h3>
          <div className="plan-meta">
            <span className={`status status-plan-${ended ? plan.status : 'live'}`}>{PLAN_STATUS[plan.status]}</span>
            <span className="muted">{plan.origin.type === 'directive' ? 'CEO directive' : 'Follow-up to a board report'}</span>
            <span className="muted">{plan.priority} priority</span>
            {plan.execution === 'managed' ? <span className="tag">Hosted session</span> : null}
          </div>
          <Sop phases={plan.phases} done={done} current={current} compact />
        </div>
      </summary>
      <div className="plan-body">
        <dl className="facts">
          <dt>Success criteria</dt>
          <dd>{plan.successCriteria}</dd>
          <dt>Why</dt>
          <dd>{plan.rationale}</dd>
          {plan.approach ? (
            <>
              <dt>Approach</dt>
              <dd>{plan.approach}</dd>
            </>
          ) : null}
          {plan.workApproachId !== STANDARD_APPROACH ? (
            <>
              <dt>Work approach</dt>
              <dd>
                {approachLabel(plan.workApproachId)}
                {plan.workApproachReason ? `: ${plan.workApproachReason}` : ''}
              </dd>
            </>
          ) : null}
          {plan.code ? (
            <>
              <dt>Code</dt>
              <dd>
                <Outward url={plan.code.branchUrl}>{plan.code.repository}, {plan.code.branch}</Outward>
                {plan.code.pull ? <> · <Outward url={plan.code.pull.url}>pull request #{plan.code.pull.number}</Outward></> : null}
              </dd>
            </>
          ) : null}
        </dl>
        {plan.amendments.length ? (
          <div className="note note-warn">
            <div>
              <strong>Binding on this plan</strong>
              <ul>
                {plan.amendments.map((a, i) => (
                  <li key={i}>{a}</li>
                ))}
              </ul>
            </div>
          </div>
        ) : null}
        {plan.cancelReason ? (
          <div className="note note-bad">
            <span>
              <strong>Cancelled.</strong> {plan.cancelReason}
            </span>
          </div>
        ) : null}
        <SessionBlock orgId={org.id} plan={plan} simulated={simulated} onOpenFile={onOpenFile} />
        <ol className="phases">
          {plan.phases.map((phase, i) => (
            <PhaseBlock
              key={phase.sopPhaseId}
              orgId={org.id}
              phase={phase}
              index={i}
              held={held}
              waitsFor={phase.status === 'pending' ? (phase.waitsFor ?? []).filter((w) => !waitMet(org, w)).map((w) => describeWait(org, w)) : []}
              onOpenFile={onOpenFile}
            />
          ))}
        </ol>
        {report ? (
          <div className="report">
            <span className="field-label">Report to the board</span>
            <h4>{report.headline}</h4>
            <Markdown>{`${report.summary}\n\n${report.outcomes.map((o) => `- ${o}`).join('\n')}${report.asks.length ? `\n\n**Asks of the board**\n${report.asks.map((a) => `- ${a}`).join('\n')}` : ''}`}</Markdown>
          </div>
        ) : null}
      </div>
    </details>
  );
}

export function Plans({ org, target, simulated, onOpenFile }: { org: Organisation; target: string | null; simulated: boolean; onOpenFile: (path: string) => void }) {
  const cycles = [...new Set(org.plans.map((p) => p.cycle))].sort((a, b) => b - a);
  if (!org.plans.length) {
    return <Empty title="No plans yet.">Plans appear once the CEO has issued directives for the cycle.</Empty>;
  }
  return (
    <div className="plans">
      {cycles.map((cycle) => (
        <section key={cycle}>
          <div className="cycle-rule">Cycle {cycle}</div>
          {org.plans
            .filter((p) => p.cycle === cycle)
            .map((plan) => (
              <PlanCard key={plan.id} org={org} plan={plan} open={target === plan.id} simulated={simulated} onOpenFile={onOpenFile} />
            ))}
        </section>
      ))}
      {org.history.length > cycles.length ? <p className="muted">Plans from earlier cycles are in the organisation’s archive folder on disk.</p> : null}
    </div>
  );
}

// ---- Decisions ----

function Contested({ org, decision, onOpenPlan }: { org: Organisation; decision: Decision; onOpenPlan: (planId: string) => void }) {
  const outcome = decision.outcome;
  return (
    <article className={`decision${outcome ? '' : ' decision-open'}`}>
      <header>
        <h3>{decision.title}</h3>
        <span className={`status ${outcome ? `status-method-${outcome.method}` : 'status-plan-live'}`}>
          {outcome ? METHOD[outcome.method] : decision.status === 'deliberated' ? 'Awaiting sign-off' : 'The board is stating positions'}
        </span>
      </header>
      <p className="muted">
        Plan: {decision.context}{' '}
        {decision.planId && org.plans.some((p) => p.id === decision.planId) ? (
          <button type="button" className="link" onClick={() => onOpenPlan(decision.planId!)}>
            Open
          </button>
        ) : null}
      </p>
      <span className="field-label">Raised</span>
      <ul className="issues">
        {decision.issues.map((issue, i) => (
          <li key={i}>
            <SeatBadge seat={seatFor(org, issue.byId)} size="sm" />
            <span>
              {issue.concern} <em className="proposes">Proposes: {issue.proposal}</em>
            </span>
          </li>
        ))}
      </ul>
      {decision.participantIds.length ? (
        <>
          <span className="field-label">Positions</span>
          <ul className="positions">
            {decision.participantIds.map((id) => {
              const position = decision.positions[id];
              return (
                <li key={id}>
                  <SeatBadge seat={seatFor(org, id)} size="sm" />
                  {position ? (
                    <span>
                      <strong className={`stance stance-${position.stance}`}>{STANCE[position.stance]}.</strong> {position.argument}
                    </span>
                  ) : (
                    <span className="muted">Not yet given</span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
      {outcome ? (
        <div className="ruling">
          <span className="field-label">
            {outcome.method === 'consensus' ? `Ratified by the ${seatName(org, outcome.byId)}` : `Signed off by the ${seatName(org, outcome.byId)}`} · {PLAN_ACTION[outcome.planAction]}
          </span>
          <p>{outcome.ruling}</p>
          <p className="muted">{outcome.rationale}</p>
          {outcome.amendments.length ? (
            <ul>
              {outcome.amendments.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

export function Decisions({ org, onOpenPlan }: { org: Organisation; onOpenPlan: (planId: string) => void }) {
  const contested = org.decisions.filter((d) => d.kind === 'contested').reverse();
  const inRemit = org.decisions.filter((d) => d.kind === 'in_remit').reverse();
  if (!org.decisions.length) {
    return <Empty title="No decisions yet.">A lead decides what is inside their remit. Competing priorities go to the board for consensus and sign-off.</Empty>;
  }
  return (
    <div className="decisions">
      <section>
        <h2 className="section-title">Taken to the board</h2>
        {contested.length ? (
          contested.map((d) => <Contested key={d.id} org={org} decision={d} onOpenPlan={onOpenPlan} />)
        ) : (
          <p className="muted">No lead has had competing priorities with another so far.</p>
        )}
      </section>
      <section>
        <h2 className="section-title">Decided by a lead inside their remit</h2>
        {inRemit.length ? (
          <ul className="remit-list">
            {inRemit.map((d) => (
              <li key={d.id}>
                <SeatBadge seat={seatFor(org, d.raisedById)} size="sm" />
                <div>
                  <strong>{d.title}</strong>
                  <p>{d.outcome?.ruling}</p>
                  <p className="muted">{d.outcome?.rationale}</p>
                </div>
                <span className="muted num">Cycle {d.cycle}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None recorded yet.</p>
        )}
      </section>
    </div>
  );
}

// ---- Files ----

export function Files({ org, selected, onSelect }: { org: Organisation; selected: string | null; onSelect: (path: string | null) => void }) {
  const [files, setFiles] = useState<WorkspaceFile[] | null>(null);
  const [content, setContent] = useState<{ path: string; text: string; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Tasks finishing is what adds files, so refetch the list when that count moves.
  const doneTasks = org.plans.reduce((n, p) => n + (p.managed?.files.length ?? 0) + p.phases.reduce((m, ph) => m + ph.tasks.filter((t) => t.status === 'done').length, 0), 0);

  useEffect(() => {
    let live = true;
    api.files(org.id).then(
      (list) => live && setFiles(list),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [org.id, doneTasks]);

  useEffect(() => {
    if (!selected) {
      setContent(null);
      return;
    }
    let live = true;
    setError(null);
    api.file(org.id, selected).then(
      (f) => live && setContent({ path: f.path, text: f.content, truncated: f.truncated }),
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [org.id, selected]);

  const groups = useMemo(() => {
    const map = new Map<string, WorkspaceFile[]>();
    for (const file of files ?? []) {
      const team = file.path.includes('/') ? file.path.split('/')[0]! : '(root)';
      map.set(team, [...(map.get(team) ?? []), file]);
    }
    return [...map.entries()];
  }, [files]);

  if (files && files.length === 0) {
    return <Empty title="The workspace is empty.">Agents put their work products here as files. Every seat and agent can read them.</Empty>;
  }
  return (
    <div className="files">
      <nav className="file-tree" aria-label="Workspace files">
        {groups.map(([team, list]) => (
          <details key={team} open>
            <summary>
              {team} <span className="muted num">{list.length}</span>
            </summary>
            <ul>
              {list.map((file) => (
                <li key={file.path}>
                  <button type="button" className={selected === file.path ? 'is-on' : ''} onClick={() => onSelect(file.path)} title={file.path}>
                    {file.path.slice(team === '(root)' ? 0 : team.length + 1)}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        ))}
      </nav>
      <div className="file-view">
        {error ? <p className="note note-bad">{error}</p> : null}
        {content && content.path === selected ? (
          <>
            <header>
              <code>{content.path}</code>
              {content.truncated ? <span className="tag">Shortened for display</span> : null}
            </header>
            {/\.(md|markdown)$/i.test(content.path) ? <Markdown>{content.text}</Markdown> : <pre>{content.text}</pre>}
          </>
        ) : selected ? (
          error ? null : (
            <p className="muted">Loading…</p>
          )
        ) : (
          <p className="muted">Choose a file to read it.</p>
        )}
      </div>
    </div>
  );
}

// ---- Activity ----

export function ActivityLog({ org, activity, simulated }: { org: Organisation; activity: ActivityEntry[]; simulated: boolean }) {
  const rows = [...activity].reverse();
  const usage = org.usage;
  return (
    <div className="activity">
      <dl className="totals">
        <div>
          <dt>Model responses</dt>
          <dd className="num">{usage.calls}</dd>
        </div>
        <div>
          <dt>Tokens in</dt>
          <dd className="num">{tokens(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)}</dd>
        </div>
        <div>
          <dt>of which read from cache</dt>
          <dd className="num">{tokens(usage.cacheReadTokens)}</dd>
        </div>
        <div>
          <dt>Tokens out</dt>
          <dd className="num">{tokens(usage.outputTokens)}</dd>
        </div>
        <div>
          <dt>{simulated ? 'Simulated spend' : 'Estimated spend'}</dt>
          <dd className="num">{money(usage.costUsd)}</dd>
        </div>
      </dl>
      {rows.length === 0 ? (
        <Empty title="No calls yet in this session.">Each unit of work a seat or agent does is listed here with what it cost.</Empty>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Seat</th>
                <th>Work</th>
                <th className="r">In</th>
                <th className="r">Out</th>
                <th className="r">Cost</th>
                <th className="r">Took</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id + a.at} className={a.ok ? '' : 'row-bad'}>
                  <td className="num">{clock(a.at)}</td>
                  <td>{a.execId ? <SeatBadge seat={seatFor(org, a.execId)} size="sm" /> : null}</td>
                  <td>
                    {a.label}
                    {a.error ? <span className="row-error">{a.error}</span> : null}
                  </td>
                  <td className="r num">{tokens(a.inputTokens)}</td>
                  <td className="r num">{tokens(a.outputTokens)}</td>
                  <td className="r num">{money(a.costUsd)}</td>
                  <td className="r num">{duration(a.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
