import { useEffect, useState } from 'react';
import type { Organisation, OrgView } from '../shared/types';
import { dependenciesMet, financeTotals, jobOpen, operatingDigest, type BusinessJob } from '../shared/business';
import { api, useAction } from './api';
import { Empty, ErrorNote, Field } from './ui';
import { HelpLink } from './Guide';

type Kind = 'job' | 'customer' | 'metric' | 'finance' | 'memory' | 'event';
type Pane = 'summary' | 'customers' | 'metrics' | 'finances' | 'memory' | 'events' | 'history';
type RecordValue = Record<string, unknown>;
type InputField = { key: string; label: string; type?: 'text' | 'textarea' | 'number' | 'datetime-local'; options?: string[]; required?: boolean };
const FIELDS: Record<Kind, InputField[]> = {
  job: [
    { key: 'title', label: 'Commitment', required: true }, { key: 'description', label: 'What completion requires', type: 'textarea' },
    { key: 'nextAction', label: 'Next action', type: 'textarea' },
    { key: 'status', label: 'Status', options: ['open', 'blocked', 'in_progress', 'review', 'cancelled'] },
    { key: 'blockedReason', label: 'Reason for a blocker or delay', type: 'textarea' },
    { key: 'notBefore', label: 'Earliest start', type: 'datetime-local' }, { key: 'dueAt', label: 'Due', type: 'datetime-local' },
    { key: 'recurrenceDays', label: 'Repeat every N days after verification (blank for once)', type: 'number' },
    { key: 'evidence', label: 'Delivery evidence and where to check it', type: 'textarea' },
  ],
  customer: [
    { key: 'name', label: 'Customer or prospect', required: true },
    { key: 'stage', label: 'Stage', options: ['enquiry', 'qualified', 'customer', 'inactive'] },
    { key: 'contact', label: 'Contact details' }, { key: 'notes', label: 'Requirements and notes', type: 'textarea' }, { key: 'source', label: 'Source' },
  ],
  metric: [
    { key: 'title', label: 'Business objective or measure', required: true }, { key: 'unit', label: 'Unit (orders, GBP, hours…)', required: true },
    { key: 'target', label: 'Target (blank if unknown)', type: 'number' }, { key: 'value', label: 'Current value (blank if unknown)', type: 'number' },
    { key: 'basis', label: 'Basis', options: ['unknown', 'estimate', 'reported', 'confirmed'] },
    { key: 'observedAt', label: 'Observed at', type: 'datetime-local' }, { key: 'source', label: 'Source of the value' },
  ],
  finance: [
    { key: 'title', label: 'Transaction or commitment', required: true }, { key: 'direction', label: 'Direction', options: ['income', 'expense'] },
    { key: 'amount', label: 'Amount (two decimal places)', type: 'number', required: true }, { key: 'currency', label: 'Currency code (GBP, USD, EUR…)', required: true },
    { key: 'status', label: 'Status', options: ['forecast', 'outstanding', 'confirmed', 'void'] },
    { key: 'dueAt', label: 'Due', type: 'datetime-local' }, { key: 'source', label: 'Receipt, invoice or other evidence' },
  ],
  memory: [
    { key: 'title', label: 'Title', required: true }, { key: 'category', label: 'Category', options: ['policy', 'fact', 'decision', 'lesson'] },
    { key: 'content', label: 'Knowledge to retain', type: 'textarea', required: true }, { key: 'source', label: 'Source or reason' },
    { key: 'reviewAt', label: 'Review by', type: 'datetime-local' },
  ],
  event: [
    { key: 'title', label: 'What happened', required: true }, { key: 'detail', label: 'Details', type: 'textarea', required: true },
    { key: 'source', label: 'Source (such as customer inbox)', required: true }, { key: 'externalId', label: 'Unique source event ID', required: true },
    { key: 'dueAt', label: 'Response due', type: 'datetime-local' },
  ],
};
const LABEL: Record<Kind, string> = { job: 'job', customer: 'customer', metric: 'measure', finance: 'financial entry', memory: 'knowledge', event: 'incoming event' };
const dateText = (date: string | null) => date ? new Date(date).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'No date';
const localInput = (date: unknown) => {
  if (!date) return '';
  const d = new Date(String(date));
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const ownerName = (org: Organisation, id: string) => org.executives.find((e) => e.id === id)?.short ?? id;

function Editor({ org, kind, record, onView, onClose }: { org: Organisation; kind: Kind; record?: RecordValue; onView: (view: OrgView) => void; onClose: () => void }) {
  const action = useAction();
  const [values, setValues] = useState<Record<string, string>>(() => {
    const values: Record<string, string> = { ownerId: String(record?.ownerId ?? org.executives.find((e) => e.profileId === 'operations')?.id ?? org.executives.find((e) => e.kind === 'lead')?.id ?? ''), currency: 'GBP' };
    for (const field of FIELDS[kind]) values[field.key] = field.type === 'datetime-local' ? localInput(record?.[field.key]) : String(record?.[field.key] ?? field.options?.[0] ?? values[field.key] ?? '');
    for (const key of ['customerId', 'metricId', 'reviewerId']) values[key] = String(record?.[key] ?? '');
    values.dependsOn = ((record?.dependsOn ?? []) as string[]).join(',');
    if (kind === 'finance' && record) values.amount = (Number(record.amountMinor) / 100).toFixed(2);
    return values;
  });
  const set = (key: string, value: string) => setValues((old) => ({ ...old, [key]: value }));
  const submit = () => action.run(async () => {
    const data: RecordValue = { ownerId: values.ownerId };
    if (kind !== 'event') { data.id = record?.id ?? null; data.revision = record?.revision ?? null; }
    for (const field of FIELDS[kind]) {
      const value = values[field.key] ?? '';
      data[field.key] = field.type === 'datetime-local' ? value ? new Date(value).toISOString() : null : field.type === 'number' ? value === '' ? null : Number(value) : value;
    }
    if (kind === 'finance') {
      data.amountMinor = Math.round(Number(data.amount) * 100); delete data.amount;
      data.currency = String(data.currency).trim().toUpperCase();
    }
    if (['job', 'finance', 'event'].includes(kind)) data.customerId = values.customerId || null;
    if (kind === 'job') {
      data.metricId = values.metricId || null; data.reviewerId = values.reviewerId || null;
      data.dependsOn = values.dependsOn ? values.dependsOn.split(',') : [];
    }
    onView(await api.business(org.id, { kind, record: data }));
    onClose();
  });
  const people = org.executives.filter((e) => e.kind === 'lead' || e.kind === 'ceo');
  return <form className="ops-editor" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
    <div className="row"><h3>{record ? 'Edit' : 'Add'} {LABEL[kind]}</h3><button className="button" type="button" onClick={onClose}>Close</button></div>
    <p className="muted">Times use {Intl.DateTimeFormat().resolvedOptions().timeZone}. A saved change is recorded with its author and revision.</p>
    <div className="grid-2">
      <Field label="Owner"><select value={values.ownerId} onChange={(e) => set('ownerId', e.target.value)}>{people.map((e) => <option key={e.id} value={e.id}>{e.short} — {e.title}</option>)}</select></Field>
      {FIELDS[kind].map((field) => <Field key={field.key} label={field.label}>
        {field.options ? <select value={values[field.key]} onChange={(e) => set(field.key, e.target.value)}>{field.options.map((option) => <option key={option} value={option}>{option.replaceAll('_', ' ')}</option>)}</select> :
          field.type === 'textarea' ? <textarea rows={3} value={values[field.key]} required={field.required} onChange={(e) => set(field.key, e.target.value)} /> :
          <input type={field.type ?? 'text'} value={values[field.key]} required={field.required} step={field.key === 'amount' ? '0.01' : field.key === 'recurrenceDays' ? '1' : field.type === 'number' ? 'any' : undefined} min={field.key === 'amount' ? 0 : field.key === 'recurrenceDays' ? 1 : undefined} onChange={(e) => set(field.key, e.target.value)} />}
      </Field>)}
      {['job', 'finance', 'event'].includes(kind) ? <Field label="Related customer"><select value={values.customerId} onChange={(e) => set('customerId', e.target.value)}><option value="">None</option>{org.business.customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field> : null}
      {kind === 'job' ? <>
        <Field label="Related business objective"><select value={values.metricId} onChange={(e) => set('metricId', e.target.value)}><option value="">None</option>{org.business.metrics.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field>
        <Field label="Independent reviewer"><select value={values.reviewerId} onChange={(e) => set('reviewerId', e.target.value)}><option value="">Owner or a person</option>{people.filter((e) => e.id !== values.ownerId).map((e) => <option key={e.id} value={e.id}>{e.short}</option>)}</select></Field>
        <Field label="Jobs that must be verified first" hint="Use Ctrl/Cmd to select several."><select multiple value={values.dependsOn ? values.dependsOn.split(',') : []} onChange={(e) => set('dependsOn', Array.from(e.target.selectedOptions, (o) => o.value).join(','))}>{org.business.jobs.filter((j) => j.id !== record?.id).map((j) => <option key={j.id} value={j.id}>{j.title} ({j.status})</option>)}</select></Field>
      </> : null}
    </div>
    <ErrorNote onDismiss={action.clearError}>{action.error}</ErrorNote>
    <button className="button button-primary" disabled={action.busy}>{action.busy ? 'Saving…' : 'Save ' + LABEL[kind]}</button>
  </form>;
}

function JobCard({ org, job, onEdit, onView, onOpenPlan }: { org: Organisation; job: BusinessJob; onEdit: () => void; onView: (v: OrgView) => void; onOpenPlan: (id: string) => void }) {
  const action = useAction();
  const [evidence, setEvidence] = useState('');
  const overdue = jobOpen(job) && job.dueAt && Date.parse(job.dueAt) < Date.now();
  const hasPlan = job.plan && org.plans.some((p) => p.id === job.plan!.id);
  return <article className={'ops-card' + (overdue ? ' ops-overdue' : '')}>
    <div className="row"><strong>{job.title}</strong><span className={'tag' + (overdue ? ' tag-warn' : '')}>{overdue ? 'Overdue · ' : ''}{job.status.replaceAll('_', ' ')}</span></div>
    <p className="muted">{job.id} · {ownerName(org, job.ownerId)} · {job.dueAt ? 'Due ' + dateText(job.dueAt) : 'Undated'}{job.notBefore ? ' · Start ' + dateText(job.notBefore) : ''}{job.recurrenceDays ? ' · Every ' + job.recurrenceDays + ' days' : ''}</p>
    {job.description ? <p>{job.description}</p> : null}
    {job.nextAction ? <p><strong>Next:</strong> {job.nextAction}</p> : null}
    {job.blockedReason ? <p className="error">{job.blockedReason}</p> : null}
    {job.dependsOn.length ? <p>Depends on: {job.dependsOn.map((id) => org.business.jobs.find((j) => j.id === id)?.title ?? id).join(', ')}{dependenciesMet(org, job) ? ' — verified' : ' — waiting'}</p> : null}
    {job.customerId ? <p>Customer: {org.business.customers.find((c) => c.id === job.customerId)?.name}</p> : null}
    {job.evidence ? <details><summary>Delivery evidence</summary><p className="ops-pre">{job.evidence}</p></details> : null}
    {job.verification ? <p>Verified by {ownerName(org, job.verification.by)} on {dateText(job.verification.at)}: {job.verification.note}</p> : null}
    <div className="row">
      {jobOpen(job) ? <button type="button" className="button" onClick={onEdit}>Edit commitment</button> : null}
      {hasPlan ? <button type="button" className="button" onClick={() => onOpenPlan(job.plan!.id)}>Open execution plan</button> : job.plan ? <span className="muted">Execution {job.plan.id}, archived cycle {job.plan.cycle}</span> : null}
      {job.reviewerId ? <span className="muted">Reviewer: {ownerName(org, job.reviewerId)}</span> : null}
    </div>
    {job.status === 'review' ? <form className="ops-verification" onSubmit={(e) => { e.preventDefault(); void action.run(async () => { onView(await api.business(org.id, { kind: 'verify', id: job.id, revision: job.revision, evidence })); setEvidence(''); }); }}>
      <Field label="What you checked to confirm delivery"><input value={evidence} required maxLength={200} onChange={(e) => setEvidence(e.target.value)} /></Field>
      <button className="button button-primary" disabled={action.busy || !evidence.trim()}>Verify completion</button>
      <ErrorNote>{action.error}</ErrorNote>
    </form> : null}
  </article>;
}

function Calendar({ jobs, onSelect }: { jobs: BusinessJob[]; onSelect: (id: string) => void }) {
  const [month, setMonth] = useState(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); });
  const start = new Date(month.getFullYear(), month.getMonth(), 1 - ((month.getDay() + 6) % 7));
  const days = Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  const key = (d: Date) => [d.getFullYear(), d.getMonth(), d.getDate()].join('-');
  return <div className="ops-calendar">
    <div className="row"><button type="button" className="button" aria-label="Previous month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}>←</button>
      <strong>{month.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</strong>
      <button type="button" className="button" aria-label="Next month" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}>→</button></div>
    <div className="calendar-grid">{['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div className="calendar-heading" key={d}>{d}</div>)}
      {days.map((day) => <div key={key(day)} className={'calendar-day' + (day.getMonth() === month.getMonth() ? '' : ' calendar-other') + (key(day) === key(new Date()) ? ' calendar-today' : '')}>
        <span>{day.getDate()}</span>{jobs.filter((j) => (j.dueAt && key(new Date(j.dueAt)) === key(day)) || (j.notBefore && key(new Date(j.notBefore)) === key(day))).map((job) =>
          <button key={job.id} type="button" className="calendar-job" title={job.title} onClick={() => onSelect(job.id)}>{job.dueAt && key(new Date(job.dueAt)) === key(day) ? 'Due: ' : 'Start: '}{job.title}</button>)}
      </div>)}
    </div>
  </div>;
}

export function Operations({ org, calendar = false, onView, onOpenPlan }: { org: Organisation; calendar?: boolean; onView: (v: OrgView) => void; onOpenPlan: (id: string) => void }) {
  const [, refreshClock] = useState(0);
  useEffect(() => { const timer = setInterval(() => refreshClock((n) => n + 1), 60_000); return () => clearInterval(timer); }, []);
  const [pane, setPane] = useState<Pane>('summary');
  const [editor, setEditor] = useState<{ kind: Kind; record?: RecordValue } | null>(null);
  const [query, setQuery] = useState('');
  const [showClosed, setShowClosed] = useState(false);
  const [owner, setOwner] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [monthView, setMonthView] = useState(false);
  const action = useAction();
  const b = org.business;
  const edit = (kind: Kind, record?: unknown) => setEditor({ kind, record: record as RecordValue | undefined });
  const jobs = b.jobs.filter((j) => (showClosed || jobOpen(j)) && (!owner || j.ownerId === owner) && (j.title + ' ' + j.description).toLowerCase().includes(query.toLowerCase()))
    .sort((a, c) => (a.dueAt ?? a.notBefore ?? 'z').localeCompare(c.dueAt ?? c.notBefore ?? 'z'));
  const renderJobs = (list: BusinessJob[]) => list.map((job) => <JobCard key={job.id} org={org} job={job} onEdit={() => edit('job', job)} onView={onView} onOpenPlan={onOpenPlan} />);
  const registerPane = pane as Exclude<Pane, 'summary' | 'history'>;
  const kinds: Record<Exclude<Pane, 'summary' | 'history'>, Kind> = { customers: 'customer', metrics: 'metric', finances: 'finance', memory: 'memory', events: 'event' };
  return <div className="operations">
    {editor ? <Editor key={editor.kind + String(editor.record?.id ?? 'new')} org={org} kind={editor.kind} record={editor.record} onView={onView} onClose={() => setEditor(null)} /> : null}
    {calendar ? <>
      <div className="row"><h2>Shared calendar</h2><HelpLink guide="business-operations" section="working-with-the-calendar">How the calendar works</HelpLink><button type="button" className="button button-primary" onClick={() => edit('job')}>Add commitment</button>
        <button type="button" className="button" onClick={() => setMonthView(!monthView)}>{monthView ? 'Show agenda' : 'Show month'}</button></div>
      <p className="muted">Each date belongs to a persistent job. Undated work stays in the agenda. Times use {Intl.DateTimeFormat().resolvedOptions().timeZone}.</p>
      <div className="ops-filters"><input aria-label="Search commitments" placeholder="Find a commitment…" value={query} onChange={(e) => { setQuery(e.target.value); setSelected(null); }} />
        <select aria-label="Filter by owner" value={owner} onChange={(e) => setOwner(e.target.value)}><option value="">All owners</option>{org.executives.filter((e) => e.kind === 'lead' || e.kind === 'ceo').map((e) => <option key={e.id} value={e.id}>{e.short}</option>)}</select>
        <label><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Include completed and cancelled</label></div>
      {monthView ? <Calendar jobs={jobs} onSelect={setSelected} /> : null}
      {selected ? <div className="row"><span>Selected commitment</span><button type="button" className="button" onClick={() => setSelected(null)}>Show all</button></div> : null}
      <div className="ops-list">{renderJobs(selected ? jobs.filter((j) => j.id === selected) : jobs)}</div>
      {!jobs.length ? <Empty title="No commitments to show.">Add a job or start a cycle. New execution plans create linked commitments automatically.</Empty> : null}
    </> : <>
      <nav className="ops-nav" aria-label="Business registers">{(['summary', 'customers', 'metrics', 'finances', 'memory', 'events', 'history'] as Pane[]).map((p) => <button type="button" className={'button' + (pane === p ? ' button-primary' : '')} key={p} onClick={() => setPane(p)}>{({ summary: 'Digest', customers: 'Customers', metrics: 'Scorecard', finances: 'Finances', memory: 'Knowledge', events: 'Events', history: 'History' })[p]}</button>)}</nav>
      {pane === 'summary' ? <>
        <div className="row"><h2>Operating digest</h2><button type="button" className="button" disabled={action.busy} onClick={() => void action.run(async () => onView(await api.reviewNow(org.id)))}>Request a review</button></div>
        <p className="ops-pre">{operatingDigest(org)}</p>
        <p className="muted">{org.status === 'running' && b.waiting ? 'Waiting for the next scheduled review, event or calendar date. No model calls while waiting.' : org.status === 'paused' ? 'Paused. New events are saved and will be considered when resumed.' : 'Operating records are shared with the executive team and agents.'}</p>
        {b.nextReviewAt ? <p>Next standing review: {dateText(b.nextReviewAt)}</p> : null}
        <h3>Awaiting verification</h3><div className="ops-list">{renderJobs(b.jobs.filter((j) => j.status === 'review'))}</div>
        {!b.jobs.some((j) => j.status === 'review') ? <p className="muted">No deliveries awaiting verification.</p> : null}
        {b.lastDigest ? <details><summary>Digest at the last cycle close</summary><p className="ops-pre">{b.lastDigest}</p></details> : null}
      </> : pane === 'history' ? <>
        <h2>Record history</h2><p className="muted">Edits retain the previous record. Showing the most recent 100 changes.</p>
        {[...b.audit].reverse().slice(0, 100).map((a, i) => <details className="ops-card" key={i}><summary>{dateText(a.at)} · {ownerName(org, a.by)} · {a.kind} · {a.recordId}</summary><p>{a.note || 'Record updated.'}</p><pre className="ops-json">{JSON.stringify(a.before, null, 2)}</pre></details>)}
      </> : <>
        <div className="row"><h2>{({ customers: 'Customers and prospects', metrics: 'Business scorecard', finances: 'Financial records', memory: 'Organisational knowledge', events: 'Incoming events' })[registerPane]}</h2><button type="button" className="button button-primary" onClick={() => edit(kinds[registerPane])}>Add {LABEL[kinds[registerPane]]}</button></div>
        {pane === 'finances' ? <><p className="muted">Records and forecasts do not move money. Confirm an actual transaction only after checking its receipt. Model spending is shown separately in the digest.</p>{financeTotals(b.finances).map((f) => <p key={f.currency}><strong>{f.currency}</strong> · Income {(f.income / 100).toFixed(2)} · Expenses {(f.expense / 100).toFixed(2)} · Receivables {(f.outstandingIncome / 100).toFixed(2)} · Payables {(f.outstandingExpense / 100).toFixed(2)}</p>)}</> : null}
        {pane === 'events' ? <p className="muted">Each event creates an owned commitment and requests an operating review. Repeating the same source and event ID is ignored. The local API accepts the same event form.</p> : null}
        <div className="ops-list">{b[registerPane].map((record) => {
          const r = record as unknown as RecordValue;
          return <article className="ops-card" key={record.id}>
            <div className="row"><strong>{String(r.title ?? r.name)}</strong><span className="muted">{ownerName(org, String(r.ownerId))} · {record.id}</span></div>
            {pane === 'customers' ? <><p>{String(r.stage)} · {String(r.contact)}</p><p className="ops-pre">{String(r.notes)}</p><p>{b.jobs.filter((j) => j.customerId === record.id && jobOpen(j)).length} open commitments</p></> : null}
            {pane === 'metrics' ? <><p><strong>{r.value === null ? 'Unknown' : String(r.value)} {String(r.unit)}</strong> · Target {r.target === null ? 'not set' : String(r.target)} · {String(r.basis)}</p><p>Observed: {dateText(r.observedAt as string | null)}</p></> : null}
            {pane === 'finances' ? <p>{String(r.currency)} {(Number(r.amountMinor) / 100).toFixed(2)} · {String(r.direction)} · {String(r.status)} · {dateText(r.dueAt as string | null)}</p> : null}
            {pane === 'memory' ? <><p>{String(r.category)}{r.reviewAt ? ' · Review ' + dateText(String(r.reviewAt)) : ''}</p><p className="ops-pre">{String(r.content)}</p></> : null}
            {pane === 'events' ? <><p className="ops-pre">{String(r.detail)}</p><p>Event {String(r.externalId)} · Commitment {String(r.jobId)}</p></> : null}
            <p className="muted">Source: {String(r.source || 'not recorded')} · Updated {dateText(record.updatedAt)}</p>
            {pane !== 'events' ? <button type="button" className="button" onClick={() => edit(kinds[registerPane], record)}>Edit</button> : null}
          </article>;
        })}</div>
        {!b[registerPane].length ? <Empty title="No records yet.">Add known information here. Agents can maintain records within their remit as they work.</Empty> : null}
      </>}
      <ErrorNote>{action.error}</ErrorNote>
    </>}
  </div>;
}
