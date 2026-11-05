import { useEffect, useState } from 'react';
import { api, type Meta } from './api';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { Models } from './Models';
import { ErrorNote } from './ui';
import { Wizard } from './Wizard';

type Route = { page: 'home' } | { page: 'new' } | { page: 'models' } | { page: 'org'; id: string };

function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'new') return { page: 'new' };
  if (path === 'models') return { page: 'models' };
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

  // Which models there are changes when a key is added or removed, so it is asked again on every page.
  const reload = () => api.meta().then(setMeta, (err: Error) => setError(err.message));
  useEffect(() => {
    void reload();
  }, [route.page]);
  // Keys are added on a page of their own, often in another tab; the lists of models here follow on coming back.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <a className="wordmark" href="#/">
          <span className="wordmark-mark" aria-hidden="true" />
          the_organisation
        </a>
        {meta ? (
          <a
            className={`provider ${meta.provider.simulated ? 'provider-sim' : 'provider-live'}`}
            href={meta.keys ? '#/models' : undefined}
            title={meta.provider.simulated ? 'No model is being called. Add an API key to call real ones.' : `Calls are made to ${meta.provider.label}`}
          >
            <span className="provider-dot" aria-hidden="true" />
            {meta.provider.simulated ? 'Simulation: no model is being called' : `Live: ${meta.provider.label}`}
            {meta.keys ? <span className="provider-more">Models and keys</span> : null}
          </a>
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
        ) : route.page === 'models' ? (
          <Models meta={meta} onChange={reload} />
        ) : route.page === 'org' ? (
          <Dashboard key={route.id} id={route.id} meta={meta} />
        ) : (
          <Home meta={meta} />
        )}
      </main>
    </div>
  );
}
