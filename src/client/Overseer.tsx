import { CircleAlert, CircleCheck, Clock, Hourglass, Scale, TriangleAlert } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useState, type MouseEvent, type ReactNode } from 'react';
import { Calibration, EFFORT_SCALE, forecast, phaseSamples, startOf, taskSamples, type ProjectedBar } from '../shared/effort';
import { isOpen } from '../shared/signatory';
import { INTERRUPTED, type ActivityEntry, type Organisation, type OrgView, type WorkKind } from '../shared/types';
import { describeWait, heldBy } from '../shared/waits';
import { api } from './api';
import { Empty, duration, money, seatName } from './ui';

// ---- shared ----

type Category = 'task' | 'lead' | 'board';

/** Three kinds of work, so that every pair of colours stays apart, whatever sits next to what on the timeline. */
const CATEGORY: Record<WorkKind | 'recommend_team', Category> = {
  task: 'task',
  execute: 'task',
  plan: 'lead',
  revise: 'lead',
  kickoff: 'lead',
  phase_review: 'lead',
  report: 'lead',
  consult: 'board',
  direct: 'board',
  review: 'board',
  answer: 'board',
  position: 'board',
  signoff: 'board',
  react: 'board',
  steer_review: 'board',
  authorise: 'board',
  recommend_team: 'board',
};

const CATEGORY_LABEL: Record<Category, string> = {
  task: 'Agent tasks',
  lead: 'Lead’s own work: planning, handing out, gate reviews, reports',
  board: 'Board work: consulting, direction, reviews, positions, rulings',
};

/** The whole log from disk, kept current with what arrives live. */
function useHistory(orgId: string, live: ActivityEntry[]): { entries: ActivityEntry[]; loading: boolean } {
  const [history, setHistory] = useState<ActivityEntry[] | null>(null);
  useEffect(() => {
    let gone = false;
    api.history(orgId).then(
      (entries) => !gone && setHistory(entries),
      () => !gone && setHistory([]),
    );
    return () => {
      gone = true;
    };
  }, [orgId]);
  const entries = useMemo(() => {
    const base = history ?? [];
    const seen = new Set(base.map((e) => `${e.at}|${e.id}`));
    return [...base, ...live.filter((e) => !seen.has(`${e.at}|${e.id}`))].sort((a, b) => a.at.localeCompare(b.at));
  }, [history, live]);
  return { entries, loading: history === null };
}

/**
 * The width of an element, kept up to date, for charts drawn in pixels. A callback ref, since the element
 * comes and goes (it is not there until there is data, and the table view replaces it).
 */
function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number, T | null] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width, el];
}

/** Agents' slot numbers were only written into the label before they were recorded on their own. */
function agentOf(entry: ActivityEntry): number | null {
  if (entry.agent) return entry.agent;
  const m = /^Agent (\d+):/.exec(entry.label);
  return m ? Number(m[1]) : null;
}

/** A seat's short code (CTO), which fits a lane label; the full title goes in its tooltip. */
const shortName = (org: Organisation, id: string) => (id === 'system' ? 'System' : org.executives.find((e) => e.id === id)?.short ?? seatName(org, id));

const timeOf = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const minutesText = (m: number) => (m < 1 ? `${Math.round(m * 60)} s` : m < 90 ? `${m < 10 ? m.toFixed(1) : Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);

interface Tip {
  x: number;
  y: number;
  body: ReactNode;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="viz-tip" role="tooltip" style={{ left: tip.x, top: tip.y }}>
      {tip.body}
    </div>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: Array<[T, string]>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} className={value === v ? 'is-on' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

// ---- the overseer ----

type View = 'timeline' | 'effort' | 'spend' | 'bottlenecks';

export function Overseer({ view, activity }: { view: OrgView; activity: ActivityEntry[] }) {
  const { org } = view;
  const { entries, loading } = useHistory(org.id, activity);
  const [shown, setShown] = useState<View>('timeline');
  // A clock for the "now" line and the forecast, moved on while the organisation runs.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (org.status !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, [org.status]);
  useEffect(() => setNow(Date.now()), [entries.length]);
  // Paused, the forecast runs from where the work stopped (as if resumed then), so a long pause does not squeeze the history.
  const running = org.status === 'running';
  const anchor = running || !entries.length ? now : Math.max(...entries.map((e) => Date.parse(e.at)));
  const projected = useMemo(() => forecast(org, entries, anchor), [org, entries, anchor]);

  return (
    <div className="overseer">
      <Segmented<View>
        label="Overseer view"
        value={shown}
        onChange={setShown}
        options={[
          ['timeline', 'Timeline'],
          ['effort', 'Effort'],
          ['spend', 'Spend'],
          ['bottlenecks', 'Bottlenecks'],
        ]}
      />
      {loading ? <p className="muted">Reading the organisation’s activity…</p> : null}
      {!loading && shown === 'timeline' ? <Timeline org={org} entries={entries} projected={projected} now={anchor} running={running} /> : null}
      {!loading && shown === 'effort' ? <EffortView org={org} entries={entries} /> : null}
      {!loading && shown === 'spend' ? <SpendView org={org} entries={entries} projected={projected} /> : null}
      {!loading && shown === 'bottlenecks' ? <Bottlenecks view={view} projected={projected} now={now} /> : null}
    </div>
  );
}

// ---- timeline ----

interface Bar {
  key: string;
  row: string;
  start: number;
  end: number;
  category: Category;
  label: string;
  effort: number | null;
  failed: boolean;
  /** Cut off by a pause or stop; it is started again, so it is not a failure. */
  stopped: boolean;
  entry?: ActivityEntry;
  projected?: ProjectedBar;
}

interface Row {
  id: string;
  label: string;
  title: string;
  sub: boolean;
}

type Window = 'all' | '60' | '15';

const LABEL_COL = 100;
const ROW_H = 22;

function laneOrder(org: Organisation): string[] {
  const kinds = ['ceo', 'lead', 'judge', 'signatory'];
  return [...org.executives].sort((a, b) => kinds.indexOf(a.kind) - kinds.indexOf(b.kind)).map((e) => e.id);
}

function Timeline({ org, entries, projected, now, running }: { org: Organisation; entries: ActivityEntry[]; projected: ProjectedBar[]; now: number; running: boolean }) {
  const [win, setWin] = useState<Window>('all');
  const [showForecast, setShowForecast] = useState(true);
  const [asTable, setAsTable] = useState(false);
  const [tip, setTip] = useState<Tip | null>(null);
  const [ref, width, box0] = useWidth<HTMLDivElement>();

  const { rows, bars } = useMemo(() => {
    const bars: Bar[] = entries.map((e, i) => {
      const agent = e.kind === 'execute' ? 'session' : e.kind === 'task' ? agentOf(e) : null;
      const seat = e.execId ?? 'system';
      return {
        key: `a${i}`,
        row: agent ? `${seat}#${agent}` : seat,
        start: startOf(e),
        end: Date.parse(e.at),
        category: CATEGORY[e.kind] ?? 'board',
        label: e.label,
        effort: e.effort ?? null,
        failed: !e.ok && e.error !== INTERRUPTED,
        stopped: e.error === INTERRUPTED,
        entry: e,
      };
    });
    if (showForecast) {
      for (const p of projected) {
        bars.push({ key: `f${p.planId}:${p.phaseIndex}:${p.taskId ?? 'phase'}`, row: p.agent ? `${p.execId}#${p.agent}` : p.execId, start: p.start, end: p.end, category: p.taskId ? 'task' : 'lead', label: p.label, effort: p.effort, failed: false, stopped: false, projected: p });
      }
    }
    const used = new Set(bars.map((b) => b.row));
    const rows: Row[] = [];
    for (const id of [...laneOrder(org), 'system']) {
      const subs = [...used].filter((r) => r.startsWith(`${id}#`)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!used.has(id) && !subs.length) continue;
      rows.push({ id, label: shortName(org, id), title: id === 'system' ? 'System' : seatName(org, id), sub: false });
      for (const s of subs) {
        const slot = s.split('#')[1]!;
        const label = slot === 'session' ? 'hosted session' : `agent ${slot}`;
        rows.push({ id: s, label, title: `${seatName(org, id)}, ${label}`, sub: true });
      }
    }
    return { rows, bars };
  }, [entries, projected, showForecast, org]);

  if (!bars.length) return <Empty title="Nothing has happened yet.">Once the organisation starts, every call and agent task appears here on its seat’s lane.</Empty>;

  const forecasting = showForecast && projected.length > 0;
  const last = Math.max(...bars.map((b) => b.end), running || forecasting ? now : 0);
  const first = Math.min(...bars.map((b) => b.start));
  const t1 = last;
  const t0 = win === 'all' ? first : Math.max(first, t1 - Number(win) * 60_000);
  const span = Math.max(t1 - t0, 60_000);
  const track = Math.max(width - LABEL_COL, 100);
  const x = (t: number) => ((Math.min(Math.max(t, t0), t1) - t0) / span) * track;
  const visible = bars.filter((b) => b.end >= t0 && b.start <= t1);

  // Ticks on a round step, few enough to read.
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 240, 480, 720, 1440].map((m) => m * 60_000);
  const step = steps.find((s) => span / s <= Math.max(2, Math.floor(track / 90))) ?? steps.at(-1)!;
  const ticks: number[] = [];
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) ticks.push(t);

  const tipFor = (bar: Bar, event: MouseEvent) => {
    const box = box0!.getBoundingClientRect();
    const e = bar.entry;
    const p = bar.projected;
    setTip({
      x: Math.min(event.clientX - box.left + 12, box.width - 260),
      y: event.clientY - box.top + 14,
      body: (
        <>
          <strong>{bar.label}</strong>
          <span>
            {seatName(org, (e?.execId ?? p?.execId) || 'system')} · {p ? (p.basis === 'measured' ? 'Forecast from measured work' : 'Forecast from fitted curve') : CATEGORY_LABEL[bar.category].split(':')[0]}
          </span>
          <span>
            {timeOf(bar.start)}–{timeOf(bar.end)} · {duration(bar.end - bar.start)}
          </span>
          {bar.effort ? <span>Effort {bar.effort}: {EFFORT_SCALE[bar.effort - 1]}</span> : null}
          {e ? (
            <span>
              {money(e.costUsd)}
              {e.model ? ` · ${e.model}` : ''}
            </span>
          ) : p ? (
            <span>about {money(p.costUsd)}</span>
          ) : null}
          {bar.stopped ? <span>Stopped by a pause; it is started again on resuming.</span> : e && !e.ok ? <span className="viz-bad">Failed: {e.error}</span> : null}
        </>
      ),
    });
  };

  return (
    <div className="viz">
      <div className="viz-filters">
        <Segmented<Window> label="Time window" value={win} onChange={setWin} options={[['all', 'All'], ['60', 'Last hour'], ['15', 'Last 15 min']]} />
        <label className="check">
          <input type="checkbox" checked={showForecast} onChange={(e) => setShowForecast(e.target.checked)} /> Forecast
        </label>
        <label className="check">
          <input type="checkbox" checked={asTable} onChange={(e) => setAsTable(e.target.checked)} /> Table
        </label>
      </div>
      <Legend
        items={[
          ...(['task', 'lead', 'board'] as Category[]).map((c) => ({ swatch: <span className={`viz-swatch cat-${c}`} />, label: CATEGORY_LABEL[c] })),
          { swatch: <span className="viz-swatch cat-task is-forecast" />, label: 'Forecast, from effort ratings' },
          { swatch: <CircleAlert size={13} className="viz-bad" />, label: 'Failed' },
          { swatch: <span className="viz-swatch is-stopped" />, label: 'Stopped by a pause' },
        ]}
      />
      {showForecast && !projected.length ? <p className="muted small">No forecast yet: it needs finished work with effort ratings to learn from, and unfinished work that has been rated.</p> : null}
      {asTable ? (
        <TimelineTable org={org} bars={visible} />
      ) : (
        <div className="gantt" ref={ref} onMouseLeave={() => setTip(null)}>
          <div className="gantt-axis" style={{ marginLeft: LABEL_COL }}>
            {ticks.map((t) => (
              <span key={t} style={{ left: x(t) }}>
                {timeOf(t)}
              </span>
            ))}
          </div>
          <div className="gantt-body">
            {ticks.map((t) => (
              <span key={t} className="gantt-grid" style={{ left: LABEL_COL + x(t) }} />
            ))}
            {(running || forecasting) && now >= t0 && now <= t1 ? (
              <span className="gantt-now" style={{ left: LABEL_COL + x(now) }} title={running ? 'Now' : 'The organisation is paused: the forecast shows the work as if it resumed from where it stopped'}>
                <span className="gantt-now-label">{running ? 'now' : 'if resumed'}</span>
              </span>
            ) : null}
            {rows.map((row) => (
              <div key={row.id} className={`gantt-row${row.sub ? ' is-sub' : ''}`} style={{ height: ROW_H }}>
                <span className="gantt-label" style={{ width: LABEL_COL }} title={row.title}>
                  {row.label}
                </span>
                <div className="gantt-track">
                  {visible
                    .filter((b) => b.row === row.id)
                    .map((b) => {
                      const left = x(b.start);
                      const w = Math.max(x(b.end) - left, 3);
                      return (
                        <span
                          key={b.key}
                          className={`gantt-bar cat-${b.category}${b.projected ? ' is-forecast' : ''}${b.failed ? ' is-failed' : ''}${b.stopped ? ' is-stopped' : ''}`}
                          style={{ left, width: w }}
                          onMouseMove={(ev) => tipFor(b, ev)}
                          aria-label={`${b.label}, ${duration(b.end - b.start)}`}
                        >
                          {w > 72 ? (
                            <span className="gantt-text">
                              {b.effort ? `${b.effort} · ` : ''}
                              {b.label.replace(/^Agent \d+: /, '')}
                            </span>
                          ) : null}
                          {b.failed ? <CircleAlert size={11} className="gantt-fail" aria-label="Failed" /> : null}
                        </span>
                      );
                    })}
                </div>
              </div>
            ))}
          </div>
          <Tooltip tip={tip} />
        </div>
      )}
    </div>
  );
}

function Legend({ items }: { items: Array<{ swatch: ReactNode; label: string }> }) {
  return (
    <ul className="viz-legend">
      {items.map((item) => (
        <li key={item.label}>
          {item.swatch}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

function TimelineTable({ org, bars }: { org: Organisation; bars: Bar[] }) {
  const rows = [...bars].sort((a, b) => a.start - b.start);
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Start</th>
            <th>Seat</th>
            <th>Work</th>
            <th className="r">Effort</th>
            <th className="r">Took</th>
            <th className="r">Cost</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <tr key={b.key}>
              <td className="num">{timeOf(b.start)}</td>
              <td>{seatName(org, b.entry?.execId ?? b.projected?.execId ?? 'system')}</td>
              <td>{b.label}</td>
              <td className="r num">{b.effort ?? '–'}</td>
              <td className="r num">{duration(b.end - b.start)}</td>
              <td className="r num">{b.entry ? money(b.entry.costUsd) : b.projected ? `~${money(b.projected.costUsd)}` : ''}</td>
              <td>{b.projected ? 'Forecast' : b.failed ? 'Failed' : b.stopped ? 'Stopped' : 'Done'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- effort calibration ----

const MODEL_SLOTS = 3;

function EffortView({ org, entries }: { org: Organisation; entries: ActivityEntry[] }) {
  const samples = useMemo(() => taskSamples(entries), [entries]);
  const tasks = useMemo(() => new Calibration(samples), [samples]);
  const phases = useMemo(() => new Calibration(phaseSamples(org, entries)), [org, entries]);
  const ran = entries.filter((e) => e.kind === 'task' && e.ok);
  const unrated = ran.length - samples.length;
  // At most three models get a colour each; the rest are listed in the table only.
  const models = [...new Set(samples.map((s) => s.model))].sort((a, b) => samples.filter((s) => s.model === b).length - samples.filter((s) => s.model === a).length);
  const charted = models.slice(0, MODEL_SLOTS);

  if (!samples.length) {
    return (
      <Empty title="No rated work has finished yet.">
        Leads rate every plan, phase and task from 1 to 10. Once rated tasks finish, this shows what each level actually takes here, and how far apart the models are.
        {unrated ? ` ${unrated} finished task${unrated === 1 ? ' was' : 's were'} done before ratings were recorded.` : ''}
      </Empty>
    );
  }
  return (
    <div className="viz">
      <p className="muted small">
        {samples.length} rated task{samples.length === 1 ? '' : 's'} finished{unrated ? `, ${unrated} without a rating` : ''}. Dots are the median time at each level, lines the fastest to the slowest; the faint curve is the
        trend the forecast uses where a level has fewer than 3 tasks.
      </p>
      <Legend items={charted.map((m, i) => ({ swatch: <span className={`viz-swatch slot-${i + 1}`} />, label: m }))} />
      <CalibrationChart calibration={tasks} models={charted} />
      <h4 className="viz-heading">Tasks, by effort</h4>
      <LevelTable calibration={tasks} models={models} />
      <h4 className="viz-heading">Phases, by effort</h4>
      {phases.samples.length ? <LevelTable calibration={phases} models={['*']} /> : <p className="muted small">No rated phase has finished yet.</p>}
    </div>
  );
}

function CalibrationChart({ calibration, models }: { calibration: Calibration; models: string[] }) {
  const [ref, width, box0] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const H = 240;
  const M = { l: 52, r: 12, t: 10, b: 30 };
  const levels = calibration.levels.filter((l) => models.includes(l.model));
  const values = levels.flatMap((l) => [l.minutes.min, l.minutes.max]).filter((v) => v > 0);
  const lo = Math.max(Math.min(...values) / 1.6, 0.02);
  const hi = Math.max(...values) * 1.6;
  const w = Math.max(width, 280);
  const xOf = (effort: number, i: number) => M.l + ((effort - 0.5) / 10) * (w - M.l - M.r) + (i - (models.length - 1) / 2) * 7;
  const yOf = (minutes: number) => M.t + (1 - (Math.log(Math.max(minutes, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (H - M.t - M.b);
  const grid = [1 / 60, 2 / 60, 5 / 60, 10 / 60, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120, 240, 480].filter((g) => g >= lo && g <= hi);

  return (
    <div className="viz-chart" ref={ref} onMouseLeave={() => setTip(null)}>
      <svg width={w} height={H} role="img" aria-label="Minutes taken at each effort level, by model">
        {grid.map((g) => (
          <g key={g}>
            <line className="viz-grid" x1={M.l} x2={w - M.r} y1={yOf(g)} y2={yOf(g)} />
            <text className="viz-axis" x={M.l - 6} y={yOf(g) + 4} textAnchor="end">
              {minutesText(g)}
            </text>
          </g>
        ))}
        {Array.from({ length: 10 }, (_, i) => i + 1).map((effort) => (
          <text key={effort} className="viz-axis" x={xOf(effort, (models.length - 1) / 2)} y={H - 10} textAnchor="middle">
            {effort}
          </text>
        ))}
        {models.map((model, i) => {
          // The trend is drawn one level either side of what has been measured, not out to levels nothing supports.
          const seen = levels.filter((l) => l.model === model).map((l) => l.effort);
          const curve = Array.from({ length: 10 }, (_, k) => k + 1)
            .filter((effort) => effort >= Math.min(...seen) - 1 && effort <= Math.max(...seen) + 1)
            .map((effort) => ({ effort, est: calibration.estimate(effort, model) }))
            .filter((p) => p.est && p.est.basis === 'fitted');
          return (
            <g key={model} className={`slot-${i + 1}`}>
              {curve.length > 1 ? <polyline className="viz-trend" points={curve.map((p) => `${xOf(p.effort, i)},${yOf(p.est!.minutes)}`).join(' ')} /> : null}
              {levels
                .filter((l) => l.model === model)
                .map((l) => (
                  <g
                    key={l.effort}
                    onMouseMove={(ev) => {
                      const box = box0!.getBoundingClientRect();
                      setTip({
                        x: Math.min(ev.clientX - box.left + 12, box.width - 240),
                        y: ev.clientY - box.top + 12,
                        body: (
                          <>
                            <strong>
                              Effort {l.effort} · {model}
                            </strong>
                            <span>
                              {l.n} task{l.n === 1 ? '' : 's'}: median {minutesText(l.minutes.median)}, {minutesText(l.minutes.min)} to {minutesText(l.minutes.max)}
                            </span>
                            <span>Median cost {money(l.costUsd.median)}</span>
                          </>
                        ),
                      });
                    }}
                  >
                    <rect className="viz-hit" x={xOf(l.effort, i) - 9} y={M.t} width={18} height={H - M.t - M.b} />
                    <line className="viz-range" x1={xOf(l.effort, i)} x2={xOf(l.effort, i)} y1={yOf(l.minutes.min)} y2={yOf(l.minutes.max)} />
                    <circle className="viz-dot" cx={xOf(l.effort, i)} cy={yOf(l.minutes.median)} r={4} />
                  </g>
                ))}
            </g>
          );
        })}
        <text className="viz-axis" x={w - M.r} y={H - 10} textAnchor="end">
          effort
        </text>
      </svg>
      <Tooltip tip={tip} />
    </div>
  );
}

function LevelTable({ calibration, models }: { calibration: Calibration; models: string[] }) {
  const rows = calibration.levels.filter((l) => models.includes(l.model) || (models.length === 1 && models[0] === '*' && l.model === '*'));
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th className="r">Effort</th>
            <th>Model</th>
            <th className="r">Done</th>
            <th className="r">Median time</th>
            <th className="r">Range</th>
            <th className="r">Median cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((l) => (
            <tr key={`${l.model}|${l.effort}`}>
              <td className="r num">{l.effort}</td>
              <td>{l.model === '*' ? 'All models' : l.model}</td>
              <td className="r num">{l.n}</td>
              <td className="r num">{minutesText(l.minutes.median)}</td>
              <td className="r num">
                {minutesText(l.minutes.min)}–{minutesText(l.minutes.max)}
              </td>
              <td className="r num">{money(l.costUsd.median)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- spend ----

function SpendView({ org, entries, projected }: { org: Organisation; entries: ActivityEntry[]; projected: ProjectedBar[] }) {
  const budget = org.settings.budgetUsd;
  const spent = org.usage.costUsd;
  const ahead = projected.reduce((sum, p) => sum + p.costUsd, 0);
  const bySeat = new Map<string, number>();
  const byKind = new Map<Category, number>();
  for (const e of entries) {
    bySeat.set(e.execId ?? 'system', (bySeat.get(e.execId ?? 'system') ?? 0) + e.costUsd);
    const c = CATEGORY[e.kind] ?? 'board';
    byKind.set(c, (byKind.get(c) ?? 0) + e.costUsd);
  }
  return (
    <div className="viz">
      <div className="viz-hero">
        <div>
          <span className="viz-hero-n">{money(spent)}</span>
          <span className="muted">of {money(budget)} budget ({budget ? Math.round((spent / budget) * 100) : 0}%)</span>
        </div>
        {ahead ? (
          <div>
            <span className="viz-hero-n">~{money(ahead)}</span>
            <span className="muted">forecast for the rated work not yet finished</span>
          </div>
        ) : null}
      </div>
      <h4 className="viz-heading">Spend over time</h4>
      <SpendLine entries={entries} budget={budget} />
      <div className="viz-pair">
        <div>
          <h4 className="viz-heading">By seat</h4>
          <HBars rows={[...bySeat.entries()].map(([id, v]) => ({ label: shortName(org, id), title: id === 'system' ? 'System' : seatName(org, id), value: v }))} />
        </div>
        <div>
          <h4 className="viz-heading">By kind of work</h4>
          <HBars rows={[...byKind.entries()].map(([c, v]) => ({ label: CATEGORY_LABEL[c].split(':')[0]!, value: v }))} />
        </div>
      </div>
    </div>
  );
}

function SpendLine({ entries, budget }: { entries: ActivityEntry[]; budget: number }) {
  const [ref, width, box0] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const points = useMemo(() => {
    let total = 0;
    return entries.map((e) => ({ t: Date.parse(e.at), v: (total += e.costUsd) }));
  }, [entries]);
  if (points.length < 2) return <p className="muted small">Not enough activity to draw yet.</p>;
  const H = 200;
  const M = { l: 56, r: 16, t: 12, b: 26 };
  const w = Math.max(width, 280);
  const t0 = points[0]!.t;
  const t1 = points.at(-1)!.t;
  const step = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => Math.max(points.at(-1)!.v, budget) / s <= 5) ?? 1000;
  const top = Math.ceil((Math.max(points.at(-1)!.v, budget) * 1.04) / step) * step;
  const xOf = (t: number) => M.l + ((t - t0) / Math.max(t1 - t0, 1)) * (w - M.l - M.r);
  const yOf = (v: number) => M.t + (1 - v / top) * (H - M.t - M.b);
  const yTicks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const near = hover === null ? null : points.reduce((best, p) => (Math.abs(p.t - hover) < Math.abs(best.t - hover) ? p : best));
  return (
    <div
      className="viz-chart"
      ref={ref}
      onMouseMove={(ev) => {
        const box = box0!.getBoundingClientRect();
        const px = ev.clientX - box.left;
        setHover(t0 + ((px - M.l) / (w - M.l - M.r)) * (t1 - t0));
      }}
      onMouseLeave={() => setHover(null)}
    >
      <svg width={w} height={H} role="img" aria-label="Cumulative spend over time against the budget">
        {yTicks.map((v) => (
          <g key={v}>
            <line className="viz-grid" x1={M.l} x2={w - M.r} y1={yOf(v)} y2={yOf(v)} />
            <text className="viz-axis" x={M.l - 6} y={yOf(v) + 4} textAnchor="end">
              {money(v)}
            </text>
          </g>
        ))}
        <line className="viz-budget" x1={M.l} x2={w - M.r} y1={yOf(budget)} y2={yOf(budget)} />
        <text className="viz-axis" x={w - M.r} y={yOf(budget) - 5} textAnchor="end">
          Budget {money(budget)}
        </text>
        <polyline className="viz-line slot-1" points={points.map((p) => `${xOf(p.t)},${yOf(p.v)}`).join(' ')} />
        <text className="viz-axis" x={M.l} y={H - 8}>
          {timeOf(t0)}
        </text>
        <text className="viz-axis" x={w - M.r} y={H - 8} textAnchor="end">
          {timeOf(t1)}
        </text>
        {near ? (
          <g>
            <line className="viz-cross" x1={xOf(near.t)} x2={xOf(near.t)} y1={M.t} y2={H - M.b} />
            <circle className="viz-dot slot-1" cx={xOf(near.t)} cy={yOf(near.v)} r={4} />
          </g>
        ) : null}
      </svg>
      {near ? (
        <div className="viz-tip" style={{ left: Math.min(xOf(near.t) + 12, w - 180), top: 8 }}>
          <strong>{money(near.v)}</strong>
          <span>by {timeOf(near.t)}</span>
        </div>
      ) : null}
    </div>
  );
}

function HBars({ rows }: { rows: Array<{ label: string; title?: string; value: number }> }) {
  const sorted = [...rows].filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const max = Math.max(...sorted.map((r) => r.value), 0.0001);
  if (!sorted.length) return <p className="muted small">Nothing spent yet.</p>;
  return (
    <ul className="hbars">
      {sorted.map((r) => (
        <li key={r.label} title={`${r.title ?? r.label}: ${money(r.value)}`}>
          <span className="hbars-label">{r.label}</span>
          <span className="hbars-track">
            <span className="hbars-bar slot-1" style={{ width: `${(r.value / max) * 100}%` }} />
          </span>
          <span className="hbars-value num">{money(r.value)}</span>
        </li>
      ))}
    </ul>
  );
}

// ---- bottlenecks ----

type Severity = 'critical' | 'warning' | 'info' | 'good';

interface Finding {
  severity: Severity;
  title: string;
  detail: string;
}

const SEVERITY_ICON: Record<Severity, ReactNode> = {
  critical: <CircleAlert size={15} aria-label="Blocking" />,
  warning: <TriangleAlert size={15} aria-label="Slowing" />,
  info: <Hourglass size={15} aria-label="Waiting" />,
  good: <CircleCheck size={15} aria-label="Clear" />,
};

const SEVERITY_LABEL: Record<Severity, string> = { critical: 'Blocking', warning: 'Slowing', info: 'Waiting', good: 'Clear' };

const ago = (iso: string, now: number) => {
  const m = Math.round((now - Date.parse(iso)) / 60_000);
  return m < 1 ? 'just now' : m < 120 ? `${m} min` : `${Math.round(m / 60)} h`;
};

function Bottlenecks({ view, projected, now }: { view: OrgView; projected: ProjectedBar[]; now: number }) {
  const { org } = view;
  const short = (id: string) => org.executives.find((e) => e.id === id)?.short ?? id;
  const findings: Finding[] = [];

  // Spend: the hard stop.
  const left = org.settings.budgetUsd - org.usage.costUsd;
  const ahead = projected.reduce((sum, p) => sum + p.costUsd, 0);
  if (left <= 0) findings.push({ severity: 'critical', title: 'The budget is spent', detail: 'Nothing more can start until the budget is raised.' });
  else if (ahead > left) findings.push({ severity: 'warning', title: 'The forecast runs past the budget', detail: `The rated work not yet finished is forecast at about ${money(ahead)}, and ${money(left)} is left. Work that is not rated is not counted.` });

  // Capacity.
  const max = org.settings.maxConcurrentCalls;
  const queued = view.pace.next.length;
  if (org.status === 'running' && view.active.length >= max && queued) {
    findings.push({ severity: 'warning', title: `Every call slot is busy (${view.active.length} of ${max})`, detail: `More work is ready to start: ${view.pace.next.map((n) => `${short(n.execId)}: ${n.label}`).join('; ')}. More concurrent calls in the settings would start it sooner.` });
  }

  for (const plan of org.plans) {
    const held = heldBy(org, plan);
    if (held.length) {
      const phase = plan.phases.find((p) => p.status !== 'done');
      findings.push({ severity: 'info', title: `${short(plan.ownerId)} ${phase?.name ?? 'plan'} waits for ${held.map((w) => describeWait(org, w)).join('; ')}`, detail: plan.objective });
    }
    for (const phase of plan.phases) {
      if (phase.status === 'working' && phase.reworkRounds > 0) findings.push({ severity: 'warning', title: `${short(plan.ownerId)} ${phase.name} sent back for rework`, detail: phase.summary ?? plan.objective });
      const failed = phase.tasks.filter((t) => t.status === 'failed');
      if (failed.length && plan.status === 'executing') findings.push({ severity: 'warning', title: `${failed.length} task${failed.length === 1 ? '' : 's'} failed in ${short(plan.ownerId)} ${phase.name}`, detail: failed.map((t) => `${t.title}: ${t.error ?? 'no reason given'}`).join(' · ') });
    }
  }

  for (const d of org.decisions.filter((x) => x.kind === 'contested' && x.status !== 'resolved')) {
    const waitingOn =
      d.status === 'answering'
        ? `the ${short(org.plans.find((p) => p.id === d.planId)?.ownerId ?? '')} to answer`
        : d.status === 'deliberated'
          ? 'the ruling'
          : `positions from ${d.participantIds.filter((id) => !d.positions[id]).map(short).join(', ') || 'nobody'}`;
    findings.push({ severity: 'info', title: `${d.title}: open ${ago(d.at, now)}`, detail: `Waiting for ${waitingOn}. The plan does not start until it is settled.` });
  }

  for (const r of org.signatory.requests.filter(isOpen)) {
    findings.push({ severity: 'info', title: `${r.kind === 'payment' ? 'Payment' : 'Signature'} waiting ${ago(r.raisedAt, now)}: ${r.title}`, detail: `Asked by the ${short(r.fromId)}. ${r.status === 'authorised' ? 'Authorised, waiting for a person to carry it out.' : 'Waiting for the signatory.'} The plan carries on, but treats it as not done.` });
  }

  const order: Severity[] = ['critical', 'warning', 'info'];
  findings.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));

  return (
    <div className="viz">
      <dl className="totals">
        <div>
          <dt>
            <Clock size={13} /> Calls under way
          </dt>
          <dd className="num">
            {view.active.length} of {max}
          </dd>
        </div>
        <div>
          <dt>
            <Hourglass size={13} /> Ready to start
          </dt>
          <dd className="num">{org.status === 'running' ? queued : '–'}</dd>
        </div>
        <div>
          <dt>
            <Scale size={13} /> Open board decisions
          </dt>
          <dd className="num">{org.decisions.filter((d) => d.kind === 'contested' && d.status !== 'resolved').length}</dd>
        </div>
      </dl>
      {findings.length ? (
        <ul className="findings">
          {findings.map((f) => (
            <li key={f.title} className={`finding sev-${f.severity}`}>
              <span className="finding-icon">{SEVERITY_ICON[f.severity]}</span>
              <div>
                <strong>
                  <span className="finding-tag">{SEVERITY_LABEL[f.severity]}</span> {f.title}
                </strong>
                <p className="muted">{f.detail}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="finding sev-good">
          <span className="finding-icon">{SEVERITY_ICON.good}</span>
          <div>
            <strong>Nothing is held up.</strong>
            <p className="muted">No phase is waiting, no decision or request is open, and nothing has failed.</p>
          </div>
        </div>
      )}
    </div>
  );
}
