import { FileText, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MEMORY_KIND_LABEL, words, type MemoryHit, type MemoryKind, type MemorySearch, type MemoryStats, type MemoryUse } from '../shared/memory';
import type { Organisation } from '../shared/types';
import { api } from './api';
import { Empty, ErrorNote, SeatBadge, clock, seatFor } from './ui';

// The organisation's memory, for a person: a search over everything it has reported, decided, planned and written,
// in every cycle. It is the same search an agent makes with its recall tool, and the one that picks what a lead is shown.

/** What a person was last looking for here. Kept by the dashboard, so that it is still here after a look at a file or a plan. */
export interface MemoryAsk {
  query: string;
  kind: MemoryKind | null;
}

const KINDS: Array<{ id: MemoryKind | null; label: string }> = [
  { id: null, label: 'Everything' },
  { id: 'report', label: 'Reports' },
  { id: 'decision', label: 'Decisions' },
  { id: 'plan', label: 'Plans' },
  { id: 'task', label: 'Agents’ task reports' },
  { id: 'cycle', label: 'Cycles' },
  { id: 'steer', label: 'Steer' },
  { id: 'request', label: 'Signing and paying' },
  { id: 'knowledge', label: 'Business knowledge' },
  { id: 'file', label: 'Files' },
];

/** Each kind as it is counted: one of them, and several. */
const COUNTED: Array<[MemoryKind, string, string]> = [
  ['report', 'report to the board', 'reports to the board'],
  ['decision', 'decision', 'decisions'],
  ['plan', 'plan', 'plans'],
  ['task', 'agent’s task report', 'agents’ task reports'],
  ['cycle', 'cycle summed up', 'cycles summed up'],
  ['steer', 'shareholder steer', 'shareholder steers'],
  ['request', 'request to the signatory', 'requests to the signatory'],
  ['knowledge', 'piece of business knowledge', 'pieces of business knowledge'],
];

/** How much the memory holds, in a sentence. */
export function holds(stats: MemoryStats): string {
  const counts = COUNTED.filter(([kind]) => stats.byKind[kind] > 0).map(([kind, one, many]) => `${stats.byKind[kind]} ${stats.byKind[kind] === 1 ? one : many}`);
  if (stats.files) counts.push(`${stats.files} ${stats.files === 1 ? 'file' : 'files'}`);
  if (!counts.length) return '';
  const listed = counts.length === 1 ? counts[0]! : `${counts.slice(0, -1).join(', ')} and ${counts.at(-1)}`;
  const span = !stats.cycles ? '' : stats.cycles.from === stats.cycles.to ? `, from cycle ${stats.cycles.from}` : `, from cycles ${stats.cycles.from} to ${stats.cycles.to}`;
  return `It holds ${listed}${span}.`;
}

/** A text with the words that were asked about marked in it. They are found the way the search finds them: prices marks price, and pricing. */
function Marked({ text, wanted }: { text: string; wanted: ReadonlySet<string> }) {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu)) {
    if (!words(match[0]).some((word) => wanted.has(word))) continue;
    if (match.index > last) out.push(text.slice(last, match.index));
    out.push(<mark key={match.index}>{match[0]}</mark>);
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return <>{out}</>;
}

/** The plan a remembered item belongs to, where that plan is still in front of the board. Older plans are read here. */
function livePlanOf(org: Organisation, hit: MemoryHit): string | null {
  const id = hit.id.slice(hit.id.indexOf(':') + 1);
  const planId =
    hit.kind === 'plan'
      ? id
      : hit.kind === 'task'
        ? org.plans.find((plan) => plan.phases.some((phase) => phase.tasks.some((task) => task.id === id)))?.id
        : hit.kind === 'report'
          ? org.reports.find((report) => report.id === id)?.planId
          : hit.kind === 'decision'
            ? org.decisions.find((decision) => decision.id === id)?.planId
            : null;
  return planId && org.plans.some((plan) => plan.id === planId) ? planId : null;
}

function Hit({ org, hit, wanted, onOpenPlan, onOpenFile }: { org: Organisation; hit: MemoryHit; wanted: ReadonlySet<string>; onOpenPlan: (planId: string) => void; onOpenFile: (path: string) => void }) {
  const [whole, setWhole] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const planId = livePlanOf(org, hit);
  const toggle = () => {
    if (open || whole !== null) {
      setOpen(!open);
      return;
    }
    setBusy(true);
    setError(null);
    api.remembered(org.id, hit.id).then(
      (item) => {
        setWhole(item.text);
        setOpen(true);
        setBusy(false);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  return (
    <article className="msg memory-hit">
      {hit.kind === 'file' ? (
        <span className="memory-file" aria-hidden="true">
          <FileText size={15} />
        </span>
      ) : (
        <SeatBadge seat={seatFor(org, hit.from || 'system')} />
      )}
      <div className="msg-body">
        <header>
          <span className="msg-kind">
            {MEMORY_KIND_LABEL[hit.kind]}
            {hit.cycle !== null ? ` · cycle ${hit.cycle}` : ''}
          </span>
          <h3>{hit.kind === 'file' ? <code>{hit.title}</code> : hit.title}</h3>
          {hit.at ? <time dateTime={hit.at}>{clock(hit.at)}</time> : null}
        </header>
        {/* Shown as written: what an agent wrote is not laid out here, so nothing in it can pass for a link or a control of this page. */}
        <p className="pre-wrap">
          <Marked text={open && whole !== null ? whole : hit.excerpt} wanted={wanted} />
        </p>
        <div className="row memory-more">
          {/* A file is read where files are read, whole. */}
          {hit.kind === 'file' && hit.path ? (
            <button type="button" className="link" onClick={() => onOpenFile(hit.path!)}>
              Open the file
            </button>
          ) : (
            <button type="button" className="link" onClick={toggle} disabled={busy} aria-expanded={open}>
              {busy ? 'Fetching…' : open ? 'Show the passage only' : 'Read all of it'}
            </button>
          )}
          {planId ? (
            <button type="button" className="link" onClick={() => onOpenPlan(planId)}>
              Open the plan
            </button>
          ) : null}
          {hit.asked > 1 ? (
            <span className="muted">
              Has {hit.matched} of the {hit.asked} words asked about
            </span>
          ) : null}
        </div>
        {error ? <p className="note note-bad">{error}</p> : null}
      </div>
    </article>
  );
}

/** One thing the memory gave: what it is, and the whole of it on asking. A file is read where files are read. */
function UsedItem({ org, item, onOpenFile }: { org: Organisation; item: MemoryUse['items'][number]; onOpenFile: (path: string) => void }) {
  const [whole, setWhole] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = () => {
    if (open || whole !== null) {
      setOpen(!open);
      return;
    }
    setBusy(true);
    setError(null);
    api.remembered(org.id, item.id).then(
      (found) => {
        setWhole(found.text);
        setOpen(true);
        setBusy(false);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  return (
    <li>
      <span className="muted">
        {MEMORY_KIND_LABEL[item.kind]}
        {item.cycle !== null ? ` · cycle ${item.cycle}` : ''}
      </span>{' '}
      {item.kind === 'file' && item.path ? (
        <button type="button" className="link" onClick={() => onOpenFile(item.path!)}>
          <code>{item.path}</code>
        </button>
      ) : (
        <button type="button" className="link" onClick={toggle} disabled={busy} aria-expanded={open}>
          {item.title}
        </button>
      )}
      {/* Shown as written, like everything the memory quotes: nothing in it can pass for a link or a control of this page. */}
      {open && whole !== null ? <p className="pre-wrap memory-whole">{whole}</p> : null}
      {error ? <p className="note note-bad">{error}</p> : null}
    </li>
  );
}

/** How a use is headed: who it was shown to, or who searched. The seat is named, since the CEO and the signatory are shown things too. */
const usedBy = (use: MemoryUse, seat: string): string => (use.by === 'shown' ? `shown to the ${seat}` : use.by === 'agent' ? 'searched by an agent' : `searched by the ${seat}`);

/** Why the memory has not been put to use yet, as far as the page can tell. */
function unusedBecause(org: Organisation): string {
  const searches = 'What an agent searches for is listed here too, when one does.';
  if (!org.settings.recall) return `Nothing yet. Leads are not being shown any of it: that is switched off in the settings. ${searches}`;
  if (org.cycle.number <= 1) return `Nothing yet. A lead is shown what earlier cycles left, and what the files in the workspace say, on the matter it is about to decide. This organisation is in its first cycle, so there is little to show one. ${searches}`;
  return `Nothing yet. A lead is shown passages only where the record shares enough with the matter it is about to decide. ${searches}`;
}

/**
 * The memory at work: the latest times a lead was shown something from it, or something searched it. Without this a
 * person has no way to tell from a run whether the memory did anything at all.
 */
export function MemoryUses({ org, onOpenFile }: { org: Organisation; onOpenFile: (path: string) => void }) {
  const uses = [...(org.memoryUses ?? [])].reverse();
  return (
    <section className="memory-uses" aria-label="The memory at work">
      <h3>The memory at work</h3>
      {uses.length === 0 ? (
        <p className="muted">{unusedBecause(org)}</p>
      ) : (
        <>
          <p className="muted">The latest times it was put to use, newest first: what a lead was shown before it decided, and what was searched for.</p>
          <ol className="feed">
            {uses.map((use, index) => {
              const seat = seatFor(org, use.seatId);
              return (
              <li key={use.at + index}>
                <article className="msg memory-use">
                  <SeatBadge seat={seat} />
                  <div className="msg-body">
                    <header>
                      <span className="msg-kind">
                        {usedBy(use, seat.short)} · cycle {use.cycle}
                      </span>
                      <h3>{use.by === 'shown' ? use.about : `“${use.about}”`}</h3>
                      {use.at ? <time dateTime={use.at}>{clock(use.at)}</time> : null}
                    </header>
                    {use.items.length ? (
                      <ul className="memory-used">
                        {use.items.map((item) => (
                          <UsedItem key={item.id} org={org} item={item} onOpenFile={onOpenFile} />
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">It found nothing.</p>
                    )}
                  </div>
                </article>
              </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

export function Memory({ org, asked, onAsk, onOpenPlan, onOpenFile }: { org: Organisation; asked: MemoryAsk; onAsk: (ask: MemoryAsk) => void; onOpenPlan: (planId: string) => void; onOpenFile: (path: string) => void }) {
  const [draft, setDraft] = useState(asked.query);
  const [found, setFound] = useState<MemorySearch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Counts the searches sent, so that an answer which comes back after a later one was asked for is left unshown.
  const sent = useRef(0);
  // Bumped to ask again for the same thing: the organisation may have written more since.
  const [again, setAgain] = useState(0);

  useEffect(() => {
    const mine = ++sent.current;
    setBusy(true);
    setError(null);
    api.memory(org.id, asked.query, asked.kind).then(
      (answer) => {
        if (mine !== sent.current) return;
        setFound(answer);
        setBusy(false);
      },
      (err: Error) => {
        if (mine !== sent.current) return;
        setError(err.message);
        setBusy(false);
      },
    );
  }, [org.id, asked.query, asked.kind, again]);

  const wanted = useMemo(() => new Set(words(asked.query)), [asked.query]);
  const stats = found?.stats;
  const empty = stats !== undefined && stats.items === 0;

  return (
    <div className="memory">
      <form
        className="memory-ask"
        role="search"
        onSubmit={(event) => {
          event.preventDefault();
          const query = draft.trim();
          if (query === asked.query) setAgain((n) => n + 1);
          else onAsk({ ...asked, query });
        }}
      >
        <label className="field">
          <span className="field-label">Search what the organisation remembers</span>
          <input type="search" value={draft} maxLength={1000} onChange={(event) => setDraft(event.target.value)} placeholder="A supplier, a decision, a figure, a file…" disabled={empty} />
        </label>
        {/* Left on while a search is on its way: a form whose button is off does nothing when Enter is pressed, and what was typed then would be dropped. */}
        <button type="submit" className="button button-primary" disabled={empty}>
          <Search size={15} aria-hidden="true" /> {busy && asked.query ? 'Searching…' : 'Search'}
        </button>
      </form>
      <div className="chips" role="group" aria-label="Look among">
        {KINDS.map((kind) => (
          <button key={kind.id ?? 'all'} type="button" className={`chip${asked.kind === kind.id ? ' is-on' : ''}`} onClick={() => onAsk({ ...asked, kind: kind.id })} aria-pressed={asked.kind === kind.id}>
            {kind.label}
          </button>
        ))}
      </div>
      <ErrorNote onDismiss={() => setError(null)}>{error}</ErrorNote>
      {stats?.unread.length ? (
        <div className="note note-warn">
          <span>
            {stats.unread.length === 1 ? `Cycle ${stats.unread[0]} is` : `Cycles ${stats.unread.slice(0, -1).join(', ')} and ${stats.unread.at(-1)} are`} in the archive but could not be read, so
            nothing from {stats.unread.length === 1 ? 'it' : 'them'} is found here. The rest is unaffected, and the archive is tried again at every search.
          </span>
        </div>
      ) : null}

      {empty ? (
        <Empty title="There is nothing to remember yet.">
          Everything the organisation reports, decides, plans and writes can be found here afterwards, however many cycles ago it was.
        </Empty>
      ) : !found ? (
        error ? null : (
          <p className="muted">Loading…</p>
        )
      ) : !asked.query ? (
        <>
          <div className="memory-about">
            <p>
              Everything the organisation has reported, decided, planned and written, in every cycle, can be found here: cycles long closed among them, and the text of the files in the
              workspace. {stats ? holds(stats) : ''}
            </p>
            <p className="muted">
              It finds what shares words with what you ask, not what means the same in other words, so ask in the words the thing itself would use.{' '}
              {org.settings.recall
                ? 'Before a lead directs, plans or rules, it is shown the passages from earlier cycles that bear most on the matter. That can be switched off in the settings.'
                : 'Leads are not being shown any of it before they decide: that is switched off in the settings.'}{' '}
              Agents search it themselves when their work calls for it.
            </p>
            {stats?.leftOut ? (
              <p className="muted">
                {stats.leftOut} of the oldest {stats.leftOut === 1 ? 'task report is' : 'task reports are'} not held, to keep the memory within its size. What was reported to the board about that work is.
              </p>
            ) : null}
          </div>
          <MemoryUses org={org} onOpenFile={onOpenFile} />
        </>
      ) : found.hits.length === 0 ? (
        <Empty title="Nothing remembered shares those words.">
          {asked.kind ? 'Try looking among everything, or use ' : 'Use '}the words the thing itself would use, or fewer of them. A search finds words, not meanings.
        </Empty>
      ) : (
        <ol className="feed memory-hits" aria-label="What was found">
          {found.hits.map((hit) => (
            <li key={hit.id}>
              <Hit org={org} hit={hit} wanted={wanted} onOpenPlan={onOpenPlan} onOpenFile={onOpenFile} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
