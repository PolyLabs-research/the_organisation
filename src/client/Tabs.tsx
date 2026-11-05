import { CircleCheck, CircleDashed, CircleX, FileText, LoaderCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
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
import { api } from './api';
import { MESSAGE_LABEL, METHOD, PLAN_ACTION, PLAN_STATUS, STANCE } from './labels';
import { Empty, Markdown, SeatBadge, Sop, clock, duration, money, seatFor, seatName, tokens } from './ui';

// ---- Board ----

const FILTERS: Array<{ id: string; label: string; types: BoardMessageType[] | null }> = [
  { id: 'all', label: 'Everything', types: null },
  { id: 'direction', label: 'Direction', types: ['ceo_question', 'consult', 'direction'] },
  { id: 'plans', label: 'Plans', types: ['plan', 'review'] },
  { id: 'decisions', label: 'Decisions', types: ['decision'] },
  { id: 'reports', label: 'Reports', types: ['report', 'reaction'] },
  { id: 'steer', label: 'Steer', types: ['steer', 'steer_response'] },
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
        <Markdown>{message.body}</Markdown>
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

function TaskIcon({ status }: { status: Task['status'] }) {
  if (status === 'done') return <CircleCheck size={16} className="icon-ok" aria-label="Done" />;
  if (status === 'failed') return <CircleX size={16} className="icon-bad" aria-label="Failed" />;
  if (status === 'running') return <LoaderCircle size={16} className="icon-run spin" aria-label="Running" />;
  return <CircleDashed size={16} className="icon-idle" aria-label="Queued" />;
}

function TaskRow({ orgId, task, onOpenFile }: { orgId: string; task: Task; onOpenFile: (path: string) => void }) {
  const [full, setFull] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const loadFull = () => {
    setLoading(true);
    api.task(orgId, task.id).then(
      (r) => setFull(r.task.result),
      () => setLoading(false),
    );
  };
  return (
    <li className="task">
      <details>
        <summary>
          <TaskIcon status={task.status} />
          <span className="task-title">{task.title}</span>
          {task.rework ? <span className="tag">Rework</span> : null}
          {task.agent ? <span className="agent-tag">Agent {task.agent}</span> : null}
        </summary>
        <div className="task-detail">
          <p className="field-label">Brief</p>
          <p className="pre-wrap">{task.brief}</p>
          {task.error ? <p className="note note-bad">{task.error}</p> : null}
          {task.result ? (
            <>
              <p className="field-label">Report to the lead</p>
              <Markdown>{full ?? task.result}</Markdown>
              {task.resultTruncated && full === null ? (
                <button type="button" className="link" onClick={loadFull} disabled={loading}>
                  {loading ? 'Loading…' : 'Read the whole report'}
                </button>
              ) : null}
            </>
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

function PhaseBlock({ orgId, phase, index, onOpenFile }: { orgId: string; phase: PlanPhase; index: number; onOpenFile: (path: string) => void }) {
  const state = phase.status === 'done' ? 'Passed' : phase.status === 'working' ? (phase.reworkRounds ? 'Rework under way' : 'Under way') : 'Not started';
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
            <TaskRow key={task.id} orgId={orgId} task={task} onOpenFile={onOpenFile} />
          ))}
        </ul>
      ) : null}
      {phase.summary ? (
        <div className="gate">
          <span className="field-label">{phase.status === 'done' ? 'Gate review' : 'Sent back for rework'}</span>
          <Markdown>{phase.summary}</Markdown>
        </div>
      ) : null}
    </li>
  );
}

function PlanCard({ org, plan, open, onOpenFile }: { org: Organisation; plan: Plan; open: boolean; onOpenFile: (path: string) => void }) {
  const ref = useRef<HTMLDetailsElement>(null);
  const owner = seatFor(org, plan.ownerId);
  const report = org.reports.find((r) => r.id === plan.reportId);
  const done = plan.phases.filter((p) => p.status === 'done').length;
  const current = plan.status === 'executing' ? plan.phases.findIndex((p) => p.status !== 'done') : -1;
  const ended = plan.status === 'done' || plan.status === 'cancelled' || plan.status === 'failed';

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
        <ol className="phases">
          {plan.phases.map((phase, i) => (
            <PhaseBlock key={phase.sopPhaseId} orgId={org.id} phase={phase} index={i} onOpenFile={onOpenFile} />
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

export function Plans({ org, target, onOpenFile }: { org: Organisation; target: string | null; onOpenFile: (path: string) => void }) {
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
              <PlanCard key={plan.id} org={org} plan={plan} open={target === plan.id} onOpenFile={onOpenFile} />
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
  const doneTasks = org.plans.reduce((n, p) => n + p.phases.reduce((m, ph) => m + ph.tasks.filter((t) => t.status === 'done').length, 0), 0);

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
