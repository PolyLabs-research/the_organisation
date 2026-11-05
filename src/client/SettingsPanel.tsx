import { Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { Effort, Organisation, OrgSettings, OrgView } from '../shared/types';
import { api, useAction, type Meta } from './api';
import { navigate } from './App';
import { ModelPicker, canHost, canSearch } from './ModelPicker';
import { ErrorNote, Field, HostedNotes } from './ui';

const EFFORTS: Array<{ id: Effort; label: string }> = [
  { id: 'low', label: 'Low: fastest and cheapest' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra high' },
  { id: 'max', label: 'Maximum: slowest and most thorough' },
];

export function SettingsPanel({ org, meta, onClose, onView }: { org: Organisation; meta: Meta; onClose: () => void; onView: (view: OrgView) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<OrgSettings>(org.settings);
  const [limitCycles, setLimitCycles] = useState(org.settings.maxCycles !== null);
  const [fellBack, setFellBack] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useAction();
  const remove = useAction();
  const archive = useAction();
  const [archived, setArchived] = useState<string | null>(null);
  // Sessions that could be archived now: those of plans that are over, and any that were lost and replaced.
  const archivable = org.plans.reduce((n, plan) => {
    const session = plan.managed;
    if (!session) return n;
    const over = plan.status === 'done' || plan.status === 'cancelled' || plan.status === 'failed';
    return n + (over && session.sessionId && !session.archivedAt ? 1 : 0) + (session.past ?? []).filter((p) => !p.archivedAt).length;
  }, 0);
  const set = <K extends keyof OrgSettings>(key: K, value: OrgSettings[K]) => setDraft((s) => ({ ...s, [key]: value }));

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const submit = () =>
    save.run(async () => {
      onView(await api.settings(org.id, { ...draft, maxCycles: limitCycles ? (draft.maxCycles ?? org.cycle.number) : null }));
      onClose();
    });

  const models = meta.provider.models;
  const hostable = meta.provider.managed && canHost(models, draft.executiveModel, draft.workerModel);
  const searchable = canSearch(models, draft.workerModel);
  /** Hosted sessions need both models on one Anthropic key. A choice that rules them out puts new plans back on this machine, and says so. */
  const setModel = (key: 'executiveModel' | 'workerModel', value: string) => {
    const next = { ...draft, [key]: value };
    const lost = next.execution === 'managed' && !canHost(models, next.executiveModel, next.workerModel);
    setDraft(lost ? { ...next, execution: 'local' } : next);
    if (lost) setFellBack(true);
  };
  return (
    <dialog ref={dialog} className="dialog" onClose={onClose} aria-labelledby="settings-title">
      <header className="dialog-head">
        <h2 id="settings-title">Settings for {org.name}</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close settings">
          <X size={18} />
        </button>
      </header>
      <div className="dialog-body">
        <div className="grid-2">
          <Field label="Budget (US dollars)" hint={`${meta.provider.simulated ? 'Simulated' : 'Estimated'} spend so far: $${org.usage.costUsd.toFixed(2)}. The organisation pauses itself when it reaches the budget.`}>
            <input type="number" min={0.1} step={0.5} value={draft.budgetUsd} onChange={(e) => set('budgetUsd', Number(e.target.value))} />
          </Field>
          <Field label="Decisions between leads are signed off by">
            <select value={draft.arbiter} onChange={(e) => set('arbiter', e.target.value as OrgSettings['arbiter'])}>
              <option value="ceo">The CEO</option>
              <option value="judge">An independent judge</option>
            </select>
          </Field>
          <Field
            label="The signatory, who signs and pays, is"
            hint={
              draft.signatory === 'ai'
                ? 'An AI seat authorises or declines each request by what the shareholders want. Nothing here can move money or sign a document, so what it authorises still waits for you to carry out.'
                : 'Requests come to you. You pay or sign outside this system, and tell the organisation in the Signatory tab what you did or why you refused.'
            }
          >
            <select value={draft.signatory} onChange={(e) => set('signatory', e.target.value as OrgSettings['signatory'])}>
              <option value="human">You: a person</option>
              <option value="ai">An AI seat</option>
            </select>
          </Field>
          <Field label="Follow-up work per cycle" hint="How far one board report may set off further plans before the CEO takes stock.">
            <select value={draft.maxFollowUpDepth} onChange={(e) => set('maxFollowUpDepth', Number(e.target.value))}>
              <option value={0}>None</option>
              <option value={1}>One round</option>
              <option value={2}>Two rounds</option>
              <option value={3}>Three rounds</option>
            </select>
          </Field>
          <Field label="Tasks a lead may hand out per phase">
            <input type="number" min={1} max={12} value={draft.maxTasksPerPhase} onChange={(e) => set('maxTasksPerPhase', Number(e.target.value))} />
          </Field>
          <ModelPicker label="Model for the executives" value={draft.executiveModel} models={models} onChange={(id) => setModel('executiveModel', id)} />
          <ModelPicker label="Model for the agents" value={draft.workerModel} models={models} onChange={(id) => setModel('workerModel', id)} />
          <Field label="Effort for the executives">
            <select value={draft.executiveEffort} onChange={(e) => set('executiveEffort', e.target.value as Effort)}>
              {EFFORTS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Effort for the agents">
            <select value={draft.workerEffort} onChange={(e) => set('workerEffort', e.target.value as Effort)}>
              {EFFORTS.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Model calls in flight at once" hint="Lower this if you hit rate limits.">
            <input type="number" min={1} max={16} value={draft.maxConcurrentCalls} onChange={(e) => set('maxConcurrentCalls', Number(e.target.value))} />
          </Field>
          <Field
            label="The leads’ agents do their work"
            hint={`On this machine they write files and run nothing. In a hosted session they share a sandbox where work can be run. A plan under way finishes the way it began.${
              hostable ? '' : ' Hosted sessions need Claude models from one Anthropic key, for both the executives and the agents.'
            }`}
          >
            <select
              value={draft.execution}
              onChange={(e) => {
                set('execution', e.target.value as OrgSettings['execution']);
                setFellBack(false);
              }}
            >
              <option value="local">On this machine</option>
              <option value="managed" disabled={!hostable}>
                In hosted sessions
              </option>
            </select>
          </Field>
        </div>
        {fellBack ? (
          <div className="note note-warn">
            <span>Hosted sessions need Claude models from one Anthropic key, for both the executives and the agents. With this choice, new plans are carried out on this machine.</span>
          </div>
        ) : null}
        {meta.keys ? (
          <p className="muted">
            To use another provider’s models, add an API key under{' '}
            <a href="#/models" target="_blank" rel="noreferrer noopener">
              Models and keys
            </a>{' '}
            (it opens in a new tab, and the lists here follow when you come back). A change of model applies from the next call; work already done is kept.
          </p>
        ) : null}
        {draft.execution === 'managed' ? (
          <>
            <label className="check">
              <input type="checkbox" checked={draft.workflowRuns} onChange={(e) => set('workflowRuns', e.target.checked)} />
              <span>
                <strong>Let leads start workflow runs.</strong> For a phase with many pieces, a lead can have its agents work through them in the background. Every agent in a run uses
                tokens.
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={draft.archiveSessions} onChange={(e) => set('archiveSessions', e.target.checked)} />
              <span>
                <strong>Archive each plan’s session once the plan is over.</strong> Otherwise sessions build up in your Anthropic Console, one for every plan. Archiving cannot be undone.
              </span>
            </label>
            <HostedNotes web={draft.webResearch && searchable} runs={draft.workflowRuns} archive={draft.archiveSessions} simulated={meta.provider.simulated} />
          </>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={draft.webResearch && searchable} disabled={!searchable} onChange={(e) => set('webResearch', e.target.checked)} />
          <span>
            <strong>Let agents search the web.</strong>{' '}
            {searchable ? 'Searches are billed separately by Anthropic.' : 'Not available with the model chosen for the agents: here, only agents on Claude models can search.'}
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={limitCycles} onChange={(e) => setLimitCycles(e.target.checked)} />
          <span>
            <strong>Stop after cycle</strong>
            {limitCycles ? (
              <input
                className="inline-number"
                type="number"
                min={1}
                value={draft.maxCycles ?? org.cycle.number}
                onChange={(e) => set('maxCycles', Math.max(1, Number(e.target.value) || 1))}
                aria-label="Last cycle to run"
              />
            ) : (
              <span className="muted"> (currently no limit: the loop runs until paused or out of budget)</span>
            )}
          </span>
        </label>
        <ErrorNote onDismiss={save.clearError}>{save.error}</ErrorNote>

        {archivable || archived ? (
          <div className="row">
            {archivable ? (
              <button
                type="button"
                className="button"
                disabled={archive.busy}
                onClick={() =>
                  void archive.run(async () => {
                    const result = await api.archiveSessions(org.id);
                    onView(result.view);
                    setArchived(
                      `${result.archived} session${result.archived === 1 ? '' : 's'} archived${result.left ? `; ${result.left} still working and left as ${result.left === 1 ? 'it is' : 'they are'}` : ''}.`,
                    );
                  })
                }
              >
                {archive.busy ? 'Archiving…' : `Archive the ${archivable === 1 ? 'session' : `${archivable} sessions`} of plans that are over`}
              </button>
            ) : null}
            <span className="muted">{archived ?? 'Archived sessions stay readable in the Console but can no longer be changed. This cannot be undone.'}</span>
          </div>
        ) : null}
        <ErrorNote onDismiss={archive.clearError}>{archive.error}</ErrorNote>

        <div className="danger">
          {confirmDelete ? (
            <>
              <span>
                Delete {org.name}, with every plan, decision and file it produced? This cannot be undone.
                {org.plans.some((p) => p.managed?.sessionId)
                  ? org.settings.archiveSessions
                    ? ' Its hosted sessions are archived, not deleted: they stay readable in your Anthropic Console.'
                    : ' Its hosted sessions are left as they are in your Anthropic Console.'
                  : ''}
              </span>
              <button
                type="button"
                className="button button-danger"
                disabled={remove.busy}
                onClick={() =>
                  void remove.run(async () => {
                    await api.remove(org.id);
                    navigate('/');
                  })
                }
              >
                {remove.busy ? 'Deleting…' : 'Yes, delete it'}
              </button>
              <button type="button" className="button" onClick={() => setConfirmDelete(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="button button-quiet-danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={15} aria-hidden="true" /> Delete this organisation
            </button>
          )}
          <ErrorNote onDismiss={remove.clearError}>{remove.error}</ErrorNote>
        </div>
      </div>
      <footer className="dialog-foot">
        <button type="button" className="button" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="button button-primary" onClick={submit} disabled={save.busy}>
          {save.busy ? 'Saving…' : 'Save settings'}
        </button>
      </footer>
    </dialog>
  );
}
