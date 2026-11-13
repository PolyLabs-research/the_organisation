import { Bell, ChevronLeft, CircleCheck, CircleDashed, FileText, Hourglass, LoaderCircle, LocateFixed, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { MEMORY_KIND_LABEL } from '../shared/memory';
import { describeRequest, isOpen, waitsOnAi } from '../shared/signatory';
import type { Organisation, OrgView, Plan, Task } from '../shared/types';
import { api, useAction, type Meta } from './api';
import { Shareholders } from './Hierarchy';
import { MARK_WORDS } from './HeadquartersMap';
import { departmentId, type Alert, type Boardroom, type Department, type Dispatch, type Lamp, type Matter, type Room, type Scene, type Station } from './headquarters';
import { CEO_QUESTION_TEXT, EXECUTION, PLAN_STATUS, REQUEST_STATUS, SESSION_STATE, STAGES, STANCE } from './labels';
import { TaskIcon } from './Tabs';
import { ErrorNote, Markdown, SeatBadge, Stepper, clock, money, seatFor, seatName } from './ui';

// Beside the map: what the whole organisation needs and is doing, until something on the map is chosen, and then what
// is written there. It is also the map over again as a list, for whoever cannot use a map, or would rather not.

/** The tabs the headquarters leads on to, where the whole of a thing is. */
export type Elsewhere = 'board' | 'plans' | 'decisions' | 'signatory' | 'files' | 'memory' | 'calendar' | 'business';

export const SEVERITY: Record<Alert['severity'], { icon: LucideIcon; label: string }> = {
  you: { icon: Bell, label: 'Needs you' },
  trouble: { icon: TriangleAlert, label: 'Gone wrong' },
  held: { icon: Hourglass, label: 'Held up' },
};

const LAMP: Record<Lamp, string> = { working: 'At work', waiting: 'Waiting', done: 'Finished', idle: 'Nothing under way' };

export interface PanelProps {
  view: OrgView;
  scene: Scene;
  meta: Meta;
  selected: string | null;
  pane: 'overview' | 'dispatches';
  onPane: (pane: 'overview' | 'dispatches') => void;
  /** Choose something, and bring the map to it. Null lets go of what was chosen. */
  onSelect: (target: string | null) => void;
  /** Bring the map close to what is chosen. */
  onShow: (target: string) => void;
  steer: string;
  onSteer: (text: string) => void;
  onView: (view: OrgView) => void;
  onOpenTab: (tab: Elsewhere) => void;
  onOpenPlan: (planId: string) => void;
  onOpenFile: (path: string) => void;
}

function Section({ title, count, children }: { title: ReactNode; count?: number; children: ReactNode }) {
  return (
    <section className="hq-section">
      <h3>
        {title}
        {count ? <span className="count">{count}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function State({ lamp, children }: { lamp: Lamp; children: ReactNode }) {
  return (
    <p className={`hq-state is-${lamp}`}>
      <span className="hq-state-lamp" title={LAMP[lamp]}>
        {lamp === 'working' ? <span className="pulse" aria-hidden="true" /> : lamp === 'waiting' ? <Hourglass size={13} aria-hidden="true" /> : lamp === 'done' ? <CircleCheck size={13} aria-hidden="true" /> : <CircleDashed size={13} aria-hidden="true" />}
        {LAMP[lamp]}
      </span>
      {children}
    </p>
  );
}

/** How long something has been going on, counted on while it is shown. */
function Elapsed({ since }: { since: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(since)) / 1000));
  return (
    <time className="muted num" dateTime={since} title={`Since ${clock(since)}`}>
      {seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${seconds % 60} s`}
    </time>
  );
}

function AlertList({ alerts, onSelect }: { alerts: Alert[]; onSelect: (target: string) => void }) {
  return (
    <ul className="hq-alerts">
      {alerts.map((alert, i) => {
        const Icon = SEVERITY[alert.severity].icon;
        return (
          <li key={alert.title + i} className={`hq-alert is-${alert.severity}`}>
            <Icon size={15} aria-label={SEVERITY[alert.severity].label} />
            <div>
              <strong>{alert.title}</strong>
              {alert.detail ? <p className="muted clamp-3">{alert.detail}</p> : null}
              {alert.target ? (
                <button type="button" className="link" onClick={() => onSelect(alert.target!)}>
                  Show it
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Overview({ view, scene, onSelect, onPane }: Pick<PanelProps, 'view' | 'scene' | 'onPane'> & { onSelect: (target: string) => void }) {
  const { org, active, pace } = view;
  const of = (severity: Alert['severity']) => scene.alerts.filter((a) => a.severity === severity);
  const you = of('you');
  const trouble = of('trouble');
  const held = of('held');
  const home = (execId: string): string => {
    const seat = org.executives.find((e) => e.id === execId);
    return seat?.kind === 'lead' ? departmentId(seat.id) : seat?.kind === 'judge' ? 'judge' : seat?.kind === 'signatory' ? 'signatory' : 'ceo';
  };
  return (
    <>
      <Section
        title={
          <>
            <Bell size={14} aria-hidden="true" /> Needs you
          </>
        }
        count={you.length}
      >
        {you.length ? <AlertList alerts={you} onSelect={onSelect} /> : <p className="muted">Nothing is waiting for you.</p>}
      </Section>
      {trouble.length ? (
        <Section
          title={
            <>
              <TriangleAlert size={14} aria-hidden="true" /> Gone wrong
            </>
          }
          count={trouble.length}
        >
          <AlertList alerts={trouble} onSelect={onSelect} />
        </Section>
      ) : null}
      <Section title="At work now" count={active.length}>
        {active.length ? (
          <ul className="hq-list">
            {active.map((a) => (
              <li key={a.key}>
                <button type="button" className="hq-item" onClick={() => onSelect(a.kind === 'task' && a.agent ? `${home(a.execId)}/agent/${a.agent}` : home(a.execId))}>
                  <SeatBadge seat={seatFor(org, a.execId)} size="sm" />
                  <span className="grow">
                    {a.agent ? <span className="agent-tag">Agent {a.agent}</span> : null} {a.label}
                  </span>
                  <Elapsed since={a.startedAt} />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">
            {scene.situation.state === 'running'
              ? 'No call is in flight at the moment.'
              : scene.situation.state === 'waiting_schedule'
                ? 'Waiting for scheduled work or an incoming event. No model is called while it waits.'
                : scene.situation.state === 'waiting_step'
                  ? 'Nothing starts until you press Next step.'
                  : scene.situation.state === 'idle'
                    ? 'The organisation has not been started.'
                    : 'Paused. Nothing starts until it is resumed.'}
          </p>
        )}
        {org.status === 'running' && pace.next.length ? (
          <p className="muted hq-next">
            Next: {pace.next.slice(0, 3).map((n) => `${seatFor(org, n.execId).short} · ${n.label}`).join('; ')}
            {pace.next.length > 3 ? `; and ${pace.next.length - 3} more` : ''}
          </p>
        ) : null}
      </Section>
      {held.length ? (
        <Section
          title={
            <>
              <Hourglass size={14} aria-hidden="true" /> Held up
            </>
          }
          count={held.length}
        >
          <AlertList alerts={held} onSelect={onSelect} />
        </Section>
      ) : null}
      <Section title="Rooms">
        <ul className="hq-list">
          {scene.rooms.map((room) => (
            <li key={room.id}>
              <button type="button" className="hq-item" onClick={() => onSelect(room.id)}>
                <span className="hq-item-name">{room.title}</span>
                <span className="grow muted clamp-1">{room.line}</span>
              </button>
            </li>
          ))}
        </ul>
        <button type="button" className="link" onClick={() => onPane('dispatches')}>
          All dispatches
        </button>
      </Section>
    </>
  );
}

function Dispatches({ org, list, onSelect }: { org: Organisation; list: Dispatch[]; onSelect: (target: string) => void }) {
  if (!list.length) return <p className="muted">Nothing has happened yet. What is said at the board, and what agents finish, is listed here as it happens.</p>;
  return (
    <ol className="hq-list hq-dispatches">
      {list.map((d) => (
        <li key={d.id}>
          <button type="button" className={`hq-item is-${d.tone}`} onClick={() => onSelect(d.target)}>
            <SeatBadge seat={seatFor(org, d.seatId)} size="sm" />
            <span className="grow">
              <span className="hq-kind">{d.label}</span> {d.title}
            </span>
            <time className="muted num" dateTime={d.at}>
              {clock(d.at)}
            </time>
          </button>
        </li>
      ))}
    </ol>
  );
}

const STATION_ICON = (s: Station): ReactNode =>
  s.gate?.state === 'failed' || (s.status === 'working' && s.tasks.failed) ? (
    <TriangleAlert size={15} className="icon-bad" aria-label="Gone wrong" />
  ) : s.status === 'done' ? (
    <CircleCheck size={15} className="icon-ok" aria-label="Done" />
  ) : s.status === 'working' ? (
    <LoaderCircle size={15} className="icon-run" aria-label="Under way" />
  ) : (
    <CircleDashed size={15} className="icon-idle" aria-label="Not started" />
  );

function Stations({ stations, onSelect }: { stations: Station[]; onSelect: (target: string) => void }) {
  return (
    <ol className="hq-list">
      {stations.map((s) => (
        <li key={s.id}>
          <button type="button" className="hq-item" onClick={() => onSelect(s.id)}>
            {STATION_ICON(s)}
            <span className="hq-item-name">{s.name}</span>
            <span className="grow muted">{s.line}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function DepartmentPanel({ org, room, meta, onSelect, onOpenPlan, onView }: { org: Organisation; room: Department; meta: Meta; onSelect: (target: string) => void; onOpenPlan: (planId: string) => void; onView: (view: OrgView) => void }) {
  const change = useAction();
  const seat = org.executives.find((e) => e.id === room.seatId)!;
  return (
    <>
      <p className="muted clamp-3" title={seat.remit}>
        {seat.title}. {seat.remit}
      </p>
      <State lamp={room.lamp}>{room.line}</State>
      {room.lead.length ? (
        <Section title="The lead">
          <ul className="hq-plain">
            {room.lead.map((label, i) => (
              <li key={i}>{label}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Plan">
        {room.track ? (
          <>
            <button type="button" className="hq-item" onClick={() => onSelect(room.track!.id)}>
              <span className="grow">
                <span className={`status status-plan-${room.track.status === 'done' ? 'done' : room.track.status === 'cancelled' || room.track.status === 'failed' ? room.track.status : 'live'}`}>{room.track.label}</span> {room.track.objective}
              </span>
            </button>
            <Stations stations={room.track.stations} onSelect={onSelect} />
            {room.queued ? (
              <p className="muted">
                {room.queued} more plan{room.queued === 1 ? '' : 's'} queued.
              </p>
            ) : null}
            <button type="button" className="link" onClick={() => onOpenPlan(room.track!.planId)}>
              Open the plan
            </button>
          </>
        ) : (
          <p className="muted">No plan in progress. Every plan of this lead runs through {room.profile.join(' → ')}.</p>
        )}
      </Section>
      <Section title="Agents">
        <ul className="hq-list">
          {room.desks.map((desk) => (
            <li key={desk.id}>
              <button type="button" className="hq-item" onClick={() => onSelect(desk.id)}>
                <span className="agent-tag">Agent {desk.agent}</span>
                <span className={`grow${desk.busy ? '' : ' muted'}`}>{desk.busy ? (desk.label ?? 'Working') : 'Idle'}</span>
              </button>
            </li>
          ))}
        </ul>
        {room.beyond + room.inRuns ? (
          <p className="muted">
            {room.beyond + room.inRuns} more at work in the hosted session{room.inRuns ? `, ${room.inRuns} of them in workflow runs` : ''}.
          </p>
        ) : null}
        <div className="row">
          <span className="field-label">How many</span>
          <Stepper value={seat.agentCount} min={1} max={meta.limits.maxAgentsPerLead} disabled={change.busy} onChange={(count) => void change.run(async () => onView(await api.agents(org.id, seat.id, count)))} label={`agents for the ${seat.short}`} />
        </div>
        <ErrorNote onDismiss={change.clearError}>{change.error}</ErrorNote>
      </Section>
      <dl className="hq-facts">
        <div>
          <dt>Its agents work</dt>
          <dd>{EXECUTION[org.settings.execution].toLowerCase()}</dd>
        </div>
        <div>
          <dt>Spent by this lead and its agents</dt>
          <dd className="num">{money(room.spendUsd)}</dd>
        </div>
        {room.inbox ? (
          <div>
            <dt>Board reports to read</dt>
            <dd className="num">{room.inbox}</dd>
          </div>
        ) : null}
      </dl>
    </>
  );
}

function TaskBody({ task, onOpenFile }: { task: Task; onOpenFile: (path: string) => void }) {
  return (
    <>
      <span className="field-label">Brief</span>
      <p className="pre-wrap hq-long">{task.brief}</p>
      {task.error ? <p className="note note-bad">{task.error}</p> : null}
      {task.result ? (
        <>
          <span className="field-label">Report to the lead</span>
          <div className="hq-long">
            <Markdown>{task.result}</Markdown>
          </div>
          {task.resultTruncated ? <p className="muted">That is the start of it. The whole report is on the plan.</p> : null}
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
    </>
  );
}

function AgentPanel({ org, room, agent, onSelect, onOpenPlan, onOpenFile }: { org: Organisation; room: Department; agent: number; onSelect: (target: string) => void; onOpenPlan: (planId: string) => void; onOpenFile: (path: string) => void }) {
  const desk = room.desks.find((d) => d.agent === agent);
  const mine: Array<{ plan: Plan; index: number; task: Task }> = [];
  for (const plan of org.plans) if (plan.ownerId === room.seatId) for (const [index, phase] of plan.phases.entries()) for (const task of phase.tasks) if (task.agent === agent) mine.push({ plan, index, task });
  const current = desk?.taskId ? mine.find((m) => m.task.id === desk.taskId) : undefined;
  const last = mine.filter((m) => m.task.finishedAt).sort((a, b) => b.task.finishedAt!.localeCompare(a.task.finishedAt!))[0];
  const shown = current ?? (desk?.busy ? undefined : last);
  return (
    <>
      <State lamp={desk?.busy ? 'working' : 'idle'}>{desk?.busy ? (desk.label ?? 'Working') : last ? 'Idle since its last task' : 'Has not been given a task yet'}</State>
      {shown ? (
        <Section title={current ? 'Working on' : 'Last finished'}>
          <p className="hq-lede">
            <TaskIcon status={shown.task.status} held={false} /> <strong>{shown.task.title}</strong>
          </p>
          <button type="button" className="hq-item" onClick={() => onSelect(`${room.id}/phase/${shown.plan.id}/${shown.index}`)}>
            <span className="hq-item-name">{shown.plan.phases[shown.index]!.name}</span>
            <span className="grow muted clamp-1">{shown.plan.objective}</span>
          </button>
          <TaskBody task={shown.task} onOpenFile={onOpenFile} />
          <button type="button" className="link" onClick={() => onOpenPlan(shown.plan.id)}>
            Open the plan
          </button>
        </Section>
      ) : null}
      <dl className="hq-facts">
        <div>
          <dt>Tasks finished in the plans on record</dt>
          <dd className="num">{mine.filter((m) => m.task.status === 'done').length}</dd>
        </div>
      </dl>
    </>
  );
}

const GATE: Record<NonNullable<Plan['phases'][number]['gate']>, string> = {
  checks: 'The system checks this gate for itself: every automated check must pass on the plan’s latest commit.',
  pull_request: 'The system checks this gate for itself: a pull request must be open, with every automated check passing.',
  run: 'The system checks this gate for itself, by running the check the lead named in the sandbox.',
};

function PhasePanel({ org, room, plan, index, onSelect, onOpenPlan }: { org: Organisation; room: Department; plan: Plan; index: number; onSelect: (target: string) => void; onOpenPlan: (planId: string) => void }) {
  const phase = plan.phases[index]!;
  const station = room.track?.planId === plan.id ? room.track.stations[index] : undefined;
  const seats = org.executives.find((e) => e.id === room.seatId)?.agentCount ?? 0;
  return (
    <>
      <button type="button" className="hq-item" onClick={() => onSelect(`${room.id}/plan/${plan.id}`)}>
        <span className="hq-item-name">Phase {index + 1} of {plan.phases.length}</span>
        <span className="grow muted clamp-1">{plan.objective}</span>
      </button>
      <State lamp={phase.status === 'done' ? 'done' : phase.status === 'working' ? (phase.tasks.some((t) => t.status === 'running') ? 'working' : 'waiting') : 'idle'}>{station?.line ?? (phase.status === 'done' ? 'Done' : phase.status === 'working' ? 'Under way' : 'Not started')}</State>
      <p>{phase.intent || phase.purpose}</p>
      {phase.gate ? (
        <div className={`gate-evidence${phase.evidence ? ` gate-evidence-${phase.evidence.state}` : ''}`}>
          <span className="field-label">{phase.evidence ? (phase.evidence.state === 'passed' ? 'Checked by the system' : phase.evidence.state === 'failed' ? 'Not passed' : 'The system is checking') : 'Gate'}</span>
          <p>{phase.evidence?.summary ?? GATE[phase.gate]}</p>
          {phase.check ? <code className="hq-code">{phase.check.command}</code> : null}
        </div>
      ) : null}
      <Section title="Tasks" count={phase.tasks.length}>
        {phase.tasks.length ? (
          <ul className="hq-list">
            {phase.tasks.map((task) => {
              const desk = task.agent && task.agent <= seats ? `${room.id}/agent/${task.agent}` : null;
              const row = (
                <>
                  <TaskIcon status={task.status} held={false} />
                  <span className="grow">{task.title}</span>
                  {task.agent ? <span className="agent-tag">Agent {task.agent}</span> : null}
                </>
              );
              return (
                <li key={task.id}>
                  {desk ? (
                    <button type="button" className="hq-item" onClick={() => onSelect(desk)}>
                      {row}
                    </button>
                  ) : (
                    <span className="hq-item">{row}</span>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">{phase.status === 'pending' ? 'The lead hands out its tasks when the phase begins.' : 'No tasks.'}</p>
        )}
      </Section>
      {phase.summary ? (
        <Section title={phase.status === 'done' ? 'Gate review' : 'Sent back for rework'}>
          <div className="hq-long">
            <Markdown>{phase.summary}</Markdown>
          </div>
        </Section>
      ) : null}
      <button type="button" className="link" onClick={() => onOpenPlan(plan.id)}>
        Open the plan
      </button>
    </>
  );
}

function PlanPanel({ org, room, plan, onSelect, onOpenPlan }: { org: Organisation; room: Department; plan: Plan; onSelect: (target: string) => void; onOpenPlan: (planId: string) => void }) {
  const stations = room.track?.planId === plan.id ? room.track.stations : null;
  const report = plan.reportId ? org.reports.find((r) => r.id === plan.reportId) : undefined;
  return (
    <>
      <p>
        <span className={`status status-plan-${plan.status === 'done' ? 'done' : plan.status === 'cancelled' || plan.status === 'failed' ? plan.status : 'live'}`}>{PLAN_STATUS[plan.status]}</span>
        {plan.managed ? <span className="muted"> · session {SESSION_STATE[plan.managed.state].toLowerCase()}</span> : null}
      </p>
      <span className="field-label">It is done when</span>
      <p>{plan.successCriteria}</p>
      {room.track?.planId === plan.id && room.track.held.length ? <p className="note note-info">Waits for {room.track.held.join('; ')}.</p> : null}
      {plan.cancelReason ? <p className="note note-warn">{plan.cancelReason}</p> : null}
      <Section title="Phases">
        {stations ? (
          <Stations stations={stations} onSelect={onSelect} />
        ) : (
          <ol className="hq-plain">
            {plan.phases.map((phase, i) => (
              <li key={i}>
                {phase.name}: {phase.status === 'done' ? 'done' : phase.status === 'working' ? 'under way' : 'not started'}
              </li>
            ))}
          </ol>
        )}
      </Section>
      {plan.approach ? (
        <Section title="Approach">
          <div className="hq-long">
            <Markdown>{plan.approach}</Markdown>
          </div>
        </Section>
      ) : null}
      {plan.amendments.length ? (
        <Section title="Binding instructions">
          <ul className="hq-plain">
            {plan.amendments.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
        </Section>
      ) : null}
      {report ? (
        <Section title="Report to the board">
          <p className="hq-lede">
            <strong>{report.headline}</strong>
          </p>
          <div className="hq-long">
            <Markdown>{report.summary}</Markdown>
          </div>
        </Section>
      ) : null}
      <button type="button" className="link" onClick={() => onOpenPlan(plan.id)}>
        Open the plan
      </button>
    </>
  );
}

function MatterPanel({ org, matter, onSelect, onOpenTab, onOpenPlan }: { org: Organisation; matter: Matter; onSelect: (target: string) => void; onOpenTab: (tab: Elsewhere) => void; onOpenPlan: (planId: string) => void }) {
  const decision = matter.kind === 'decision' ? org.decisions.find((d) => `board/decision/${d.id}` === matter.id) : undefined;
  const round = matter.kind === 'round' ? org.reviewRounds.find((r) => `board/round/${r.id}` === matter.id) : undefined;
  return (
    <>
      <State lamp="waiting">{matter.line}</State>
      {decision ? (
        <>
          <div className="hq-long">
            <Markdown>{decision.context}</Markdown>
          </div>
          {decision.issues.length ? (
            <Section title="Objections">
              <ul className="hq-stack">
                {decision.issues.map((issue, i) => (
                  <li key={i}>
                    <SeatBadge seat={seatFor(org, issue.byId)} size="sm" />
                    <div>
                      <p>{issue.concern}</p>
                      <p className="muted">Proposes: {issue.proposal}</p>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
          <Section title="Positions">
            <ul className="hq-stack">
              {decision.participantIds.map((id) => (
                <li key={id}>
                  <SeatBadge seat={seatFor(org, id)} size="sm" />
                  <div>
                    {decision.positions[id] ? (
                      <>
                        <strong>{STANCE[decision.positions[id]!.stance]}</strong>
                        <p className="clamp-3">{decision.positions[id]!.argument}</p>
                      </>
                    ) : (
                      <p className="muted">Yet to answer</p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </Section>
        </>
      ) : null}
      {round ? (
        <Section title="Reviews">
          <ul className="hq-stack">
            {round.reviewerIds.map((id) => (
              <li key={id}>
                <SeatBadge seat={seatFor(org, id)} size="sm" />
                <div>
                  <strong>{MARK_WORDS[matter.marks[id] ?? 'awaited'].replace(/^./, (c) => c.toUpperCase())}</strong>
                  {(round.reviews[id] ?? []).map((objection, i) => (
                    <p key={i} className="clamp-3">
                      {objection.concern}
                    </p>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {matter.planIds.length ? (
        <Section title={matter.planIds.length === 1 ? 'The plan' : 'The plans'}>
          <ul className="hq-list">
            {matter.planIds.map((id) => {
              const plan = org.plans.find((p) => p.id === id);
              return plan ? (
                <li key={id}>
                  <button type="button" className="hq-item" onClick={() => onSelect(`${departmentId(plan.ownerId)}/plan/${plan.id}`)}>
                    <SeatBadge seat={seatFor(org, plan.ownerId)} size="sm" />
                    <span className="grow clamp-2">{plan.objective}</span>
                  </button>
                </li>
              ) : null;
            })}
          </ul>
        </Section>
      ) : null}
      <div className="row">
        <button type="button" className="link" onClick={() => onOpenTab(decision ? 'decisions' : 'board')}>
          {decision ? 'Open decisions' : 'Open the board'}
        </button>
        {decision?.planId ? (
          <button type="button" className="link" onClick={() => onOpenPlan(decision.planId!)}>
            Open the plan
          </button>
        ) : null}
      </div>
    </>
  );
}

function BoardPanel({ org, room, scene, onSelect, onOpenTab }: { org: Organisation; room: Boardroom; scene: Scene; onSelect: (target: string) => void; onOpenTab: (tab: Elsewhere) => void }) {
  const sitting = room.seats.filter((s) => s.label);
  return (
    <>
      <p className="muted">Where the leads check each other’s plans, and where what they disagree on is decided. Decisions are signed off by {org.settings.arbiter === 'judge' ? 'an independent judge' : 'the CEO'}.</p>
      <State lamp={room.lamp}>{room.line}</State>
      <Section title="Before the board" count={room.matters.length}>
        {room.matters.length ? (
          <ul className="hq-list">
            {room.matters.map((matter) => (
              <li key={matter.id}>
                <button type="button" className="hq-item" onClick={() => onSelect(matter.id)}>
                  <span className="grow">
                    <strong>{matter.title}</strong>
                    <span className="muted"> · {matter.line}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing. The board sits when a plan is drafted, or when leads disagree.</p>
        )}
      </Section>
      {sitting.length ? (
        <Section title="At the table now">
          <ul className="hq-stack">
            {sitting.map((s) => (
              <li key={s.seatId}>
                <SeatBadge seat={seatFor(org, s.seatId)} size="sm" />
                <p>{s.label}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Section title="Said lately">
        <Dispatches org={org} list={scene.dispatches.filter((d) => !d.id.startsWith('task:')).slice(0, 6)} onSelect={onSelect} />
      </Section>
      <div className="row">
        <button type="button" className="link" onClick={() => onOpenTab('board')}>
          Open the board
        </button>
        <button type="button" className="link" onClick={() => onOpenTab('decisions')}>
          Open decisions
        </button>
      </div>
    </>
  );
}

function OfficePanel({ view, room, scene, props }: { view: OrgView; room: Exclude<Room, Department | Boardroom>; scene: Scene; props: PanelProps }) {
  const { org } = view;
  const { onSelect, onOpenTab, onOpenFile } = props;
  const choose = (target: string) => onSelect(target);
  const doing = room.doing.length ? (
    <ul className="hq-plain">
      {room.doing.map((label, i) => (
        <li key={i}>{label}</li>
      ))}
    </ul>
  ) : null;

  if (room.kind === 'shareholders') {
    return (
      <>
        <State lamp={room.lamp}>{room.line}</State>
        <Shareholders org={org} onView={props.onView} draft={props.steer} onDraft={props.onSteer} />
      </>
    );
  }

  if (room.kind === 'ceo') {
    const leads = org.executives.filter((e) => e.kind === 'lead');
    const stage = STAGES.find((s) => s.id === org.cycle.stage);
    return (
      <>
        <p className="muted">Asks “{CEO_QUESTION_TEXT}”, then directs the leads.</p>
        <State lamp={room.lamp}>{room.line}</State>
        {doing}
        <dl className="hq-facts">
          <div>
            <dt>Cycle</dt>
            <dd className="num">{org.cycle.number}</dd>
          </div>
          <div>
            <dt>Stage</dt>
            <dd>{stage?.label}</dd>
          </div>
        </dl>
        {stage ? <p className="muted">{stage.detail}</p> : null}
        {org.cycle.intent ? (
          <Section title="The shareholders want">
            <p>{org.cycle.intent}</p>
            {org.cycle.priorities.length ? (
              <ol className="hq-plain hq-numbered">
                {org.cycle.priorities.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ol>
            ) : null}
          </Section>
        ) : null}
        <Section title="Proposals from the leads" count={leads.filter((l) => org.cycle.consults[l.id]).length}>
          <ul className="hq-stack">
            {leads.map((lead) => (
              <li key={lead.id}>
                <SeatBadge seat={lead} size="sm" />
                {org.cycle.consults[lead.id] ? <p className="clamp-3">{org.cycle.consults[lead.id]!.proposal}</p> : <p className="muted">Not in yet</p>}
              </li>
            ))}
          </ul>
        </Section>
        <button type="button" className="link" onClick={() => onOpenTab('board')}>
          Open the board
        </button>
      </>
    );
  }

  if (room.kind === 'signatory') {
    const open = org.signatory.requests.filter(isOpen);
    return (
      <>
        <p className="muted">Signs and pays, which nothing else here can. {org.settings.signatory === 'human' ? 'Held by you.' : 'Held by an AI; you carry out what it authorises.'}</p>
        <State lamp={room.lamp}>{room.line}</State>
        {doing}
        <Section title="Open requests" count={open.length}>
          {open.length ? (
            <ul className="hq-list">
              {open.map((r) => (
                <li key={r.id}>
                  <button type="button" className="hq-item" onClick={() => choose(`signatory/request/${r.id}`)}>
                    <SeatBadge seat={seatFor(org, r.fromId)} size="sm" />
                    <span className="grow">
                      {describeRequest(r)}
                      <span className="muted"> · {waitsOnAi(r, org.settings.signatory) ? 'with the AI signatory' : 'waiting for you'}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing has been asked for that is still open.</p>
          )}
        </Section>
        <button type="button" className="link" onClick={() => onOpenTab('signatory')}>
          Open Signatory, where you answer
        </button>
      </>
    );
  }

  if (room.kind === 'judge') {
    return (
      <>
        <p className="muted">Signs off the board’s decisions when leads have competing priorities, in place of the CEO.</p>
        <State lamp={room.lamp}>{room.line}</State>
        {doing}
        <button type="button" className="link" onClick={() => onOpenTab('decisions')}>
          Open decisions
        </button>
      </>
    );
  }

  if (room.kind === 'archive') {
    const uses = [...(org.memoryUses ?? [])].reverse().slice(0, 8);
    return (
      <>
        <p className="muted">Everything the organisation has reported, decided, planned and written, in every cycle. Leads are shown what bears on what they are about to do, and agents search it.</p>
        <State lamp={room.lamp}>{room.line}</State>
        <Section title="Put to use lately" count={uses.length}>
          {uses.length ? (
            <ul className="hq-stack">
              {uses.map((use, i) => (
                <li key={use.at + i}>
                  <SeatBadge seat={seatFor(org, use.seatId)} size="sm" />
                  <div>
                    <p>
                      {use.by === 'shown' ? 'Shown' : 'Searched'}: {use.about}
                    </p>
                    <p className="muted">{use.items.length ? use.items.map((item) => `${MEMORY_KIND_LABEL[item.kind]}: ${item.title}`).join(' · ') : 'It found nothing.'}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Not yet. In a first cycle there is little for it to offer.</p>
          )}
        </Section>
        <button type="button" className="link" onClick={() => onOpenTab('memory')}>
          Open Memory, and search it
        </button>
      </>
    );
  }

  if (room.kind === 'files') {
    const written: Array<{ path: string; at: string; by: string }> = [];
    for (const plan of org.plans) if (plan.cycle === org.cycle.number) for (const phase of plan.phases) for (const task of phase.tasks) for (const path of task.files) written.push({ path, at: task.finishedAt ?? task.startedAt ?? plan.updatedAt, by: plan.ownerId });
    const latest = [...new Map(written.sort((a, b) => a.at.localeCompare(b.at)).map((f) => [f.path, f])).values()].reverse().slice(0, 14);
    return (
      <>
        <p className="muted">The workspace: what the agents have written.</p>
        <State lamp={room.lamp}>{room.line}</State>
        <Section title="Written this cycle" count={latest.length}>
          {latest.length ? (
            <ul className="hq-list">
              {latest.map((file) => (
                <li key={file.path}>
                  <button type="button" className="hq-item" onClick={() => onOpenFile(file.path)}>
                    <SeatBadge seat={seatFor(org, file.by)} size="sm" />
                    <span className="grow hq-path">{file.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">Nothing yet.</p>
          )}
        </Section>
        <button type="button" className="link" onClick={() => onOpenTab('files')}>
          Open Files
        </button>
      </>
    );
  }

  // Operations: the commitments on the calendar.
  const jobs = org.business.jobs.filter((j) => j.status !== 'done' && j.status !== 'cancelled');
  return (
    <>
      <p className="muted">The commitments the organisation keeps from one cycle to the next: who owns each, and when it is due.</p>
      <State lamp={room.lamp}>{room.line}</State>
      <Section title="Open commitments" count={jobs.length}>
        {jobs.length ? (
          <ul className="hq-stack">
            {jobs.slice(0, 12).map((job) => (
              <li key={job.id}>
                <SeatBadge seat={seatFor(org, job.ownerId)} size="sm" />
                <div>
                  <p>{job.title}</p>
                  <p className="muted">
                    {job.status === 'review' ? 'To verify' : job.status === 'blocked' ? 'Blocked' : job.status === 'in_progress' ? 'Under way' : 'Open'}
                    {job.dueAt ? ` · due ${clock(job.dueAt)}` : ''}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">None.</p>
        )}
      </Section>
      <div className="row">
        <button type="button" className="link" onClick={() => onOpenTab('calendar')}>
          Open the calendar
        </button>
        <button type="button" className="link" onClick={() => onOpenTab('business')}>
          Open Business, where you verify
        </button>
      </div>
      {scene.situation.state === 'waiting_schedule' ? <p className="muted">The organisation is waiting for the next scheduled review, event or date.</p> : null}
    </>
  );
}

function RequestPanel({ org, id, onOpenTab, onOpenFile, onOpenPlan }: { org: Organisation; id: string; onOpenTab: (tab: Elsewhere) => void; onOpenFile: (path: string) => void; onOpenPlan: (planId: string) => void }) {
  const request = org.signatory.requests.find((r) => r.id === id)!;
  return (
    <>
      <p>
        <span className="status">{REQUEST_STATUS[request.status]}</span> <span className="muted">asked by the {seatName(org, request.fromId)}, {clock(request.raisedAt)}</span>
      </p>
      <dl className="hq-facts">
        {request.amount ? (
          <div>
            <dt>Amount</dt>
            <dd>{request.amount}</dd>
          </div>
        ) : null}
        {request.party ? (
          <div>
            <dt>{request.kind === 'payment' ? 'To' : 'With'}</dt>
            <dd>{request.party}</dd>
          </div>
        ) : null}
      </dl>
      {/* What is asked of the signatory is acted on with money. It is shown as written, so that nothing in it can pass for a link. */}
      <p className="pre-wrap hq-long">{request.detail}</p>
      {request.ruling ? (
        <p className="note note-info">
          The AI signatory {request.ruling.verdict}: {request.ruling.reason}
        </p>
      ) : null}
      {request.files.length ? (
        <ul className="file-links">
          {request.files.map((path) => (
            <li key={path}>
              <button type="button" className="link" onClick={() => onOpenFile(path)}>
                <FileText size={14} aria-hidden="true" /> {path}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row">
        <button type="button" className="button button-primary" onClick={() => onOpenTab('signatory')}>
          Answer it under Signatory
        </button>
        {request.planId && org.plans.some((p) => p.id === request.planId) ? (
          <button type="button" className="link" onClick={() => onOpenPlan(request.planId!)}>
            Open the plan
          </button>
        ) : null}
      </div>
    </>
  );
}

/** What a target names, and what to show for it. A thing that is no longer there is shown as the room it was in. */
function resolve(org: Organisation, scene: Scene, target: string): { title: string; kicker: string; shown: string; body: (props: PanelProps) => ReactNode } | null {
  const [roomId, kind, a, b] = target.split('/');
  const room = scene.rooms.find((r) => r.id === roomId);
  if (!room) return null;
  const whole = { title: room.kind === 'department' ? room.title : room.title, kicker: room.kind === 'department' ? room.short : '', shown: room.id };
  if (room.kind === 'department') {
    const plan = kind === 'plan' || kind === 'phase' ? org.plans.find((p) => p.id === a && p.ownerId === room.seatId) : undefined;
    if (kind === 'agent' && room.desks.some((d) => d.agent === Number(a))) {
      return { title: `Agent ${a}`, kicker: `${room.short} · ${room.title}`, shown: target, body: (p) => <AgentPanel org={org} room={room} agent={Number(a)} onSelect={p.onSelect} onOpenPlan={p.onOpenPlan} onOpenFile={p.onOpenFile} /> };
    }
    if (kind === 'phase' && plan?.phases[Number(b)]) {
      return { title: plan.phases[Number(b)]!.name, kicker: `${room.short} · phase`, shown: target, body: (p) => <PhasePanel org={org} room={room} plan={plan} index={Number(b)} onSelect={p.onSelect} onOpenPlan={p.onOpenPlan} /> };
    }
    if (kind === 'plan' && plan) {
      return { title: plan.objective, kicker: `${room.short} · plan`, shown: target, body: (p) => <PlanPanel org={org} room={room} plan={plan} onSelect={p.onSelect} onOpenPlan={p.onOpenPlan} /> };
    }
    return { ...whole, body: (p) => <DepartmentPanel org={org} room={room} meta={p.meta} onSelect={p.onSelect} onOpenPlan={p.onOpenPlan} onView={p.onView} /> };
  }
  if (room.kind === 'board') {
    const matter = kind ? room.matters.find((m) => m.id === target) : undefined;
    if (matter) return { title: matter.title, kicker: matter.kind === 'decision' ? 'Board · decision' : 'Board · review', shown: target, body: (p) => <MatterPanel org={org} matter={matter} onSelect={p.onSelect} onOpenTab={p.onOpenTab} onOpenPlan={p.onOpenPlan} /> };
    return { ...whole, body: (p) => <BoardPanel org={org} room={room} scene={scene} onSelect={p.onSelect} onOpenTab={p.onOpenTab} /> };
  }
  if (room.kind === 'signatory' && kind === 'request') {
    const request = org.signatory.requests.find((r) => r.id === a);
    if (request) return { title: describeRequest(request), kicker: 'Signing desk · request', shown: target, body: (p) => <RequestPanel org={org} id={request.id} onOpenTab={p.onOpenTab} onOpenFile={p.onOpenFile} onOpenPlan={p.onOpenPlan} /> };
  }
  return { ...whole, kicker: room.kind === 'ceo' || room.kind === 'signatory' || room.kind === 'judge' ? seatName(org, room.seatId ?? '') : '', body: (p) => <OfficePanel view={p.view} room={room} scene={scene} props={p} /> };
}

export function HeadquartersPanel(props: PanelProps) {
  const { view, scene, selected, pane, onPane, onSelect, onShow } = props;
  const found = selected ? resolve(view.org, scene, selected) : null;
  const choose = (target: string) => onSelect(target);
  return (
    <aside className="hq-panel" aria-label={found ? found.title : pane === 'dispatches' ? 'Dispatches' : 'The situation'}>
      <header className="hq-panel-head">
        {found || pane === 'dispatches' ? (
          <button
            type="button"
            className="link hq-back"
            onClick={() => {
              onSelect(null);
              onPane('overview');
            }}
          >
            <ChevronLeft size={14} aria-hidden="true" /> The situation
          </button>
        ) : null}
        {found?.kicker ? <span className="field-label">{found.kicker}</span> : null}
        <div className="hq-panel-title">
          <h2 className="clamp-3">{found ? found.title : pane === 'dispatches' ? 'Dispatches' : 'The situation'}</h2>
          {found ? (
            <button type="button" className="icon-button" aria-label="Show it on the map" title="Show it on the map" onClick={() => onShow(found.shown)}>
              <LocateFixed size={16} />
            </button>
          ) : null}
        </div>
      </header>
      <div className="hq-panel-body">
        {found ? found.body(props) : pane === 'dispatches' ? <Dispatches org={view.org} list={scene.dispatches} onSelect={choose} /> : <Overview view={view} scene={scene} onSelect={choose} onPane={onPane} />}
      </div>
    </aside>
  );
}
