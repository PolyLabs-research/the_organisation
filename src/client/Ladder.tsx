import { EFFORT_SCALE } from '../shared/effort';
import { MAX_LADDER, MAX_RUNG_LEVEL, levelsOf, rungsOf } from '../shared/routing';
import type { LadderRung, ModelOption, Organisation } from '../shared/types';
import { ModelPicker } from './ModelPicker';
import { Field } from './ui';

// The ladder of cheaper models under the agents' model: setting it, and seeing where it stands.

/** A model's price as one figure to order by: what a million tokens in and a million out cost together. Unpriced models go last. */
const cost = (model: ModelOption) => (model.priced === false ? Infinity : model.inputPerMTok + model.outputPerMTok);

/** How a range of levels reads: "1 to 3", "4", or nothing at all. */
function levelText(levels: { from: number; to: number } | null): string {
  if (!levels) return 'no tasks';
  return levels.from === levels.to ? `tasks rated ${levels.from}` : `tasks rated ${levels.from} to ${levels.to}`;
}

/**
 * Choose the cheaper models for the agents' lighter tasks, and the highest rating each takes. The rungs are kept
 * in order as they are edited: each reaches higher than the one before it.
 */
export function LadderEditor({
  value,
  learns,
  models,
  workerModel,
  hosted,
  onChange,
  onLearns,
}: {
  value: LadderRung[];
  learns: boolean;
  models: ModelOption[];
  workerModel: string;
  /** Plans are carried out in hosted sessions, where every agent runs on the agents' model. */
  hosted: boolean;
  onChange: (next: LadderRung[]) => void;
  onLearns: (next: boolean) => void;
}) {
  const taken = new Set([workerModel, ...value.map((rung) => rung.model)]);
  const spare = models.filter((model) => !taken.has(model.id));
  /** Each rung at least one level above the one before it, and enough room left for the rungs after it. */
  const inOrder = (rungs: LadderRung[]): LadderRung[] => {
    let least = 1;
    return rungs.map((rung, i) => {
      const upTo = Math.min(MAX_RUNG_LEVEL - (rungs.length - 1 - i), Math.max(least, rung.upTo));
      least = upTo + 1;
      return { model: rung.model, upTo };
    });
  };
  const set = (index: number, change: Partial<LadderRung>) => onChange(inOrder(value.map((rung, i) => (i === index ? { ...rung, ...change } : rung))));
  const add = () => {
    // The cheapest model not yet in use, taking tasks up to one level above the rung before it.
    const cheapest = [...spare].sort((a, b) => cost(a) - cost(b))[0];
    if (cheapest) onChange(inOrder([...value, { model: cheapest.id, upTo: (value.at(-1)?.upTo ?? 1) + 1 }]));
  };

  return (
    <div className="ladder">
      <p className="field-label">Cheaper models for the agents’ lighter tasks</p>
      <p className="field-hint">
        Leads rate every task from 1 to 10. A task rated at or below a model’s level goes to that model; the rest, and any task that was not rated, go to the agents’ model. Work that a lead sends back is done again one
        model up.
      </p>
      {value.map((rung, index) => (
        <div className="ladder-rung" key={index}>
          <ModelPicker label={`Lighter model ${index + 1}`} value={rung.model} models={models.filter((model) => model.id === rung.model || !taken.has(model.id))} onChange={(id) => set(index, { model: id })} />
          <Field label="Takes tasks rated up to" hint={EFFORT_SCALE[rung.upTo - 1]}>
            <select value={rung.upTo} onChange={(e) => set(index, { upTo: Number(e.target.value) })}>
              {Array.from({ length: MAX_RUNG_LEVEL }, (_, i) => i + 1)
                .filter((level) => level > (value[index - 1]?.upTo ?? 0) && level <= MAX_RUNG_LEVEL - (value.length - 1 - index))
                .map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
            </select>
          </Field>
          <button type="button" className="button" aria-label={`Remove lighter model ${index + 1}`} onClick={() => onChange(value.filter((_, i) => i !== index))}>
            Remove
          </button>
        </div>
      ))}
      {value.length < MAX_LADDER && spare.length ? (
        <button type="button" className="button" onClick={add}>
          {value.length ? 'Add another cheaper model' : 'Add a cheaper model'}
        </button>
      ) : null}
      {value.length ? (
        <label className="check">
          <input type="checkbox" checked={learns} onChange={(e) => onLearns(e.target.checked)} />
          <span>
            <strong>Let these levels follow results.</strong> A model whose work keeps being sent back gives up its highest level, and one whose work at its highest level keeps standing is tried one level higher. The
            board is told each time.
          </span>
        </label>
      ) : null}
      {value.length && hosted ? <p className="field-hint">This is for work on this machine. In hosted sessions every agent runs on the agents’ model.</p> : null}
    </div>
  );
}

/** Where the ladder stands: which model takes which tasks now, and what has become of each model's recent work. */
export function LadderStanding({ org }: { org: Organisation }) {
  const set = org.settings.workerLadder ?? [];
  if (!set.length) return null;
  const rungs = rungsOf(org);
  const learned = org.settings.workerLadderLearns ? org.routing?.rungs : undefined;
  return (
    <>
      <h4 className="viz-heading">Which model takes which tasks</h4>
      <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Takes now</th>
            <th>As set</th>
            <th>Its recent tasks</th>
          </tr>
        </thead>
        <tbody>
          {rungs.map((rung, index) => {
            const recent = learned?.[index]?.recent ?? [];
            const back = recent.filter((result) => !result.ok).length;
            return (
              <tr key={rung.model}>
                <td>{rung.model}</td>
                <td>{levelText(levelsOf(rungs, index))}</td>
                <td>{levelText(levelsOf(set, index))}</td>
                <td>{!org.settings.workerLadderLearns ? 'not followed' : recent.length ? `${recent.length - back} of ${recent.length} let stand${back ? `, ${back} sent back or failed` : ''}` : 'none reviewed yet'}</td>
              </tr>
            );
          })}
          <tr>
            <td>{org.settings.workerModel}</td>
            <td>{`${levelText(levelsOf(rungs, rungs.length))}, and any not rated`}</td>
            <td>{levelText(levelsOf(set, set.length))}</td>
            <td>the agents’ model</td>
          </tr>
        </tbody>
      </table>
      </div>
    </>
  );
}
