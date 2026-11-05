import { useEffect, useState } from 'react';
import { api, type Meta } from './api';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { ErrorNote } from './ui';
import { Wizard } from './Wizard';

type Route = { page: 'home' } | { page: 'new' } | { page: 'org'; id: string };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'new') return { page: 'new' };
  const org = /^org\/([A-Za-z0-9_-]+)$/.exec(path);
  if (org) return { page: 'org', id: org[1]! };
  return { page: 'home' };
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [meta, setMeta] = useState<Meta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onHash = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    api.meta().then(setMeta, (err: Error) => setError(err.message));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a className="wordmark" href="#/">
          <span className="wordmark-mark" aria-hidden="true" />
          the_organisation
        </a>
        {meta ? (
          <span
            className={`provider ${meta.provider.simulated ? 'provider-sim' : 'provider-live'}`}
            title={meta.provider.simulated ? `Simulation: ${meta.providerReason}` : `Calls are made to ${meta.provider.label}`}
          >
            <span className="provider-dot" aria-hidden="true" />
            {meta.provider.simulated ? 'Simulation: no model is being called' : `${meta.provider.label} is live`}
          </span>
        ) : null}
      </header>
      <main className="page">
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {!meta ? (
          error ? null : (
            <p className="muted">Loading…</p>
          )
        ) : route.page === 'new' ? (
          <Wizard meta={meta} />
        ) : route.page === 'org' ? (
          <Dashboard key={route.id} id={route.id} meta={meta} />
        ) : (
          <Home meta={meta} />
        )}
      </main>
    </div>
  );
}
