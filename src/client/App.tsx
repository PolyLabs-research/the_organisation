import { useEffect, useRef, useState } from 'react';
import { api, type Meta } from './api';
import { Dashboard } from './Dashboard';
import { Home } from './Home';
import { Models } from './Models';
import { ErrorBoundary, ErrorNote } from './ui';
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

  // Which models there are changes when a key is added or removed, so it is asked again on every page. Answers
  // can come back out of order; only the answer to the latest question is kept.
  const asked = useRef(0);
  const reload = () => {
    const mine = ++asked.current;
    return api.meta().then(
      (next) => {
        if (mine !== asked.current) return;
        setMeta(next);
        setError(null);
      },
      (err: Error) => {
        if (mine === asked.current) setError(err.message);
      },
    );
  };
  useEffect(() => {
    void reload();
  }, [route.page]);
  // Keys are added on a page of their own, often in another tab; the lists of models here follow on coming back.
  useEffect(() => {
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // With several keys the bar names the first and counts the rest; the page behind the link lists them all.
  const keys = meta?.provider.connections?.map((c) => c.label) ?? [];
  const live = keys.length > 2 ? `${keys[0]} and ${keys.length - 1} more` : keys.length ? keys.join(' and ') : (meta?.provider.label ?? '');
  // A server that has had keys and has none now is neither simulating nor able to call anything.
  const keyless = !!meta && !meta.provider.simulated && !!meta.provider.connections && keys.length === 0;

  return (
    <div className="app">
      <header className="topbar">
        <a className="wordmark" href="#/">
          <span className="wordmark-mark" aria-hidden="true" />
          the_organisation
        </a>
        {meta ? (
          <a
            className={`provider ${meta.provider.simulated || keyless ? 'provider-sim' : 'provider-live'}`}
            href={meta.keys ? '#/models' : undefined}
            title={meta.provider.simulated ? 'No model is being called. Add an API key to call real ones.' : keyless ? 'Organisations pause when they next need a model. Add an API key.' : `Keys are connected for ${meta.provider.label}`}
          >
            <span className="provider-dot" aria-hidden="true" />
            {meta.provider.simulated ? 'Simulation: no model is being called' : keyless ? 'No key connected' : `Live: ${live}`}
            {meta.keys ? <span className="provider-more">Models and keys</span> : null}
          </a>
        ) : null}
      </header>
      <main className="page">
        {error ? <ErrorNote>{error}</ErrorNote> : null}
        {/* A page that cannot be drawn says so here, under the bar that leads to the others. Going to another page starts afresh. */}
        <ErrorBoundary key={route.page === 'org' ? `org/${route.id}` : route.page} what="This page">
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
        </ErrorBoundary>
      </main>
    </div>
  );
}
