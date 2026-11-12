import { Bell, Check, Hourglass, Pause, Play, Radio, Settings2, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { OrgView } from '../shared/types';
import { api, useAction, type Meta } from './api';
import { FLASH_MS, HeadquartersMap, type MapFlash, type MapFocus } from './HeadquartersMap';
import { HeadquartersPanel, type Elsewhere } from './HeadquartersPanel';
import { roomOf, survey, type Camera, type Situation } from './headquarters';
import { STAGES } from './labels';
import { PaceControl } from './Pace';
import { ErrorNote, PAUSE_REASONS, SeatBadge, clock, money, seatFor } from './ui';

// The organisation at a glance, for its shareholders: the whole of it as a place seen from above, with what needs
// them and what is going on beside it, and the latest of what was said and done beneath. Everything on it leads to
// the words themselves, first in the panel and then in the tab where the whole of a thing is.

/** What of the headquarters is kept while another tab is looked at: what was chosen, and where the map was. */
export interface HeadquartersState {
  selected: string | null;
  /** Null shows the whole building. */
  camera: Camera | null;
  pane: 'overview' | 'dispatches';
}

export const HEADQUARTERS_START: HeadquartersState = { selected: null, camera: null, pane: 'overview' };

const STATE: Record<Situation['state'], string> = {
  running: 'Running',
  pausing: 'Pausing',
  paused: 'Paused',
  idle: 'Not started',
  waiting_schedule: 'Waiting for scheduled work',
  waiting_step: 'Waiting for your next step',
};

export function Headquarters({
  view,
  meta,
  connected = true,
  state,
  onState,
  steer,
  onSteer,
  onView,
  onOpenTab,
  onOpenPlan,
  onOpenFile,
  onSettings,
}: {
  view: OrgView;
  meta: Meta;
  /** False while the page has lost the server and is finding it again. */
  connected?: boolean;
  state: HeadquartersState;
  onState: (change: (was: HeadquartersState) => HeadquartersState) => void;
  steer: string;
  onSteer: (text: string) => void;
  onView: (view: OrgView) => void;
  onOpenTab: (tab: Elsewhere) => void;
  onOpenPlan: (planId: string) => void;
  onOpenFile: (path: string) => void;
  onSettings: () => void;
}) {
  const { org } = view;
  const scene = useMemo(() => survey(view), [view]);
  const [focus, setFocus] = useState<MapFocus | null>(null);
  const [expanded, setExpanded] = useState(false);
  const run = useAction();
  const s = scene.situation;

  const seq = useRef(0);
  /** Choose something and bring the map to it. */
  const select = useCallback(
    (target: string | null, close = false) => {
      onState((was) => ({ ...was, selected: target }));
      if (target) setFocus({ target, seq: ++seq.current, close });
    },
    [onState],
  );
  /** Choose something on the map itself, which is already looking at it. */
  const choose = useCallback((target: string | null) => onState((was) => ({ ...was, selected: target })), [onState]);
  const setCamera = useCallback((camera: Camera | null) => onState((was) => ({ ...was, camera })), [onState]);


  // Where something has just been said or finished, the room is marked for a moment, so that the eye is drawn to it.
  const newest = scene.dispatches[0];
  const seen = useRef<string | undefined>(newest?.id);
  const [flash, setFlash] = useState<MapFlash | null>(null);
  useEffect(() => {
    if (!newest || newest.id === seen.current) return;
    seen.current = newest.id;
    setFlash({ room: roomOf(newest.target), seq: ++seq.current });
    const timer = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [newest?.id]);

  // Filling the window: the page behind is kept still and out of reach, of the keyboard as of the pointer, and Escape
  // comes back to it. What lies behind is everything beside the headquarters, and beside each thing it is inside.
  const whole = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!expanded) return;
    const root = document.documentElement;
    const was = root.style.overflow;
    root.style.overflow = 'hidden';
    const behind: HTMLElement[] = [];
    for (let el: HTMLElement | null = whole.current; el && el !== document.body; el = el.parentElement) {
      for (const beside of el.parentElement?.children ?? []) {
        if (beside !== el && beside instanceof HTMLElement && !beside.inert) {
          beside.inert = true;
          behind.push(beside);
        }
      }
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      root.style.overflow = was;
      for (const el of behind) el.inert = false;
      window.removeEventListener('keydown', onKey);
    };
  }, [expanded]);

  // On the page, the map is as tall as leaves it and what is beneath it in view without scrolling, where the window allows.
  const stage = useRef<HTMLDivElement>(null);
  const foot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    if (expanded) return void el.style.removeProperty('--hq-height');
    const size = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      el.style.setProperty('--hq-height', `${Math.round(Math.max(420, window.innerHeight - top - (foot.current?.offsetHeight ?? 0) - 26))}px`);
    };
    size();
    window.addEventListener('resize', size);
    // What is above the map comes and goes: a note that the organisation has paused, a row of tabs that wraps. The page
    // grows or shrinks with it, and the map is measured again when it does.
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(size);
    watch?.observe(document.body);
    return () => {
      window.removeEventListener('resize', size);
      watch?.disconnect();
    };
  }, [expanded]);

  const first = (severity: 'you' | 'trouble') => scene.alerts.find((a) => a.severity === severity);
  const overview = () => onState((was) => ({ ...was, selected: null, pane: 'overview' }));
  const done = s.phases.total ? Math.round((s.phases.done / s.phases.total) * 100) : 0;
  const share = Math.min(100, (org.usage.costUsd / org.settings.budgetUsd) * 100);
  const stage_ = STAGES.find((x) => x.id === org.cycle.stage);
  const latest = scene.dispatches.slice(0, 8);

  return (
    <div className={`hq${expanded ? ' is-expanded' : ''}`} ref={whole}>
      <div className="hq-bar">
        {expanded ? (
          <div className="hq-run">
            <strong className="clamp-1">{org.name}</strong>
            <span className={`status status-${org.status}${view.draining ? ' status-draining' : ''}${org.pauseReason === 'error' ? ' status-bad' : ''}`}>
              {s.state === 'running' || s.state === 'pausing' ? <span className="pulse" aria-hidden="true" /> : null}
              {s.state === 'paused' ? PAUSE_REASONS[org.pauseReason ?? 'user'] : STATE[s.state]}
            </span>
            {org.status === 'running' ? (
              <button type="button" className="button" disabled={run.busy} onClick={() => void run.run(async () => onView(await api.pause(org.id)))}>
                <Pause size={15} aria-hidden="true" /> Pause
              </button>
            ) : (
              <button type="button" className="button button-primary" disabled={run.busy || view.draining} onClick={() => void run.run(async () => onView(await api.start(org.id)))}>
                <Play size={15} aria-hidden="true" /> {org.status === 'idle' ? 'Start' : 'Resume'}
              </button>
            )}
            {/* The settings open over the page, so the page is gone back to first. */}
            <button
              type="button"
              className="icon-button"
              aria-label="Settings"
              onClick={() => {
                setExpanded(false);
                onSettings();
              }}
            >
              <Settings2 size={18} />
            </button>
          </div>
        ) : null}
        <div className="hq-alarms">
          <button type="button" className={`hq-alarm is-you${s.needsYou ? ' is-on' : ''}`} onClick={overview} title={first('you')?.title ?? 'Nothing is waiting for you'}>
            {s.needsYou ? <Bell size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
            <strong>{s.needsYou}</strong> {s.needsYou === 1 ? 'needs you' : 'need you'}
          </button>
          <button type="button" className={`hq-alarm is-trouble${s.trouble ? ' is-on' : ''}`} onClick={overview} title={first('trouble')?.title ?? 'Nothing has failed'}>
            {s.trouble ? <TriangleAlert size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
            <strong>{s.trouble}</strong> gone wrong
          </button>
        </div>
        <dl className="hq-tiles">
          <div className="hq-tile" title={stage_?.detail}>
            <dt>Cycle</dt>
            <dd>
              {org.cycle.number} <span className="hq-tile-of">· {stage_?.label}</span>
            </dd>
          </div>
          <div className="hq-tile">
            <dt>{meta.provider.simulated ? 'Simulated spend' : 'Estimated spend'}</dt>
            <dd>
              {money(org.usage.costUsd)} <span className="hq-tile-of">of {money(org.settings.budgetUsd)}</span>
              <span className={`hq-meter${share >= 100 ? ' is-full' : ''}`} role="img" aria-label={`${Math.round(share)}% of the budget is spent`}>
                <span style={{ width: `${share}%` }} />
              </span>
            </dd>
          </div>
          <div className="hq-tile" title={s.seats ? `And ${s.seats} of the executive team with a call in flight` : undefined}>
            <dt>Agents at work</dt>
            <dd>
              {s.agents.working} <span className="hq-tile-of">of {s.agents.total}</span>
            </dd>
          </div>
          <div
            className="hq-tile"
            title={
              [s.plans.drafting ? `${s.plans.drafting} being drafted` : '', s.plans.beforeBoard ? `${s.plans.beforeBoard} before the board` : '', s.plans.underWay ? `${s.plans.underWay} being carried out` : '', s.plans.reported ? `${s.plans.reported} reported this cycle` : '']
                .filter(Boolean)
                .join(', ') || undefined
            }
          >
            <dt>Plans</dt>
            <dd>{s.plans.live}</dd>
          </div>
          <div className="hq-tile">
            <dt>Phases done</dt>
            <dd>
              {s.phases.done} <span className="hq-tile-of">of {s.phases.total}</span>
              <span className="hq-meter" role="img" aria-label={`${done}% of this cycle’s phases are done`}>
                <span style={{ width: `${done}%` }} />
              </span>
            </dd>
          </div>
          <div className="hq-tile">
            <dt>Open decisions</dt>
            <dd>{s.decisions}</dd>
          </div>
        </dl>
        <PaceControl view={view} onView={onView} compact />
        {!connected ? <span className="tag tag-warn">Reconnecting…</span> : null}
      </div>
      <ErrorNote onDismiss={run.clearError}>{run.error}</ErrorNote>
      <div className="hq-stage" ref={stage}>
        <HeadquartersMap scene={scene} selected={state.selected} onSelect={choose} camera={state.camera} onCamera={setCamera} focus={focus} flash={flash} expanded={expanded} onExpand={setExpanded}>
          <ul className="hq-overlay hq-legend" aria-label="What the marks mean">
            {/* A line between rooms is marked as the rooms are: dots that march for what is being worked on, dashes for what stands. */}
            <li>
              <span className="hq-key hq-key-working" aria-hidden="true" />
              <svg className="hq-key-line is-moving" width="18" height="6" aria-hidden="true">
                <line x1="1" y1="3" x2="17" y2="3" />
              </svg>
              At work
            </li>
            <li>
              <Hourglass className="hq-key-waiting" size={12} aria-hidden="true" />
              <svg className="hq-key-line is-waiting" width="18" height="6" aria-hidden="true">
                <line x1="1" y1="3" x2="17" y2="3" />
              </svg>
              Waiting
            </li>
            <li>
              <Check className="hq-key-done" size={13} strokeWidth={3} aria-hidden="true" /> Done
            </li>
            <li>
              <span className="hq-key hq-key-you" aria-hidden="true">
                <Bell size={9} strokeWidth={3} />
              </span>
              <svg className="hq-key-line is-you" width="18" height="6" aria-hidden="true">
                <line x1="1" y1="3" x2="17" y2="3" />
              </svg>
              Needs you
            </li>
            <li>
              <span className="hq-key hq-key-trouble" aria-hidden="true">
                <TriangleAlert size={9} strokeWidth={3} />
              </span>{' '}
              Gone wrong
            </li>
          </ul>
        </HeadquartersMap>
        <HeadquartersPanel
          view={view}
          scene={scene}
          meta={meta}
          selected={state.selected}
          pane={state.pane}
          onPane={(pane) => onState((was) => ({ ...was, pane }))}
          onSelect={(target) => select(target)}
          onShow={(target) => select(target, true)}
          steer={steer}
          onSteer={onSteer}
          onView={onView}
          onOpenTab={onOpenTab}
          onOpenPlan={onOpenPlan}
          onOpenFile={onOpenFile}
        />
      </div>
      <div className="hq-ticker" ref={foot}>
        <span className="hq-ticker-name">
          <Radio size={14} aria-hidden="true" /> Dispatches
        </span>
        {latest.length ? (
          <ol>
            {latest.map((d) => (
              <li key={d.id}>
                <button type="button" className={`hq-chip is-${d.tone}`} onClick={() => select(d.target)} title={`${d.label}: ${d.title}`}>
                  <time dateTime={d.at}>{clock(d.at)}</time>
                  <SeatBadge seat={seatFor(org, d.seatId)} size="sm" />
                  <span className="hq-kind">{d.label}</span>
                  <span className="hq-chip-title">{d.title}</span>
                </button>
              </li>
            ))}
          </ol>
        ) : (
          <span className="muted grow">Nothing has happened yet.</span>
        )}
        <button type="button" className="link" onClick={() => onState((was) => ({ ...was, selected: null, pane: 'dispatches' }))}>
          All of them
        </button>
      </div>
    </div>
  );
}
