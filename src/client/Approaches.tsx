import { WORK_APPROACHES, approachAllowed, approachesOf, type WorkApproach } from '../shared/approaches';
import { rolesOf } from '../shared/privileges';
import type { Executive, Organisation, OrgView } from '../shared/types';
import { api, useAction } from './api';
import { ErrorNote, SeatBadge } from './ui';

// The ways of working a lead can choose between, plan by plan. Every role keeps its own operating profile, and a tick here
// opens an alternative to it. The lead makes the choice and gives its reason on the plan.

function Tick({ org, seat, approach, busy, onChange }: { org: Organisation; seat: Executive; approach: WorkApproach; busy: boolean; onChange: (allowed: boolean) => void }) {
  if (!approachesOf(seat).includes(approach)) return <td className="privilege-none">–</td>;
  return (
    <td>
      <label className="privilege-tick">
        <input type="checkbox" aria-label={`${seat.short}: ${approach.label}`} checked={approachAllowed(org, seat.id, approach.id)} disabled={busy} onChange={(event) => onChange(event.target.checked)} />
      </label>
    </td>
  );
}

export function Approaches({ org, onView }: { org: Organisation; onView: (view: OrgView) => void }) {
  const action = useAction();
  const roles = rolesOf(org).filter((seat) => approachesOf(seat).length);
  const shown = WORK_APPROACHES.filter((approach) => roles.some((seat) => approachesOf(seat).includes(approach)));
  return (
    <section className="operations privileges-panel">
      <h2>Work approaches</h2>
      <p>Every role works to its own operating profile. These are the alternatives a lead can choose instead, plan by plan, for work the profile does not suit. The lead says on the plan which one it chose and why.</p>
      <ErrorNote onDismiss={action.clearError}>{action.error}</ErrorNote>
      {shown.length ? (
        <div className="privileges-scroll">
          <table className="privileges-table">
            <thead>
              <tr>
                <th scope="col">Approach</th>
                {roles.map((seat) => <th scope="col" key={seat.id}><SeatBadge seat={seat} size="sm" /></th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((approach) => (
                <tr key={approach.id}>
                  <th scope="row">
                    {approach.label}
                    <span className="privilege-detail">{approach.when}</span>
                    <span className="privilege-detail">{approach.phases.map((p) => p.name).join(' → ')}</span>
                    {approach.needsCode ? <span className="privilege-detail">A lead can only choose this with a repository assigned under Email &amp; accounts, Push branches under Privileges, and agents working on this machine. Its gates are checked against the repository.</span> : null}
                  </th>
                  {roles.map((seat) => (
                    <Tick key={seat.id} org={org} seat={seat} approach={approach} busy={action.busy} onChange={(allowed) => void action.run(async () => onView(await api.workApproach(org.id, seat.id, approach.id, allowed)))} />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted">None of the roles here have alternatives yet. Each works to its own operating profile.</p>
      )}
    </section>
  );
}
