import { useEffect, useRef, useState } from 'react';
import type {
  ActivityEntry,
  CreateOrgRequest,
  OperatingProfile,
  OrgSettings,
  OrgSummary,
  OrgView,
  ProviderInfo,
  Task,
  TeamRecommendation,
  WorkspaceFile,
} from '../shared/types';

export interface Meta {
  provider: ProviderInfo;
  providerReason: string;
  profiles: OperatingProfile[];
  defaults: OrgSettings;
  limits: { maxAgentsPerLead: number; maxLeads: number };
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Could not reach the server. Is it still running?');
  }
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = undefined;
  }
  if (!res.ok) throw new Error((data as { error?: string } | undefined)?.error ?? `The server answered ${res.status}.`);
  return data as T;
}

export const api = {
  meta: () => request<Meta>('GET', '/api/meta'),
  recommend: (idea: string) => request<TeamRecommendation>('POST', '/api/recommend', { idea }),
  orgs: () => request<OrgSummary[]>('GET', '/api/orgs'),
  create: (req: CreateOrgRequest) => request<OrgView>('POST', '/api/orgs', req),
  remove: (id: string) => request<void>('DELETE', `/api/orgs/${id}`),
  start: (id: string) => request<OrgView>('POST', `/api/orgs/${id}/start`),
  pause: (id: string) => request<OrgView>('POST', `/api/orgs/${id}/pause`),
  stop: (id: string) => request<OrgView>('POST', `/api/orgs/${id}/stop`),
  steer: (id: string, text: string) => request<OrgView>('POST', `/api/orgs/${id}/steer`, { text }),
  settings: (id: string, patch: Partial<OrgSettings>) => request<OrgView>('PATCH', `/api/orgs/${id}/settings`, patch),
  agents: (id: string, execId: string, agentCount: number) => request<OrgView>('PATCH', `/api/orgs/${id}/executives/${execId}`, { agentCount }),
  activity: (id: string) => request<ActivityEntry[]>('GET', `/api/orgs/${id}/activity`),
  task: (id: string, taskId: string) => request<{ task: Task }>('GET', `/api/orgs/${id}/tasks/${taskId}`),
  files: (id: string) => request<WorkspaceFile[]>('GET', `/api/orgs/${id}/files`),
  file: (id: string, path: string) =>
    request<{ path: string; content: string; truncated: boolean }>('GET', `/api/orgs/${id}/file?path=${encodeURIComponent(path)}`),
};

/**
 * Keeps a live view of one organisation. The server pushes a fresh view on
 * every change; the browser reconnects by itself if the stream drops.
 */
export function useOrgStream(id: string) {
  const [view, setView] = useState<OrgView | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [missing, setMissing] = useState(false);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    setView(null);
    setActivity([]);
    setMissing(false);
    seen.current = new Set();
    let closed = false;

    api
      .activity(id)
      .then((entries) => {
        if (closed) return;
        for (const e of entries) seen.current.add(e.id + e.at);
        setActivity(entries);
      })
      .catch(() => {});

    const source = new EventSource(`/api/orgs/${id}/events`);
    source.addEventListener('open', () => setConnected(true));
    source.addEventListener('view', (event) => setView(JSON.parse((event as MessageEvent).data) as OrgView));
    source.addEventListener('activity', (event) => {
      const entry = JSON.parse((event as MessageEvent).data) as ActivityEntry;
      const key = entry.id + entry.at;
      if (seen.current.has(key)) return;
      seen.current.add(key);
      setActivity((list) => [...list.slice(-299), entry]);
    });
    source.addEventListener('error', () => {
      setConnected(false);
      // A stream that never opened may mean the organisation is gone; ask once to tell the two apart.
      api.orgs().then(
        (orgs) => {
          if (!closed && !orgs.some((o) => o.id === id)) {
            setMissing(true);
            source.close();
          }
        },
        () => {},
      );
    });
    return () => {
      closed = true;
      source.close();
    };
  }, [id]);

  return { view, setView, activity, connected, missing };
}

/** Run an action, tracking whether it is in progress and what went wrong. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, clearError: () => setError(null) };
}
