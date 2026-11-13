import { StepForward } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { OrgView, Pace } from '../shared/types';
import { api, useAction } from './api';

const PACES: Array<{ id: Pace; label: string; detail: string }> = [
  { id: 'step', label: 'Step', detail: 'Nothing starts until you press Next step, and then only one piece of work.' },
  { id: 'slow', label: 'Slow', detail: 'One piece of work at a time, with a 20 second pause after each to read what it did.' },
  { id: 'steady', label: 'Steady', detail: 'One piece of work at a time, each starting as soon as the last finishes.' },
  { id: 'free', label: 'Full speed', detail: 'As much at once as the settings allow, as fast as the model provider answers.' },
];

function useSecondsUntil(at: string | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!at) return;
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [at]);
  return at ? Math.max(0, Math.ceil((Date.parse(at) - now) / 1000)) : null;
}

/**
 * How fast the organisation moves on, and at the step pace, the button that moves it on. `compact` is for where there
 * is one line to put it in: what comes next is then said by the button and on hovering, and not written out beneath.
 */
export function PaceControl({ view, onView, compact = false }: { view: OrgView; onView: (view: OrgView) => void; compact?: boolean }) {
  const { org, active, pace } = view;
  const action = useAction();
  const seconds = useSecondsUntil(pace.nextAt);
  const running = org.status === 'running';
  const current = org.settings.pace;
  const short = (execId: string) => org.executives.find((e) => e.id === execId)?.short ?? execId;
  const next = pace.next[0];
  const calls = active.filter((a) => a.kind !== 'execute').length;

  let note: string | null = null;
  if (running && current !== 'free') {
    if (next && current === 'step') note = `Next: ${short(next.execId)} · ${next.label}`;
    else if (next && seconds !== null) note = `Next in ${seconds}s: ${short(next.execId)} · ${next.label}`;
    else if (calls) note = 'Waiting for the work under way to finish.';
    else if (!next) note = 'Nothing is ready to start.';
  }

  return (
    <div className="strip-item pace" title={compact ? (note ?? undefined) : undefined}>
      <span className="field-label">Pace</span>
      <div className="pace-row">
        <div className="pace-options" role="radiogroup" aria-label="Pace">
          {PACES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={current === p.id}
              className={current === p.id ? 'is-on' : ''}
              title={p.detail}
              disabled={action.busy}
              onClick={() => current !== p.id && void action.run(async () => onView(await api.settings(org.id, { pace: p.id })))}
            >
              {p.label}
            </button>
          ))}
        </div>
        {current === 'step' && running ? (
          <button
            type="button"
            className="button button-primary"
            disabled={action.busy || !next}
            title={next ? `${short(next.execId)} · ${next.label}` : calls ? 'Waiting for the work under way to finish' : 'Nothing is ready to start'}
            onClick={() => void action.run(async () => onView(await api.step(org.id)))}
          >
            <StepForward size={15} aria-hidden="true" /> Next step
          </button>
        ) : null}
      </div>
      {note && !compact ? <span className="muted pace-note" aria-live="polite">{note}</span> : null}
      {action.error ? <span className="pace-error" role="alert">{action.error}</span> : null}
    </div>
  );
}
