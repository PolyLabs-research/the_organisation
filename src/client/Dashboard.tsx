import { ArrowLeft, Pause, Play, Settings2, Square } from 'lucide-react';
import { lazy, Suspense, useState } from 'react';
import type { OrgView } from '../shared/types';
import { api, useAction, useOrgStream, type Meta } from './api';
import { Operations } from './Operations';
import { PaceControl } from './Pace';
const Access = lazy(() => import('./Access').then(module => ({ default: module.Access })));
const Overseer = lazy(() => import('./Overseer').then((module) => ({ default: module.Overseer })));
import { Approaches } from './Approaches';
import { Privileges } from './Privileges';
import { Hierarchy } from './Hierarchy';
import { EXECUTION, STAGES } from './labels';
import { waitingOnPerson } from '../shared/signatory';
import { HelpButton, HelpProvider } from './Guide';
import { SettingsPanel } from './SettingsPanel';
import { Signatory } from './Signatory';
import { ActivityLog, Board, Decisions, Files, Plans } from './Tabs';
import { Empty, ErrorNote, PAUSE_REASONS, money } from './ui';

type Tab = 'access' | 'privileges' | 'approaches' | 'calendar' | 'business' | 'board' | 'plans' | 'decisions' | 'signatory' | 'files' | 'activity' | 'overseer';

function Banner({ view, onSettings }: { view: OrgView; onSettings: () => void }) {
  const { org } = view;
  if (org.status !== 'paused' || !org.pauseReason || org.pauseReason === 'user') return null;
  if (org.pauseReason === 'error') {
    return (
      <div className="note note-bad" role="alert">
        <span>
          <strong>The organisation paused because an operation failed.</strong> {org.lastError} Nothing was lost: put the cause right, then
          resume.
        </span>
      </div>
    );
  }
  const text = {
    budget: 'The budget is spent, or what is left is too little for the work that is waiting, so the organisation paused itself. Raise the budget to let it continue.',
    cycle_limit: 'The organisation has completed the number of cycles you set. Raise or remove the limit to let it continue.',
    restart: 'The server restarted while this organisation was running. Resume and it carries on from where it stopped.',
  }[org.pauseReason];
  return (
    <div className="note note-warn">
      <span>{text}</span>
      {org.pauseReason !== 'restart' ? (
        <button type="button" className="button" onClick={onSettings}>
          Open settings
        </button>
      ) : null}
    </div>
  );
}

export function Dashboard({ id, meta }: { id: string; meta: Meta }) {
  const { view, setView, activity, connected, missing } = useOrgStream(id);
  const control = useAction();
  const [tab, setTab] = useState<Tab>(new URLSearchParams(window.location.search).get('access') === 'connected' ? 'access' : 'board');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [planTarget, setPlanTarget] = useState<string | null>(null);
  const [file, setFile] = useState<string | null>(null);

  if (missing) {
    return (
      <Empty title="This organisation no longer exists.">
        <a href="#/">Back to organisations</a>
      </Empty>
    );
  }
  if (!view) return <p className="muted">Loading…</p>;

  const { org, active, draining } = view;
  const act = (call: () => Promise<OrgView>) => void control.run(async () => setView(await call()));
  const openPlan = (planId: string) => {
    setPlanTarget(planId);
    setTab('plans');
  };
  const openFile = (path: string) => {
    setFile(path);
    setTab('files');
  };

  // What the organisation has asked to have paid or signed, and that only a person can now do.
  const waiting = waitingOnPerson(org).length;
  const share = Math.min(100, (org.usage.costUsd / org.settings.budgetUsd) * 100);
  const stage = STAGES.find((s) => s.id === org.cycle.stage)!;
  const openDecisions = org.decisions.filter((d) => d.status !== 'resolved').length;
  const livePlans = org.plans.filter((p) => !['done', 'cancelled', 'failed'].includes(p.status)).length;
  const sessions = active.filter((a) => a.kind === 'execute').length;
  const calls = active.length - sessions;
  const winding = [calls ? `${calls} call${calls === 1 ? '' : 's'} finishing` : '', sessions ? `${sessions} session${sessions === 1 ? '' : 's'} being held` : ''].filter(Boolean).join(', ');
  const awaitingStep = org.settings.pace === 'step' && calls === 0 && view.pace.next.length > 0;
  const statusLabel = org.status === 'running' ? org.business.waiting ? 'Waiting for scheduled work' : awaitingStep ? 'Waiting for your next step' : 'Running' : draining ? `Pausing: ${winding}` : org.status === 'idle' ? 'Not started' : PAUSE_REASONS[org.pauseReason ?? 'user'];

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'board', label: 'Board' },
    { id: 'overseer', label: 'Overseer' },
    { id: 'calendar', label: 'Calendar' },
    { id: 'access', label: 'Email & accounts' },
    { id: 'privileges', label: 'Privileges' },
    { id: 'approaches', label: 'Approaches' },
    { id: 'business', label: 'Business', count: org.business.jobs.filter((j) => j.status === 'review').length || undefined },
    { id: 'plans', label: 'Plans', count: livePlans || undefined },
    { id: 'decisions', label: 'Decisions', count: openDecisions || undefined },
    { id: 'signatory', label: 'Signatory', count: waiting || undefined },
    { id: 'files', label: 'Files' },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <HelpProvider>
    <div className="dashboard">
      <a className="back" href="#/">
        <ArrowLeft size={15} aria-hidden="true" /> Organisations
      </a>
      <header className="org-head">
        <div className="org-title">
          <h1>{org.name}</h1>
          <p className="muted clamp-2" title={org.mission}>
            {org.mission}
          </p>
        </div>
        <div className="org-controls">
          <span className={`status status-${org.status}${draining ? ' status-draining' : ''}${org.pauseReason === 'error' ? ' status-bad' : ''}`} aria-live="polite">
            {org.status === 'running' || draining ? <span className="pulse" aria-hidden="true" /> : null}
            {statusLabel}
          </span>
          {org.status === 'running' ? (
            <button type="button" className="button" onClick={() => act(() => api.pause(org.id))} disabled={control.busy} title="Stop starting new work; calls in flight finish, and hosted sessions are held where they are">
              <Pause size={15} aria-hidden="true" /> Pause
            </button>
          ) : (
            <button type="button" className="button button-primary" onClick={() => act(() => api.start(org.id))} disabled={control.busy || draining}>
              <Play size={15} aria-hidden="true" /> {org.status === 'idle' ? 'Start' : 'Resume'}
            </button>
          )}
          {org.status === 'running' || draining ? (
            <button type="button" className="button" onClick={() => act(() => api.stop(org.id))} disabled={control.busy} title="Cut off the calls in flight; interrupted work is redone on resume">
              <Square size={14} aria-hidden="true" /> Stop now
            </button>
          ) : null}
          <HelpButton guide={tab === 'access' ? 'email-and-accounts' : tab === 'calendar' || tab === 'business' ? 'business-operations' : 'user-guide'} />
          <button type="button" className="icon-button" onClick={() => setSettingsOpen(true)} aria-label="Settings">
            <Settings2 size={18} />
          </button>
        </div>
      </header>

      <div className="org-strip">
        <div className="strip-item">
          <span className="field-label">Cycle {org.cycle.number}</span>
          <ol className="stages" title={stage.detail}>
            {STAGES.map((s) => (
              <li key={s.id} className={s.id === org.cycle.stage ? 'is-current' : ''}>
                {s.label}
              </li>
            ))}
          </ol>
        </div>
        <PaceControl view={view} onView={setView} />
        <div className="strip-item strip-spend">
          <span className="field-label">{meta.provider.simulated ? 'Simulated spend' : 'Estimated spend'}</span>
          <span className="meter-line">
            <span className="meter">
              <span style={{ width: `${share}%` }} className={share >= 100 ? 'is-full' : ''} />
            </span>
            <span className="num">
              {money(org.usage.costUsd)} of {money(org.settings.budgetUsd)}
            </span>
          </span>
        </div>
        <div className="strip-item">
          <span className="field-label">Decisions signed off by</span>
          <span>{org.settings.arbiter === 'judge' ? 'An independent judge' : 'The CEO'}</span>
        </div>
        <div className="strip-item">
          <span className="field-label">Agents work</span>
          <span>{EXECUTION[org.settings.execution]}</span>
        </div>
        {!connected ? <span className="tag tag-warn">Reconnecting…</span> : null}
      </div>

      <ErrorNote onDismiss={control.clearError}>{control.error}</ErrorNote>
      <Banner view={view} onSettings={() => setSettingsOpen(true)} />
      {waiting && tab !== 'signatory' ? (
        <div className="note note-warn">
          <span>
            <strong>
              {waiting} request{waiting === 1 ? ' is' : 's are'} waiting for you to pay or sign.
            </strong>{' '}
            The organisation carries on meanwhile, but treats nothing as paid or signed until you say it is.
          </span>
          <button type="button" className="button" onClick={() => setTab('signatory')}>
            Open
          </button>
        </div>
      ) : null}

      <div className="org-body">
        <aside className="org-side">
          <Hierarchy view={view} meta={meta} onView={setView} onOpenPlan={openPlan} onOpenSignatory={() => setTab('signatory')} />
        </aside>
        <section className="org-main">
          <div className="tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'is-on' : ''} onClick={() => setTab(t.id)}>
                {t.label}
                {t.count ? <span className="count">{t.count}</span> : null}
              </button>
            ))}
          </div>
          <div className="tab-panel" role="tabpanel">
            {tab === 'access' ? <Suspense fallback={<p className="muted">Loading email and accounts…</p>}><Access org={org} /></Suspense> : null}
            {tab === 'privileges' ? <Privileges org={org} onView={setView} onSettings={() => setSettingsOpen(true)} /> : null}
            {tab === 'approaches' ? <Approaches org={org} onView={setView} /> : null}
            {tab === 'calendar' ? <Operations org={org} calendar onView={setView} onOpenPlan={openPlan} /> : null}
            {tab === 'business' ? <Operations org={org} onView={setView} onOpenPlan={openPlan} /> : null}
            {tab === 'board' ? <Board org={org} onOpenPlan={openPlan} /> : null}
            {tab === 'plans' ? <Plans org={org} target={planTarget} simulated={meta.provider.simulated} onOpenFile={openFile} /> : null}
            {tab === 'decisions' ? <Decisions org={org} onOpenPlan={openPlan} /> : null}
            {/* Kept in place while another tab is shown, so that an answer half typed is still there after reading the file a request points to. */}
            <div hidden={tab !== 'signatory'}>
              <Signatory org={org} shown={tab === 'signatory'} onView={setView} onOpenPlan={openPlan} onOpenFile={openFile} onSettings={() => setSettingsOpen(true)} />
            </div>
            {tab === 'files' ? <Files org={org} selected={file} onSelect={setFile} /> : null}
            {tab === 'overseer' ? <Suspense fallback={<p className="muted">Loading the overseer…</p>}><Overseer view={view} activity={activity} /></Suspense> : null}
            {tab === 'activity' ? <ActivityLog org={org} activity={activity} simulated={meta.provider.simulated} /> : null}
          </div>
        </section>
      </div>

      {settingsOpen ? <SettingsPanel org={org} meta={meta} onClose={() => setSettingsOpen(false)} onView={setView} /> : null}
    </div>
    </HelpProvider>
  );
}
