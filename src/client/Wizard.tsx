import { ArrowLeft, Plus, Sparkles, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { hueFor } from '../shared/profiles';
import type { ExecutiveDraft, OperatingProfile, OrgSettings, SopPhase } from '../shared/types';
import { api, useAction, type Meta } from './api';
import { navigate } from './App';
import { ErrorNote, Field, SeatBadge, Sop, Stepper } from './ui';

interface Seat {
  key: number;
  profileId: string;
  custom: boolean;
  short: string;
  title: string;
  function: string;
  remit: string;
  phases: SopPhase[];
  agentCount: number;
  hue: number;
  rationale?: string;
}

let nextKey = 1;

function seatFromProfile(profile: OperatingProfile, overrides: Partial<Seat> = {}): Seat {
  return {
    key: nextKey++,
    profileId: profile.id,
    custom: false,
    short: profile.short,
    title: profile.title,
    function: profile.function,
    remit: profile.remit,
    phases: profile.phases,
    agentCount: profile.defaultAgents,
    hue: profile.hue,
    ...overrides,
  };
}

function seatFromDraft(draft: ExecutiveDraft, profiles: OperatingProfile[]): Seat | null {
  const profile = profiles.find((p) => p.id === draft.profileId && p.kind === 'lead');
  if (profile) {
    return seatFromProfile(profile, {
      remit: draft.remit?.trim() || profile.remit,
      agentCount: draft.agentCount ?? profile.defaultAgents,
      rationale: draft.rationale,
    });
  }
  if (!draft.title || !draft.phases || draft.phases.length < 2) return null;
  return {
    key: nextKey++,
    profileId: 'custom',
    custom: true,
    short: draft.short || draft.title.split(/\s+/).map((w) => w[0]).join('').slice(0, 5),
    title: draft.title,
    function: draft.function || draft.title,
    remit: draft.remit ?? '',
    phases: draft.phases,
    agentCount: draft.agentCount ?? 2,
    hue: hueFor(draft.title),
    rationale: draft.rationale,
  };
}

/** "Audit → Reduce, Report" becomes three phases. */
function parsePhases(text: string): SopPhase[] {
  return text
    .split(/→|->|>|,|\n/)
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 6)
    .map((name) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, purpose: `Carry out the ${name} phase.`, deliverable: `The ${name} deliverable.` }));
}

export function Wizard({ meta }: { meta: Meta }) {
  const leadProfiles = useMemo(() => meta.profiles.filter((p) => p.kind === 'lead'), [meta.profiles]);
  const ceo = meta.profiles.find((p) => p.kind === 'ceo')!;
  const judge = meta.profiles.find((p) => p.kind === 'judge')!;

  const [idea, setIdea] = useState('');
  const [name, setName] = useState('');
  const [mission, setMission] = useState('');
  const [seats, setSeats] = useState<Seat[]>([]);
  const [teamOpen, setTeamOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [custom, setCustom] = useState({ title: '', function: '', remit: '', phases: '' });
  const [settings, setSettings] = useState<OrgSettings>(meta.defaults);
  const [limitCycles, setLimitCycles] = useState(false);
  const [steer, setSteer] = useState('');
  const [startNow, setStartNow] = useState(true);
  const recommend = useAction();
  const create = useAction();

  const unseated = leadProfiles.filter((p) => !seats.some((s) => s.profileId === p.id));
  const agents = seats.reduce((n, s) => n + s.agentCount, 0);
  const full = seats.length >= meta.limits.maxLeads;
  const customPhases = parsePhases(custom.phases);
  const set = <K extends keyof OrgSettings>(key: K, value: OrgSettings[K]) => setSettings((s) => ({ ...s, [key]: value }));
  const patchSeat = (key: number, patch: Partial<Seat>) => setSeats((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const askForTeam = () =>
    recommend.run(async () => {
      const rec = await api.recommend(idea.trim());
      const recommended = rec.executives.map((d) => seatFromDraft(d, meta.profiles)).filter((s): s is Seat => s !== null);
      setSeats(recommended.slice(0, meta.limits.maxLeads));
      if (!name.trim()) setName(rec.name);
      setMission(rec.mission);
      setTeamOpen(true);
    });

  const addCustom = () => {
    const seat = seatFromDraft({ profileId: 'custom', title: custom.title.trim(), function: custom.function.trim(), remit: custom.remit.trim(), phases: customPhases, agentCount: 2 }, meta.profiles);
    if (!seat) return;
    setSeats((list) => [...list, seat]);
    setCustom({ title: '', function: '', remit: '', phases: '' });
    setAdding(false);
  };

  const establish = () =>
    create.run(async () => {
      const view = await api.create({
        name: name.trim(),
        idea: idea.trim(),
        mission: mission.trim(),
        executives: seats.map((s) => ({
          profileId: s.profileId,
          short: s.short,
          title: s.title,
          function: s.function,
          remit: s.remit,
          phases: s.custom ? s.phases : undefined,
          agentCount: s.agentCount,
        })),
        settings: { ...settings, maxCycles: limitCycles ? (settings.maxCycles ?? 3) : null },
        steer: steer.trim(),
      });
      if (startNow) await api.start(view.org.id);
      navigate(`/org/${view.org.id}`);
    });

  const missing = !idea.trim() ? 'Describe the idea first.' : !name.trim() ? 'Give the organisation a name.' : !seats.length ? 'Seat at least one executive lead.' : null;

  return (
    <div className="wizard">
      <a className="back" href="#/">
        <ArrowLeft size={15} aria-hidden="true" /> Organisations
      </a>
      <h1>Establish an organisation</h1>

      <section className="panel">
        <h2>The idea</h2>
        <Field label="What should this organisation pursue?">
          <textarea
            rows={4}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            placeholder="e.g. A marketplace where local bakeries sell the day's surplus bread at a discount each evening."
            autoFocus
          />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Recommended with the team if left empty" maxLength={80} />
        </Field>
        <div className="row">
          <button type="button" className="button button-primary" onClick={askForTeam} disabled={idea.trim().length < 10 || recommend.busy}>
            <Sparkles size={16} aria-hidden="true" /> {recommend.busy ? 'Working out the team…' : seats.length ? 'Recommend again' : 'Recommend a team'}
          </button>
          {!teamOpen ? (
            <button type="button" className="button" onClick={() => setTeamOpen(true)}>
              Seat the team myself
            </button>
          ) : null}
        </div>
        <ErrorNote onDismiss={recommend.clearError}>{recommend.error}</ErrorNote>
      </section>

      {teamOpen ? (
        <>
          <section className="panel">
            <div className="panel-head">
              <h2>Executive team</h2>
              <span className="muted">
                CEO and {seats.length} lead{seats.length === 1 ? '' : 's'} directing {agents} agent{agents === 1 ? '' : 's'}
              </span>
            </div>
            {mission || seats.length ? (
              <Field label="Mission" hint="Every seat and agent is given this.">
                <textarea rows={2} value={mission} onChange={(e) => setMission(e.target.value)} placeholder="Defaults to the idea as you described it." />
              </Field>
            ) : null}

            <ul className="seats">
              <li className="seat seat-fixed">
                <div className="seat-head">
                  <SeatBadge seat={ceo} size="lg" />
                  <div>
                    <strong>{ceo.title}</strong>
                    <p className="muted">Always seated. {ceo.remit}</p>
                  </div>
                </div>
              </li>
              {seats.map((seat) => (
                <li key={seat.key} className="seat">
                  <div className="seat-head">
                    <SeatBadge seat={seat} size="lg" />
                    <div className="grow">
                      <strong>{seat.title}</strong>
                      <span className="muted"> · leads {seat.function}</span>
                      {seat.rationale ? <p className="muted">{seat.rationale}</p> : null}
                    </div>
                    <button type="button" className="icon-button" onClick={() => setSeats((list) => list.filter((s) => s.key !== seat.key))} aria-label={`Remove ${seat.title}`}>
                      <X size={16} />
                    </button>
                  </div>
                  <div className="seat-body">
                    <Field label="Remit">
                      <textarea rows={2} value={seat.remit} onChange={(e) => patchSeat(seat.key, { remit: e.target.value })} />
                    </Field>
                    <div className="seat-foot">
                      <div>
                        <span className="field-label">Operating profile</span>
                        <Sop phases={seat.phases} />
                      </div>
                      <div>
                        <span className="field-label">Agents</span>
                        <Stepper value={seat.agentCount} min={1} max={meta.limits.maxAgentsPerLead} onChange={(agentCount) => patchSeat(seat.key, { agentCount })} label="agents" />
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>

            {adding ? (
              <div className="adder">
                <div className="panel-head">
                  <h3>Add a seat</h3>
                  <button type="button" className="link" onClick={() => setAdding(false)}>
                    Close
                  </button>
                </div>
                <ul className="library">
                  {unseated.map((profile) => (
                    <li key={profile.id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSeats((list) => [...list, seatFromProfile(profile)]);
                          if (seats.length + 1 >= meta.limits.maxLeads) setAdding(false);
                        }}
                      >
                        <span className="library-head">
                          <SeatBadge seat={profile} />
                          <strong>{profile.title}</strong>
                        </span>
                        <Sop phases={profile.phases} compact />
                      </button>
                    </li>
                  ))}
                </ul>
                <details className="custom-seat">
                  <summary>A seat that is not in the library</summary>
                  <div className="grid-2">
                    <Field label="Title">
                      <input value={custom.title} onChange={(e) => setCustom({ ...custom, title: e.target.value })} placeholder="Chief Sustainability Officer" />
                    </Field>
                    <Field label="Function it leads">
                      <input value={custom.function} onChange={(e) => setCustom({ ...custom, function: e.target.value })} placeholder="Sustainability" />
                    </Field>
                  </div>
                  <Field label="Remit">
                    <input value={custom.remit} onChange={(e) => setCustom({ ...custom, remit: e.target.value })} placeholder="What this seat decides and answers for" />
                  </Field>
                  <Field label="Operating profile" hint="Two to six phases, in the order every plan of this seat will run them.">
                    <input value={custom.phases} onChange={(e) => setCustom({ ...custom, phases: e.target.value })} placeholder="Audit → Reduce → Verify → Report" />
                  </Field>
                  {customPhases.length ? <Sop phases={customPhases} /> : null}
                  <button type="button" className="button" onClick={addCustom} disabled={!custom.title.trim() || customPhases.length < 2}>
                    Add this seat
                  </button>
                </details>
              </div>
            ) : (
              <button type="button" className="button" onClick={() => setAdding(true)} disabled={full}>
                <Plus size={16} aria-hidden="true" /> {full ? `A team seats at most ${meta.limits.maxLeads} leads` : 'Add a seat'}
              </button>
            )}
          </section>

          <section className="panel">
            <h2>Governance and limits</h2>
            <fieldset className="choice">
              <legend>When leads have competing priorities, the board seeks consensus, and sign-off comes from:</legend>
              <label>
                <input type="radio" name="arbiter" checked={settings.arbiter === 'ceo'} onChange={() => set('arbiter', 'ceo')} />
                <span>
                  <strong>The CEO</strong>, who rules by what the shareholders want
                </span>
              </label>
              <label>
                <input type="radio" name="arbiter" checked={settings.arbiter === 'judge'} onChange={() => set('arbiter', 'judge')} />
                <span>
                  <strong>An independent judge</strong>, seated on the board with no remit of their own ({judge.phases.map((p) => p.name).join(' → ')})
                </span>
              </label>
            </fieldset>

            <div className="grid-2">
              <Field
                label="Budget (US dollars)"
                hint={
                  meta.provider.simulated
                    ? 'In simulation this is play money, but the cap behaves the same.'
                    : 'Estimated spend. The organisation pauses itself here and waits for you. Spend grows with the number of leads and agents, so start small and raise it once you have seen a cycle.'
                }
              >
                <input type="number" min={0.1} step={0.5} value={settings.budgetUsd} onChange={(e) => set('budgetUsd', Number(e.target.value))} />
              </Field>
              <Field label="Follow-up work per cycle" hint="How far one board report may set off further plans before the CEO takes stock.">
                <select value={settings.maxFollowUpDepth} onChange={(e) => set('maxFollowUpDepth', Number(e.target.value))}>
                  <option value={0}>None: reports wait for the next cycle</option>
                  <option value={1}>One round of follow-ups</option>
                  <option value={2}>Two rounds</option>
                  <option value={3}>Three rounds</option>
                </select>
              </Field>
              <Field label="Model for the executives">
                <select value={settings.executiveModel} onChange={(e) => set('executiveModel', e.target.value)}>
                  {meta.provider.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} (${m.inputPerMTok} in / ${m.outputPerMTok} out per million tokens)
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Model for the agents" hint="Agents do most of the work, so this choice drives most of the spend.">
                <select value={settings.workerModel} onChange={(e) => set('workerModel', e.target.value)}>
                  {meta.provider.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} (${m.inputPerMTok} in / ${m.outputPerMTok} out per million tokens)
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <label className="check">
              <input type="checkbox" checked={settings.webResearch} onChange={(e) => set('webResearch', e.target.checked)} />
              <span>
                <strong>Let agents search the web.</strong> Without it they work from what the model already knows and must mark facts as
                assumptions. Searches are billed separately by Anthropic.
              </span>
            </label>
            <label className="check">
              <input type="checkbox" checked={limitCycles} onChange={(e) => setLimitCycles(e.target.checked)} />
              <span>
                <strong>Stop after a set number of cycles.</strong> Otherwise the loop runs until you pause it or the budget is reached.
                {limitCycles ? (
                  <input
                    className="inline-number"
                    type="number"
                    min={1}
                    value={settings.maxCycles ?? 3}
                    onChange={(e) => set('maxCycles', Math.max(1, Number(e.target.value) || 1))}
                    aria-label="Number of cycles"
                  />
                ) : null}
              </span>
            </label>

            <Field label="First steer from the shareholders (optional)" hint="The CEO enforces steer. You can give more at any time once the organisation exists.">
              <textarea rows={2} value={steer} onChange={(e) => setSteer(e.target.value)} placeholder="e.g. Launch in one city before anything else. Keep it profitable." />
            </Field>
          </section>

          <div className="wizard-foot">
            <label className="check">
              <input type="checkbox" checked={startNow} onChange={(e) => setStartNow(e.target.checked)} />
              <span>Start work straight away</span>
            </label>
            <div className="row">
              {missing ? <span className="muted">{missing}</span> : null}
              <button type="button" className="button button-primary button-lg" onClick={establish} disabled={!!missing || create.busy}>
                {create.busy ? 'Establishing…' : 'Establish the organisation'}
              </button>
            </div>
          </div>
          <ErrorNote onDismiss={create.clearError}>{create.error}</ErrorNote>
        </>
      ) : null}
    </div>
  );
}
