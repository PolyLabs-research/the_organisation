import { ArrowLeft, ExternalLink, KeyRound, RefreshCw, SquareTerminal, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ConnectionInfo, ModelOption, PresetInfo } from '../shared/types';
import { api, useAction, type KeysView, type Meta } from './api';
import { TIER as TIER_WORDS, dollars as price } from './ModelPicker';
import { ErrorNote, Field, clock } from './ui';

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const TIER = Object.fromEntries(Object.entries(TIER_WORDS).map(([tier, words]) => [tier, sentence(words)])) as Record<NonNullable<ModelOption['tier']>, string>;

/** A date from the server, such as the day prices were read, in the reader's own form. */
const day = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** One model's price, and a way to set it. A price set here stands over the list price. */
function PriceCell({ connectionId, model, onView }: { connectionId: string; model: ModelOption; onView: (view: KeysView) => void }) {
  const [editing, setEditing] = useState(false);
  const [input, setInput] = useState(String(model.inputPerMTok));
  const [output, setOutput] = useState(String(model.outputPerMTok));
  const save = useAction();
  const id = model.id.slice(model.id.indexOf(':') + 1);
  // An emptied box is not a price of nothing.
  const amount = (text: string) => (text.trim() === '' ? NaN : Number(text));
  const valid = amount(input) >= 0 && amount(output) >= 0;
  const send = (value: { input: number | null; output?: number }) =>
    save.run(async () => {
      onView(await api.patchConnection(connectionId, { price: { model: id, ...value } }));
      setEditing(false);
    });

  if (!editing) {
    return (
      <span className="price-cell">
        {model.priced ? (
          <span className="num">
            {price(model.inputPerMTok)} in · {price(model.outputPerMTok)} out
          </span>
        ) : (
          <span className="tag tag-warn" title={`Until a price is set, spend on this model is counted at ${price(model.inputPerMTok)} in and ${price(model.outputPerMTok)} out per million tokens.`}>
            Price not known
          </span>
        )}
        <button type="button" className="link" onClick={() => setEditing(true)}>
          {model.priced ? 'Change' : 'Set price'}
        </button>
      </span>
    );
  }
  return (
    <span className="price-cell price-edit">
      <label>
        In $
        <input type="number" min={0} step="0.01" value={input} onChange={(e) => setInput(e.target.value)} aria-label={`Input price for ${model.label}`} />
      </label>
      <label>
        Out $
        <input type="number" min={0} step="0.01" value={output} onChange={(e) => setOutput(e.target.value)} aria-label={`Output price for ${model.label}`} />
      </label>
      <button type="button" className="button" disabled={save.busy || !valid} onClick={() => void send({ input: amount(input), output: amount(output) })}>
        Save
      </button>
      <button type="button" className="link" disabled={save.busy} onClick={() => void send({ input: null })} title="Go back to the list price, or to no price if none is known">
        Clear
      </button>
      <button type="button" className="link" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {save.error ? <span className="note note-bad">{save.error}</span> : null}
    </span>
  );
}

function KeyCard({ connection, preset, models, onView }: { connection: ConnectionInfo; preset: PresetInfo | undefined; models: ModelOption[]; onView: (view: KeysView) => void }) {
  const act = useAction();
  const [confirm, setConfirm] = useState(false);
  const [filter, setFilter] = useState('');
  const [extra, setExtra] = useState('');
  const shown = filter.trim() ? models.filter((m) => `${m.id} ${m.label}`.toLowerCase().includes(filter.trim().toLowerCase())) : models;
  const picks = models.filter((m) => m.recommended).length;
  // Claude Code is not a key: it is the program on the server's machine, on the login it has.
  const login = preset?.kind === 'claude-code';
  return (
    <li className="key-card">
      <header className="key-head">
        {login ? <SquareTerminal size={18} aria-hidden="true" /> : <KeyRound size={18} aria-hidden="true" />}
        <div className="grow">
          <strong>{connection.label}</strong>
          {preset && preset.label !== connection.label ? <span className="muted"> · {preset.label}</span> : null}
          {login ? (
            <p className="muted">{connection.detail ?? 'The Claude Code on this machine'} · no key</p>
          ) : (
            <p className="muted">
              {connection.source === 'env' ? `Key from the environment${preset?.env[0] ? ` (${preset.env[0]})` : ''}` : connection.keyHint ? `Key ending ${connection.keyHint.replace('…', '')}` : 'No key'}
              {' · '}
              <span className="mono">{connection.baseURL}</span>
            </p>
          )}
        </div>
        <button
          type="button"
          className="button"
          disabled={act.busy}
          onClick={() => void act.run(async () => onView(await api.refreshConnection(connection.id)))}
          title={login ? 'Ask Claude Code again which version it is and whether it is signed in. No model is called.' : 'Ask the provider again what this key can call'}
        >
          <RefreshCw size={14} aria-hidden="true" /> Check again
        </button>
        {connection.source === 'stored' ? (
          confirm ? (
            <>
              <button type="button" className="button button-danger" disabled={act.busy} onClick={() => void act.run(async () => onView(await api.disconnect(connection.id)))}>
                {login ? 'Disconnect it' : 'Remove the key'}
              </button>
              <button type="button" className="button" onClick={() => setConfirm(false)}>
                Keep it
              </button>
            </>
          ) : (
            <button type="button" className="icon-button" onClick={() => setConfirm(true)} aria-label={login ? `Disconnect ${connection.label}` : `Remove the ${connection.label} key`}>
              <Trash2 size={16} />
            </button>
          )
        ) : null}
      </header>
      {confirm ? (
        <p className="muted">
          {login
            ? 'An organisation set to one of these models pauses at its next call, and says what it needs. Claude Code itself, and its login, are left as they are.'
            : 'An organisation set to one of this key’s models pauses at its next call, and says which key it needs.'}
        </p>
      ) : null}
      {login ? (
        <p className="muted">
          Each call is a run of Claude Code on this machine, with none of your own Claude Code settings, plugins or memory, and no tools but the organisation’s own. Spend is counted at what the
          API would charge. A subscription is not billed for it: it counts against your plan’s limits, and if Claude Code says a call is being billed after all, the organisation pauses.{' '}
          {connection.usage}
        </p>
      ) : null}
      {connection.listingError ? <p className="note note-warn">{connection.listingError}</p> : null}
      <ErrorNote onDismiss={act.clearError}>{act.error}</ErrorNote>
      <details className="key-models">
        <summary>
          {models.length} model{models.length === 1 ? '' : 's'}
          {picks && picks < models.length ? `, ${picks} picked out` : ''}
          {connection.checkedAt ? <span className="muted"> · checked {clock(connection.checkedAt)}</span> : null}
        </summary>
        {models.length > 12 ? <input className="key-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a model" aria-label={`Find a model on ${connection.label}`} /> : null}
        <table className="model-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Price per million tokens</th>
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, 200).map((model) => (
              <tr key={model.id}>
                <td>
                  <strong>{model.label}</strong>
                  {model.tier ? <span className="tag">{TIER[model.tier]}</span> : null}
                  {model.label !== model.id.slice(model.id.indexOf(':') + 1) ? <span className="muted mono"> {model.id.slice(model.id.indexOf(':') + 1)}</span> : null}
                  {model.note && !login ? <p className="muted">{model.note}</p> : null}
                </td>
                <td>
                  {preset?.kind === 'anthropic' || login ? (
                    <span className="num">
                      {price(model.inputPerMTok)} in · {price(model.outputPerMTok)} out
                    </span>
                  ) : (
                    <PriceCell connectionId={connection.id} model={model} onView={onView} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > 200 ? <p className="muted">Showing the first 200 of {shown.length}. Type in the box above to find one.</p> : null}
        {preset?.kind !== 'anthropic' && !login ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!extra.trim()) return;
              void act.run(async () => {
                onView(await api.patchConnection(connection.id, { addModel: extra.trim() }));
                setExtra('');
              });
            }}
          >
            <input value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="A model id the list does not have" aria-label="Model id to add" />
            <button type="submit" className="button" disabled={!extra.trim() || act.busy}>
              Add this model
            </button>
          </form>
        ) : null}
      </details>
    </li>
  );
}

function AddKey({ presets, onView }: { presets: PresetInfo[]; onView: (view: KeysView) => void }) {
  const [presetId, setPresetId] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [region, setRegion] = useState('');
  const [baseURL, setBaseURL] = useState('');
  const [label, setLabel] = useState('');
  const connect = useAction();
  const preset = presets.find((p) => p.id === presetId);
  const custom = presetId === 'custom';
  const login = preset?.kind === 'claude-code';

  const choose = (id: string) => {
    setPresetId(id);
    setApiKey('');
    setBaseURL('');
    setLabel('');
    setRegion(presets.find((p) => p.id === id)?.regions[0]?.id ?? '');
    connect.clearError();
  };
  const submit = () =>
    connect.run(async () => {
      onView(await api.connect({ presetId, apiKey, region: region || undefined, baseURL: baseURL.trim() || undefined, label: label.trim() || undefined }));
      choose('');
    });

  return (
    <section className="panel">
      <h2>Add a key</h2>
      <p className="muted">
        Choose who the key is from. The provider is asked what the key can call before it is kept, which is also how a wrong key is caught. Claude Code needs no key: it is connected as it
        stands on this machine.
      </p>
      <ul className="preset-grid">
        {presets.map((p) => (
          <li key={p.id}>
            <button type="button" className={p.id === presetId ? 'is-on' : ''} onClick={() => choose(p.id)} aria-pressed={p.id === presetId}>
              <strong>{p.label}</strong>
              {p.family ? <span className="muted">{p.family}</span> : null}
            </button>
          </li>
        ))}
      </ul>
      {preset && login ? (
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {preset.note ? <p className="muted">{preset.note}</p> : null}
          <p className="muted">
            Connecting asks Claude Code which version it is and whether it is signed in. No model is called, and its login is never read or copied.{' '}
            <a href={preset.keysUrl} target="_blank" rel="noreferrer noopener">
              Installing Claude Code <ExternalLink size={12} aria-hidden="true" />
            </a>
          </p>
          <ErrorNote onDismiss={connect.clearError}>{connect.error}</ErrorNote>
          <div className="row">
            <button type="submit" className="button button-primary" disabled={connect.busy}>
              {connect.busy ? 'Asking Claude Code…' : 'Connect Claude Code'}
            </button>
            <button type="button" className="button" onClick={() => choose('')}>
              Cancel
            </button>
          </div>
        </form>
      ) : preset ? (
        <form
          className="key-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {preset.note ? <p className="muted">{preset.note}</p> : null}
          <div className="grid-2">
            <Field
              label={custom ? 'API key (leave empty if the server needs none)' : 'API key'}
              hint={
                preset.keysUrl ? (
                  <>
                    <a href={preset.keysUrl} target="_blank" rel="noreferrer noopener">
                      Get a key from {preset.label} <ExternalLink size={12} aria-hidden="true" />
                    </a>
                    {preset.env[0] ? ` It can also be given as ${preset.env[0]} in the .env file.` : ''}
                  </>
                ) : undefined
              }
            >
              <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder={custom ? '' : 'Paste the key'} />
            </Field>
            {custom ? (
              <Field label="Address" hint="The base address of the endpoint, ending in /v1 for most servers.">
                <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} placeholder="http://127.0.0.1:8080/v1" spellCheck={false} />
              </Field>
            ) : preset.regions.length > 1 ? (
              <Field label="Platform" hint="Keys are issued by one platform and do not work on the other.">
                <select value={region} onChange={(e) => setRegion(e.target.value)}>
                  {preset.regions.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <Field label="Name (optional)" hint="How this key is shown, if you have more than one for this provider.">
                <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={preset.label} maxLength={60} />
              </Field>
            )}
          </div>
          {custom ? (
            <Field label="Name (optional)">
              <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="My local server" maxLength={60} />
            </Field>
          ) : (
            <details className="custom-address">
              <summary>Use a different address for this provider</summary>
              <Field label="Address" hint={`In place of ${preset.regions.find((r) => r.id === region)?.baseURL ?? preset.regions[0]?.baseURL}`}>
                <input value={baseURL} onChange={(e) => setBaseURL(e.target.value)} spellCheck={false} />
              </Field>
            </details>
          )}
          <ErrorNote onDismiss={connect.clearError}>{connect.error}</ErrorNote>
          <div className="row">
            <button type="submit" className="button button-primary" disabled={connect.busy || (!custom && !apiKey.trim()) || (custom && !baseURL.trim())}>
              {connect.busy ? 'Asking the provider…' : 'Connect'}
            </button>
            <button type="button" className="button" onClick={() => choose('')}>
              Cancel
            </button>
          </div>
        </form>
      ) : null}
    </section>
  );
}

export function Models({ meta, onChange }: { meta: Meta; onChange: () => void }) {
  const [view, setView] = useState<KeysView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const presets = meta.keys?.presets ?? [];

  useEffect(() => {
    api.connections().then(setView, (err: Error) => setError(err.message));
  }, []);
  // Whatever changes here changes which models the rest of the interface can offer.
  const onView = (next: KeysView) => {
    setView(next);
    onChange();
  };

  if (!meta.keys) {
    return (
      <div className="models">
        <a className="back" href="#/">
          <ArrowLeft size={15} aria-hidden="true" /> Organisations
        </a>
        <h1>Models and keys</h1>
        <p className="muted">This server was not started in a way that manages API keys.</p>
      </div>
    );
  }
  const offered = presets.filter((p) => p.models.length);
  return (
    <div className="models">
      <a className="back" href="#/">
        <ArrowLeft size={15} aria-hidden="true" /> Organisations
      </a>
      <div className="page-head">
        <div>
          <h1>Models and keys</h1>
          <p className="muted">
            Add an API key and the models it can call can be chosen for any organisation’s executives and agents. Keys are kept on this machine, in a file only you can read, and are not shown
            again once added. If Claude Code is installed here, its login can be used as well, without a key; a new organisation still starts on a key’s model where there is one.
          </p>
        </div>
      </div>
      {meta.keys.forcedSimulation ? (
        <div className="note note-warn">
          <span>
            The server was started with <code>ORG_PROVIDER=mock</code>, so every call is simulated whatever keys are added here. Start it without that to call real models.
          </span>
        </div>
      ) : null}
      <ErrorNote>{error}</ErrorNote>

      <section className="panel">
        <h2>Connected</h2>
        {!view ? (
          error ? null : (
            <p className="muted">Loading…</p>
          )
        ) : view.connections.length === 0 ? (
          view.provider.simulated ? (
            <p className="muted">Nothing is connected yet. Until a key is added or Claude Code is connected, organisations run in simulation: every seat gives a scripted answer and nothing is spent.</p>
          ) : (
            <p className="muted">
              Nothing is connected. Organisations pause when they next need a model, and say what is missing; add it below and resume them. This server has had a connection before, so it
              does not go back to simulating by itself: to simulate, start it with <code>ORG_PROVIDER=mock</code>.
            </p>
          )
        ) : (
          <ul className="key-list">
            {view.connections.map((connection) => (
              <KeyCard
                key={connection.id}
                connection={connection}
                preset={presets.find((p) => p.id === connection.presetId)}
                models={view.provider.models.filter((m) => m.connectionId === connection.id)}
                onView={onView}
              />
            ))}
          </ul>
        )}
      </section>

      <AddKey presets={presets} onView={onView} />

      {offered.length ? (
        <section className="panel">
          <h2>The models picked out for each provider</h2>
          <p className="muted">
            List prices in US dollars per million tokens, as each provider published them on {day(meta.keys.pricesChecked)}. Budgets and spend estimates are worked out from them, so check
            the provider’s own price list, and correct a price under the key above if your account is charged differently. A key can call more models than these: all of them are offered
            once it is added.
          </p>
          <table className="model-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Model</th>
                <th className="num">In</th>
                <th className="num">Out</th>
              </tr>
            </thead>
            <tbody>
              {offered.flatMap((p) =>
                p.models.map((m, i) => (
                  <tr key={`${p.id}:${m.id}`}>
                    <td>
                      {i === 0 ? (
                        <>
                          <strong>{p.label}</strong>
                          {p.sources[0] ? (
                            <p>
                              <a href={p.sources[0]} target="_blank" rel="noreferrer noopener">
                                Price list <ExternalLink size={11} aria-hidden="true" />
                              </a>
                            </p>
                          ) : null}
                        </>
                      ) : null}
                    </td>
                    <td>
                      {m.label} <span className="tag">{TIER[m.tier]}</span>
                      <span className="muted mono"> {m.id}</span>
                      {m.only || m.note ? (
                        <p className="muted">
                          {m.only ? `${m.only.map((id) => p.regions.find((r) => r.id === id)?.label ?? id).join(', ')} only. ` : ''}
                          {m.note}
                        </p>
                      ) : null}
                    </td>
                    <td className="num">{price(m.inputPerMTok)}</td>
                    <td className="num">{price(m.outputPerMTok)}</td>
                  </tr>
                )),
              )}
            </tbody>
          </table>
        </section>
      ) : null}
    </div>
  );
}
