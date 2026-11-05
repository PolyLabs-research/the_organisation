import { useId, useState, type ReactNode } from 'react';
import type { ModelOption } from '../shared/types';

// Choosing a model is choosing two things: whose key it is called with, and which of that key's models.
// With one key there is only the second choice to make.

export const TIER: Record<NonNullable<ModelOption['tier']>, string> = { flagship: 'top tier', balanced: 'mid-priced', fast: 'fast and cheap' };

/** The key a model belongs to. Models of the simulator, which has no keys, fall into one group. */
const groupOf = (model: ModelOption) => model.connectionId ?? model.provider ?? '';

/** A price per million tokens: whole dollars as they are, cents to two places, and fractions of a cent as far as they go. */
export const dollars = (n: number) => (n === 0 ? 'free' : `$${n.toFixed(4).replace(/0{1,2}$/, '').replace(/\.00$/, '')}`);

/** Whether plans can be carried out in hosted sessions with these two models: both must be hostable, on one key. */
export function canHost(models: ModelOption[], executiveModel: string, workerModel: string): boolean {
  const lead = models.find((m) => m.id === executiveModel);
  const team = models.find((m) => m.id === workerModel);
  return !!lead?.hosted && !!team?.hosted && groupOf(lead) === groupOf(team);
}

/** Whether agents on this model can be given web search. */
export function canSearch(models: ModelOption[], workerModel: string): boolean {
  return !!models.find((m) => m.id === workerModel)?.web;
}

function optionText(model: ModelOption): string {
  const tier = model.tier ? `, ${TIER[model.tier]}` : '';
  const cost = model.priced === false ? 'price not known' : `${dollars(model.inputPerMTok)} in / ${dollars(model.outputPerMTok)} out`;
  return `${model.label}${tier} (${cost})`;
}

export function ModelPicker({
  label,
  hint,
  value,
  models,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  value: string;
  models: ModelOption[];
  onChange: (id: string) => void;
}) {
  const id = useId();
  const [filter, setFilter] = useState('');
  const current = models.find((m) => m.id === value);
  const groups = [...new Map(models.map((m) => [groupOf(m), m.provider ?? 'Models'])).entries()];
  const group = current ? groupOf(current) : null;
  const inGroup = group === null ? [] : models.filter((m) => groupOf(m) === group);
  const needle = filter.trim().toLowerCase();
  // The chosen model stays in the list whatever is typed, so the box never shows something other than the choice.
  const shown = needle ? inGroup.filter((m) => m.id === value || `${m.label} ${m.id}`.toLowerCase().includes(needle)) : inGroup;
  const picks = shown.filter((m) => m.recommended);
  const others = shown.filter((m) => !m.recommended);
  const option = (m: ModelOption) => (
    <option key={m.id} value={m.id}>
      {optionText(m)}
    </option>
  );

  return (
    <div className="field model-picker">
      <span className="field-label" id={`${id}-label`}>
        {label}
      </span>
      {groups.length > 1 || !current ? (
        <select
          aria-label={`${label}: whose key`}
          value={group ?? ''}
          onChange={(e) => {
            const first = models.find((m) => groupOf(m) === e.target.value);
            setFilter('');
            if (first) onChange(first.id);
          }}
        >
          {current ? null : (
            <option value="" disabled>
              {models.length ? 'Choose whose key to use' : 'No key is connected'}
            </option>
          )}
          {groups.map(([key, name]) => (
            <option key={key} value={key}>
              {name}
            </option>
          ))}
        </select>
      ) : null}
      {current ? (
        <>
          {inGroup.length > 25 ? (
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find one of ${inGroup.length} models`} aria-label={`${label}: find a model`} />
          ) : null}
          <select aria-labelledby={`${id}-label`} value={value} onChange={(e) => onChange(e.target.value)}>
            {picks.length && others.length ? (
              <>
                <optgroup label="Picked out for this provider">{picks.map(option)}</optgroup>
                <optgroup label="Everything else this key can call">{others.map(option)}</optgroup>
              </>
            ) : (
              shown.map(option)
            )}
          </select>
        </>
      ) : null}
      <span className="field-hint">
        {!current ? (
          <>
            This is set to <span className="mono">{value}</span>, which no connected key can call. Pick another model, or add its key under{' '}
            <a href="#/models" target="_blank" rel="noreferrer noopener">
              Models and keys
            </a>
            .
          </>
        ) : current.priced === false ? (
          <>
            Its price is not known, so spend is counted at {dollars(current.inputPerMTok)} in and {dollars(current.outputPerMTok)} out per million tokens. Set the real price under{' '}
            <a href="#/models" target="_blank" rel="noreferrer noopener">
              Models and keys
            </a>
            , or the budget will not mean what it says.
          </>
        ) : (
          <>
            {dollars(current.inputPerMTok)} in, {dollars(current.outputPerMTok)} out per million tokens.{current.note ? ` ${current.note}` : ''}
          </>
        )}
        {hint ? <> {hint}</> : null}
      </span>
    </div>
  );
}
