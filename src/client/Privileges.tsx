import { EVERY_ROLE_CAN, NO_ROLE_CAN, PRIVILEGES, allows, applies, rolesOf, type PrivilegeSpec } from '../shared/privileges';
import type { SandboxStatus } from '../shared/sandbox';
import type { Executive, Organisation, OrgView } from '../shared/types';
import { useEffect, useState } from 'react';
import { api, useAction } from './api';
import { ErrorNote, SeatBadge } from './ui';
import { HelpLink } from './Guide';

// What each role and its agents may do, on one page. A tick here is a decision for the shareholders, and each one is
// enforced where the thing is done: what an agent is told about it only saves it wasting its turns.

const GROUPS = [...new Set(PRIVILEGES.map((p) => p.group))];

function Tick({ org, seat, privilege, busy, onChange }: { org: Organisation; seat: Executive; privilege: PrivilegeSpec; busy: boolean; onChange: (allowed: boolean) => void }) {
  if (!applies(seat, privilege)) return <td className="privilege-none" title={`The ${seat.short} has no agents to do this`}>–</td>;
  return (
    <td>
      <label className="privilege-tick">
        <input type="checkbox" aria-label={`${seat.short}: ${privilege.label}`} checked={allows(org, seat.id, privilege.id)} disabled={busy} onChange={(event) => onChange(event.target.checked)} />
      </label>
    </td>
  );
}

export function Privileges({ org, onView, onSettings }: { org: Organisation; onView: (view: OrgView) => void; onSettings: () => void }) {
  const action = useAction();
  const roles = rolesOf(org);
  // Code that can reach the network can send what it reads anywhere: with the network open, running it is something done outside.
  const runsOutside = (seat: Executive) => allows(org, seat.id, 'run_code') && org.settings.sandboxNetwork;
  // A role that reads what anyone can send it, and can also change something outside without a person looking first.
  const steerable = roles.filter((seat) => allows(org, seat.id, 'read_mail') && (allows(org, seat.id, 'act') || allows(org, seat.id, 'use_tools') || runsOutside(seat)));
  const steeredTo = [steerable.some((seat) => allows(org, seat.id, 'act')) ? 'act on accounts' : '', steerable.some((seat) => allows(org, seat.id, 'use_tools')) ? 'call connected tools' : '', steerable.some(runsOutside) ? 'run code that can reach the network' : '']
    .filter(Boolean)
    .join(' or ');
  // Whether code can be run on this server at all is asked whenever a role is first let run it: Docker may have been started since the page was opened.
  const running = roles.filter((seat) => seat.kind === 'lead' && allows(org, seat.id, 'run_code'));
  const [sandbox, setSandbox] = useState<SandboxStatus | null>(null);
  const anyRuns = running.length > 0;
  useEffect(() => {
    if (!anyRuns) return;
    let live = true;
    api.meta().then((meta) => live && setSandbox(meta.sandbox ?? null), () => {});
    return () => {
      live = false;
    };
  }, [anyRuns]);
  return (
    <section className="operations privileges-panel">
      <h2>Privileges</h2>
      <p>What each role and its agents may do. Each tick is checked where the thing is done, so an agent cannot talk its way past one. A change holds at once, and what a role is doing with something it has just lost stops. <HelpLink guide="reference" section="what-each-role-may-do">What each privilege means</HelpLink></p>
      <p className="muted">Mailboxes, accounts, repositories and tool servers are assigned to teams under Email &amp; accounts. A role needs both: the assignment there, and the privilege here.</p>
      {org.settings.execution === 'managed' ? (
        <p className="note note-warn">
          <span>
            This organisation runs in hosted sessions, which cannot reach email or accounts, and have a sandbox of their own to run code in. Until Execution is set to local, only Search the web, Update business records and Ask the signatory have any effect. <button type="button" className="link" onClick={onSettings}>Open Settings</button>
          </span>
        </p>
      ) : null}
      {!org.settings.webResearch ? <p className="note note-warn"><span>Web search is off for the organisation in Settings, so no role can search, whatever is ticked here.</span></p> : null}
      {steerable.length ? (
        <p className="note note-warn">
          <span>
            <strong>{steerable.map((seat) => seat.short).join(', ')}</strong> can both read mail and {steeredTo}. Anyone can send an email with instructions aimed at an agent, so what it reads could steer what it does.
          </span>
        </p>
      ) : null}
      {anyRuns && org.settings.execution !== 'managed' && sandbox ? (
        sandbox.available ? (
          <p className={`note ${org.settings.sandboxNetwork ? 'note-warn' : 'note-info'}`}>
            <span>
              <strong>{running.map((seat) => seat.short).join(', ')}</strong> can run code, in a sandbox started with {sandbox.runtime} from the image <code>{org.settings.sandboxImage}</code>.{' '}
              {org.settings.sandboxNetwork
                ? 'The sandbox can reach the network, so what is run in it can reach any site and this machine’s own network, and send what it can read there.'
                : 'The sandbox has no network.'}{' '}
              <button type="button" className="link" onClick={onSettings}>Open Settings</button> <HelpLink guide="code-execution">How a sandbox is confined</HelpLink>
            </span>
          </p>
        ) : (
          <p className="note note-warn">
            <span>
              <strong>{running.map((seat) => seat.short).join(', ')}</strong> may run code, but nothing can be run yet. {sandbox.reason} Until then {running.length === 1 ? 'its' : 'their'} agents are told that they cannot run code.{' '}
              <HelpLink guide="code-execution">Setting it up</HelpLink>
            </span>
          </p>
        )
      ) : null}
      <ErrorNote onDismiss={action.clearError}>{action.error}</ErrorNote>
      <div className="privileges-scroll">
        <table className="privileges-table">
          <thead>
            <tr>
              <th scope="col">What a role may do</th>
              {roles.map((seat) => <th scope="col" key={seat.id}><SeatBadge seat={seat} size="sm" /></th>)}
            </tr>
          </thead>
          <tbody>
            {GROUPS.flatMap((group) => [
              <tr className="privilege-group" key={group}><th colSpan={roles.length + 1} scope="colgroup"><span>{group}</span></th></tr>,
              ...PRIVILEGES.filter((p) => p.group === group).map((privilege) => (
                <tr key={privilege.id}>
                  <th scope="row">
                    {privilege.label}
                    <span className="privilege-detail">{privilege.detail}</span>
                  </th>
                  {roles.map((seat) => (
                    <Tick key={seat.id} org={org} seat={seat} privilege={privilege} busy={action.busy} onChange={(allowed) => void action.run(async () => onView(await api.privilege(org.id, seat.id, privilege.id, allowed)))} />
                  ))}
                </tr>
              )),
            ])}
          </tbody>
        </table>
      </div>
      <div className="privilege-always">
        <div>
          <h3>Every role can</h3>
          <ul>{EVERY_ROLE_CAN.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
        <div>
          <h3>No role can</h3>
          <ul>{NO_ROLE_CAN.map((line) => <li key={line}>{line}</li>)}</ul>
        </div>
      </div>
    </section>
  );
}
