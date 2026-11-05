import type { CSSProperties, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Executive, Organisation, PauseReason, SopPhase } from '../shared/types';

/** The fields of a seat that the badge needs; satisfied by executives, profiles and summaries alike. */
export type SeatLike = Pick<Executive, 'short' | 'hue'> & { title?: string };

export function hueStyle(hue: number): CSSProperties {
  return { '--h': String(hue) } as CSSProperties;
}

export function SeatBadge({ seat, size = 'md' }: { seat: SeatLike; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className={`seat-badge seat-badge-${size}`} style={hueStyle(seat.hue)} title={seat.title}>
      {seat.short}
    </span>
  );
}

const SPECIAL_SEATS: Record<string, SeatLike> = {
  shareholders: { short: 'You', hue: 40, title: 'Shareholders' },
  system: { short: 'Org', hue: 220, title: 'The organisation' },
};

/** The seat behind an id in the feed, including the two that are not executives. */
export function seatFor(org: Organisation, id: string): SeatLike {
  return org.executives.find((e) => e.id === id) ?? SPECIAL_SEATS[id] ?? { short: id.slice(0, 5), hue: 220, title: id };
}

export function seatName(org: Organisation, id: string): string {
  const exec = org.executives.find((e) => e.id === id);
  if (exec) return exec.title;
  return SPECIAL_SEATS[id]?.title ?? id;
}

/** A standard operating profile drawn as its sequence of phases. `current` marks where a plan has got to. */
export function Sop({
  phases,
  done = 0,
  current = -1,
  compact = false,
}: {
  phases: Pick<SopPhase, 'name' | 'purpose'>[];
  done?: number;
  current?: number;
  compact?: boolean;
}) {
  return (
    <ol className={`sop${compact ? ' sop-compact' : ''}`}>
      {phases.map((phase, i) => (
        <li key={i} className={i < done ? 'is-done' : i === current ? 'is-current' : ''} title={phase.purpose}>
          {phase.name}
        </li>
      ))}
    </ol>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        components={{
          // Agent-written content can contain any link; open it away from the dashboard.
          a: ({ href, children: label }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {label}
            </a>
          ),
          // An image would be fetched as soon as the text is shown, which tells whoever wrote
          // the text that it was read and can carry data out in the address. Show its label instead.
          img: ({ alt, src }) => <span className="muted">[image: {alt || src}]</span>,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export function money(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function clock(iso: string): string {
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${time}`;
}

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export const PAUSE_REASONS: Record<PauseReason, string> = {
  user: 'Paused',
  budget: 'Paused: budget reached',
  error: 'Paused: something went wrong',
  restart: 'Paused: the server restarted',
  cycle_limit: 'Paused: cycle limit reached',
};

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
  disabled,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <span className="stepper" role="group" aria-label={label}>
      <button type="button" onClick={() => onChange(value - 1)} disabled={disabled || value <= min} aria-label={`Fewer ${label}`}>
        −
      </button>
      <output aria-live="polite">{value}</output>
      <button type="button" onClick={() => onChange(value + 1)} disabled={disabled || value >= max} aria-label={`More ${label}`}>
        +
      </button>
    </span>
  );
}

export function ErrorNote({ children, onDismiss }: { children: ReactNode; onDismiss?: () => void }) {
  if (!children) return null;
  return (
    <div className="note note-bad" role="alert">
      <span>{children}</span>
      {onDismiss ? (
        <button type="button" className="link" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children ? <p>{children}</p> : null}
    </div>
  );
}

/** What changes when plans are carried out in hosted sessions, shown wherever that is chosen. */
export function HostedNotes({ web, runs, simulated }: { web: boolean; runs: boolean; simulated: boolean }) {
  return (
    <>
      <div className="note note-info">
        <div>
          <strong>How hosted sessions work here</strong>
          <ul>
            <li>Each plan runs in one session with a spend cap. What is left of the budget is shared between the plans, and a session cannot spend past its share.</li>
            {runs ? <li>A lead can start a workflow run to put its agents on a phase that has many pieces. Every agent in a run uses tokens, and the session’s cap covers them.</li> : null}
            <li>The number of agents you give a lead is an instruction to it there. The spend cap is the hard limit.</li>
            <li>A session stays in your Anthropic Console after its plan ends, as the plan’s record. Nothing here archives or deletes it.</li>
            {simulated ? <li>In simulation no session is created anywhere: the dashboard shows what one would look like.</li> : null}
          </ul>
        </div>
      </div>
      {web ? (
        <div className="note note-warn">
          <span>
            <strong>Web search opens the sandbox’s network.</strong> With it on, code the agents run in a hosted session can reach any site, not only search. With it off, the sandbox can
            reach package registries and nothing else.
          </span>
        </div>
      ) : null}
    </>
  );
}
