import { Gavel, PenLine, Send } from 'lucide-react';
import { useRef, useState } from 'react';
import { waitingOnPerson, waitsOnAi } from '../shared/signatory';
import type { ActiveWork, Executive, Organisation, OrgView, Plan, Steer } from '../shared/types';
import { api, useAction, type Meta } from './api';
import { CEO_QUESTION_TEXT, PLAN_STATUS, SESSION_STATE } from './labels';
import { ErrorNote, SeatBadge, Sop, Stepper, clock, hueStyle, money } from './ui';

function isActive(plan: Plan): boolean {
  return plan.status !== 'done' && plan.status !== 'cancelled' && plan.status !== 'failed';
}

function Working({ label }: { label: string }) {
  return (
    <p className="working">
      <span className="pulse" aria-hidden="true" />
      {label}
    </p>
  );
}

/**
 * Where the shareholders steer from. `draft` and `onDraft` let whatever shows this keep a steer that is half written:
 * the same box is shown beside the tabs and in the headquarters, and what was typed in one is there in the other.
 */
export function Shareholders({ org, onView, draft, onDraft }: { org: Organisation; onView: (view: OrgView) => void; draft?: string; onDraft?: (text: string) => void }) {
  const [own, setOwn] = useState('');
  const text = draft ?? own;
  const setText = onDraft ?? setOwn;
  const send = useAction();
  // One steer is sent once. The button is out of use while a steer is on its way, but the shortcut is not a button, and
  // a key held down repeats: without this, each repeat that came before the page had drawn itself again sent the steer again.
  const sending = useRef(false);
  const submit = () => {
    if (send.busy || sending.current) return;
    sending.current = true;
    return send
      .run(async () => {
        onView(await api.steer(org.id, text.trim()));
        setText('');
      })
      .finally(() => (sending.current = false));
  };
  const steers = [...org.steers].reverse();
  const latest = steers.slice(0, 1);
  const earlier = steers.slice(1, 8);
  const renderSteer = (steer: Steer) => (
    <li key={steer.id}>
      <p>{steer.text}</p>
      {steer.status === 'new' ? (
        <span className="muted">
          {clock(steer.at)} · {org.status === 'running' ? 'With the CEO' : 'The CEO will take it up when the organisation runs'}
        </span>
      ) : (
        <p className="steer-reply">
          <strong>CEO:</strong> {steer.response}
        </p>
      )}
    </li>
  );
  return (
    <section className="tier tier-shareholders" aria-label="Shareholders">
      <header className="tier-head">
        <SeatBadge seat={{ short: 'You', hue: 40 }} />
        <div>
          <strong>Shareholders</strong>
          <p className="muted">Your steer is binding. The CEO enforces it.</p>
        </div>
      </header>
      <form
        className="steer-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void submit();
        }}
      >
        <textarea
          rows={2}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && text.trim()) void submit();
          }}
          placeholder="What do you want from the organisation now?"
          aria-label="Steer for the CEO"
        />
        <button type="submit" className="button button-primary" disabled={!text.trim() || send.busy}>
          <Send size={15} aria-hidden="true" /> Send steer
        </button>
      </form>
      <ErrorNote onDismiss={send.clearError}>{send.error}</ErrorNote>
      {latest.length ? <ul className="steers">{latest.map(renderSteer)}</ul> : null}
      {earlier.length ? (
        <details className="steers-earlier">
          <summary>
            {earlier.length} earlier steer{earlier.length === 1 ? '' : 's'}
          </summary>
          <ul className="steers">{earlier.map(renderSteer)}</ul>
        </details>
      ) : null}
    </section>
  );
}

function Ceo({ org, exec, active }: { org: Organisation; exec: Executive; active: ActiveWork[] }) {
  const mine = active.filter((a) => a.execId === exec.id);
  const leads = org.executives.filter((e) => e.kind === 'lead');
  const heard = leads.filter((l) => org.cycle.consults[l.id]).length;
  return (
    <section className="tier tier-ceo seat-card" style={hueStyle(exec.hue)} aria-label={exec.title}>
      <header className="tier-head">
        <SeatBadge seat={exec} size="lg" />
        <div>
          <strong>{exec.title}</strong>
          <p className="muted">Asks “{CEO_QUESTION_TEXT}”, then directs the leads.</p>
        </div>
      </header>
      {org.cycle.intent ? (
        <p className="intent">
          <span className="field-label">The shareholders want</span>
          {org.cycle.intent}
        </p>
      ) : org.status === 'idle' ? (
        <p className="muted">Waiting to be started.</p>
      ) : org.status === 'running' && org.business.waiting ? (
        <p className="muted">Waiting for scheduled work or an incoming event.</p>
      ) : org.cycle.stage === 'consult' ? (
        <p className="muted">
          {org.status !== 'running' && heard === 0
            ? `Cycle ${org.cycle.number} opens when the organisation is resumed.`
            : `Hearing from the leads: ${heard} of ${leads.length} proposals in.`}
        </p>
      ) : null}
      {mine.map((a) => (
        <Working key={a.key} label={a.label} />
      ))}
    </section>
  );
}

function Lead({
  org,
  exec,
  active,
  meta,
  onView,
  onOpenPlan,
}: {
  org: Organisation;
  exec: Executive;
  active: ActiveWork[];
  meta: Meta;
  onView: (view: OrgView) => void;
  onOpenPlan: (planId: string) => void;
}) {
  const change = useAction();
  const mine = active.filter((a) => a.execId === exec.id);
  const thinking = mine.filter((a) => a.kind !== 'task');
  const tasks = mine.filter((a) => a.kind === 'task');
  const plans = org.plans.filter((p) => p.ownerId === exec.id && isActive(p));
  const plan = plans.find((p) => p.status === 'executing') ?? plans[0];
  const done = plan ? plan.phases.filter((p) => p.status === 'done').length : 0;
  const current = plan && (plan.status === 'executing' || plan.status === 'reporting') ? plan.phases.findIndex((p) => p.status !== 'done') : -1;
  const spend = org.usageByExec[exec.id]?.costUsd ?? 0;
  const waiting = (org.inbox[exec.id] ?? []).length;
  // In a hosted session the agents work on Anthropic's side: who is busy is read from the plan, not from this machine's calls.
  const session = plan?.status === 'executing' && plan.execution === 'managed' ? plan.managed : null;
  const hosted = session?.state === 'running' ? plan!.phases.flatMap((p) => p.tasks).filter((t) => t.status === 'running' && t.threadId) : [];
  const own = hosted.filter((t) => t.agent !== null);
  const inRuns = hosted.length - own.length;
  const beyond = own.filter((t) => (t.agent ?? 0) > exec.agentCount).length;
  const busy = tasks.length + own.length - beyond;
  const openRuns = session?.state === 'running' ? session.runs.filter((r) => r.status === 'running') : [];

  return (
    <li className="seat-card" style={hueStyle(exec.hue)}>
      <header className="tier-head">
        <SeatBadge seat={exec} size="lg" />
        <div className="grow">
          <strong>{exec.title}</strong>
          <p className="muted clamp-2" title={exec.remit}>
            {exec.function}: {exec.remit}
          </p>
        </div>
        {spend > 0 ? (
          <span className="num muted" title="Estimated spend by this lead and its agents">
            {money(spend)}
          </span>
        ) : null}
      </header>

      {plan ? (
        <button type="button" className="plan-peek" onClick={() => onOpenPlan(plan.id)} title="Open this plan">
          <span className="plan-peek-status">
            {PLAN_STATUS[plan.status]}
            {session ? ` · session ${SESSION_STATE[session.state].toLowerCase()}` : ''}
            {plan.phases.some((p) => p.evidence?.state === 'waiting' && p.status === 'working') ? ' · waiting for checks' : ''}
            {plans.length > 1 ? ` · ${plans.length - 1} more queued` : ''}
          </span>
          <span className="clamp-2">{plan.objective}</span>
        </button>
      ) : (
        <p className="muted">
          {waiting ? `Reading ${waiting} board report${waiting === 1 ? '' : 's'}.` : org.cycle.stage === 'work' ? 'No plan in progress.' : 'Awaiting the CEO’s direction.'}
        </p>
      )}
      <Sop phases={plan?.phases ?? exec.phases} done={done} current={current} />
      {thinking.map((a) => (
        <Working key={a.key} label={a.label} />
      ))}

      <div className="agents">
        <span className="field-label">Agents</span>
        <ul className="agent-dots" aria-label={`${busy} of ${exec.agentCount} agents working`}>
          {Array.from({ length: exec.agentCount }, (_, i) => {
            const label = tasks.find((t) => t.agent === i + 1)?.label ?? own.find((t) => t.agent === i + 1)?.title;
            return (
              <li key={i} className={label ? 'is-busy' : ''} title={label ? `Agent ${i + 1}: ${label}` : `Agent ${i + 1}: idle`}>
                {i + 1}
              </li>
            );
          })}
        </ul>
        <Stepper
          value={exec.agentCount}
          min={1}
          max={meta.limits.maxAgentsPerLead}
          disabled={change.busy}
          onChange={(count) => void change.run(async () => onView(await api.agents(org.id, exec.id, count)))}
          label={`agents for the ${exec.short}`}
        />
      </div>
      {tasks.length || own.length ? (
        <ul className="agent-tasks">
          {tasks.map((t) => (
            <li key={t.key}>
              <span className="agent-tag">Agent {t.agent}</span> {t.label}
            </li>
          ))}
          {own.map((t) => (
            <li key={t.id}>
              <span className="agent-tag">Agent {t.agent}</span> {t.title}
            </li>
          ))}
        </ul>
      ) : null}
      {openRuns.map((run) => (
        <Working key={run.id} label={`Workflow run “${run.name}”: ${inRuns} agent${inRuns === 1 ? '' : 's'} at work`} />
      ))}
      {beyond ? (
        <p className="note note-warn">
          <span>
            The lead has {beyond} more agent{beyond === 1 ? '' : 's'} at work in its session than it was allocated. In a hosted session the allocation is an instruction to the lead; the
            session’s spend cap is the hard limit.
          </span>
        </p>
      ) : null}
      <ErrorNote onDismiss={change.clearError}>{change.error}</ErrorNote>
    </li>
  );
}

export function Hierarchy({
  view,
  meta,
  onView,
  onOpenPlan,
  onOpenSignatory,
  steer,
  onSteer,
}: {
  view: OrgView;
  meta: Meta;
  onView: (view: OrgView) => void;
  onOpenPlan: (planId: string) => void;
  onOpenSignatory: () => void;
  /** A steer that is half written, where it is kept by whatever shows this. */
  steer?: string;
  onSteer?: (text: string) => void;
}) {
  const { org, active } = view;
  const ceo = org.executives.find((e) => e.kind === 'ceo')!;
  const judge = org.executives.find((e) => e.kind === 'judge');
  const leads = org.executives.filter((e) => e.kind === 'lead');
  const judging = judge ? active.filter((a) => a.execId === judge.id) : [];
  const signatory = org.executives.find((e) => e.kind === 'signatory');
  const deciding = signatory ? active.filter((a) => a.execId === signatory.id) : [];
  const waiting = waitingOnPerson(org).length;
  const withAi = org.signatory.requests.filter((r) => waitsOnAi(r, org.settings.signatory)).length;
  return (
    <div className="hierarchy">
      <Shareholders org={org} onView={onView} draft={steer} onDraft={onSteer} />
      <div className="tier-link" aria-hidden="true" />
      <Ceo org={org} exec={ceo} active={active} />
      {judge ? (
        <section className="judge seat-card" style={hueStyle(judge.hue)} aria-label={judge.title}>
          <header className="tier-head">
            <SeatBadge seat={judge} />
            <div>
              <strong>
                <Gavel size={14} aria-hidden="true" /> {judge.title}
              </strong>
              <p className="muted">Signs off when leads have competing priorities.</p>
            </div>
          </header>
          {judging.map((a) => (
            <Working key={a.key} label={a.label} />
          ))}
        </section>
      ) : null}
      {signatory ? (
        <section className="judge seat-card" style={hueStyle(signatory.hue)} aria-label={signatory.title}>
          <header className="tier-head">
            <SeatBadge seat={signatory} />
            <div>
              <strong>
                <PenLine size={14} aria-hidden="true" /> {signatory.title}
              </strong>
              <p className="muted">
                Signs and pays, which nothing else here can. {org.settings.signatory === 'human' ? 'Held by you.' : 'Held by an AI; you carry out what it authorises.'}
              </p>
            </div>
          </header>
          {deciding.map((a) => (
            <Working key={a.key} label={a.label} />
          ))}
          <p>
            <button type="button" className="link" onClick={onOpenSignatory}>
              {waiting ? `${waiting} request${waiting === 1 ? '' : 's'} waiting for you` : 'Nothing waiting for you'}
            </button>
            {withAi ? <span className="muted"> · {withAi} with the AI</span> : null}
          </p>
        </section>
      ) : null}
      <div className="tier-link" aria-hidden="true" />
      <ul className="tier tier-leads" aria-label="Executive leads">
        {leads.map((lead) => (
          <Lead key={lead.id} org={org} exec={lead} active={active} meta={meta} onView={onView} onOpenPlan={onOpenPlan} />
        ))}
      </ul>
    </div>
  );
}
