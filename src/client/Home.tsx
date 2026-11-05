import { Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { OrgSummary } from '../shared/types';
import { api, type Meta } from './api';
import { ErrorNote, PAUSE_REASONS, SeatBadge, money } from './ui';

function statusText(org: OrgSummary): string {
  if (org.status === 'running') return 'Running';
  if (org.status === 'idle') return 'Not started';
  return org.pauseReason ? PAUSE_REASONS[org.pauseReason] : 'Paused';
}

export function Home({ meta }: { meta: Meta }) {
  const [orgs, setOrgs] = useState<OrgSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = () =>
      api.orgs().then(
        (list) => {
          if (!live) return;
          setOrgs(list);
          setError(null);
        },
        (err: Error) => live && setError(err.message),
      );
    load();
    const timer = setInterval(load, 4000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return (
    <div className="home">
      <div className="page-head">
        <div>
          <h1>Organisations</h1>
          <p className="muted">
            Each one is a CEO, an executive team and the agents they direct, working in a loop on behalf of its shareholders.
          </p>
        </div>
        <a className="button button-primary" href="#/new">
          <Plus size={16} aria-hidden="true" /> New organisation
        </a>
      </div>

      {meta.provider.simulated ? (
        <div className="note note-info">
          <span>
            <strong>Running in simulation.</strong> Every seat gives a scripted answer, so you can watch the whole loop work without
            spending anything.{' '}
            {meta.keys?.forcedSimulation ? (
              <>The server was started with <code>ORG_PROVIDER=mock</code>, so it stays that way whatever keys are added.</>
            ) : meta.keys ? (
              <>
                To call real models, add an API key under <a href="#/models">Models and keys</a>.
              </>
            ) : null}
          </span>
        </div>
      ) : null}
      <ErrorNote>{error}</ErrorNote>

      {orgs === null ? (
        error ? null : (
          <p className="muted">Loading…</p>
        )
      ) : orgs.length === 0 ? (
        <section className="blank">
          <h2>No organisation yet</h2>
          <p>
            Describe an idea and have a team recommended, or seat the executives yourself. Every lead follows a standard operating
            profile and is given agents to carry out its plans.
          </p>
          <ol className="how">
            <li>
              <strong>Shareholders</strong> give steer.
            </li>
            <li>
              The <strong>CEO</strong> asks what the shareholders want, and directs the leads.
            </li>
            <li>
              Each <strong>lead</strong> runs a plan through its operating profile with its agents.
            </li>
            <li>
              Leads <strong>report to the board</strong>; when all work is done, the CEO asks again.
            </li>
          </ol>
          <a className="button button-primary" href="#/new">
            <Plus size={16} aria-hidden="true" /> Establish the first one
          </a>
        </section>
      ) : (
        <ul className="org-list">
          {orgs.map((org) => {
            const agents = org.executives.reduce((n, e) => n + e.agentCount, 0);
            const share = Math.min(100, (org.costUsd / org.budgetUsd) * 100);
            return (
              <li key={org.id}>
                <a className="org-row" href={`#/org/${org.id}`}>
                  <div className="org-row-main">
                    <h2>{org.name}</h2>
                    <p className="muted clamp-1">{org.mission}</p>
                    <div className="seat-row">
                      {org.executives.map((e) => (
                        <SeatBadge key={e.id} seat={e} size="sm" />
                      ))}
                      <span className="muted">
                        {agents} agent{agents === 1 ? '' : 's'}
                      </span>
                    </div>
                  </div>
                  <div className="org-row-side">
                    <span className={`status status-${org.status}${org.pauseReason === 'error' ? ' status-bad' : ''}`}>{statusText(org)}</span>
                    <span className="muted">Cycle {org.cycle}</span>
                    <span className="meter-line" title={`${money(org.costUsd)} of ${money(org.budgetUsd)}`}>
                      <span className="meter">
                        <span style={{ width: `${share}%` }} />
                      </span>
                      <span className="num">
                        {money(org.costUsd)} / {money(org.budgetUsd)}
                      </span>
                    </span>
                  </div>
                </a>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
