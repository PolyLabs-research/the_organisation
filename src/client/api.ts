import { useEffect, useRef, useState } from 'react';
import type {
  ActivityEntry,
  ConnectionInfo,
  CreateOrgRequest,
  OperatingProfile,
  OrgSettings,
  OrgSummary,
  OrgView,
  PresetInfo,
  ProviderInfo,
  Task,
  TeamRecommendation,
  WorkspaceFile,
} from '../shared/types';
import type { MemoryKind, MemorySearch, MemoryWhole } from '../shared/memory';

export interface Meta {
  provider: ProviderInfo;
  providerReason: string;
  profiles: OperatingProfile[];
  defaults: OrgSettings;
  limits: { maxAgentsPerLead: number; maxLeads: number };
  /** Organisations on disk that the server could not load when it started, and why: each is a folder under the data folder's orgs. */
  unreadable?: Array<{ folder: string; reason: string }>;
  /** The providers a key can be added for, and the day their list prices were read. Null on a server that keeps no keys. */
  keys: { presets: PresetInfo[]; forcedSimulation: boolean; pricesChecked: string } | null;
}

/** What comes back whenever keys are looked at or changed: the keys, and the models they now offer. */
export interface KeysView {
  connections: ConnectionInfo[];
  provider: ProviderInfo;
}

export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
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
  paperclips: () => request<OrgView>('POST', '/api/examples/only-paperclips'),
  meta: () => request<Meta>('GET', '/api/meta'),
  recommend: (idea: string) => request<TeamRecommendation>('POST', '/api/recommend', { idea }),
  orgs: () => request<OrgSummary[]>('GET', '/api/orgs'),
  create: (req: CreateOrgRequest) => request<OrgView>('POST', '/api/orgs', req),
  remove: (id: string) => request<void>('DELETE', `/api/orgs/${id}`),
  start: (id: string) => request<OrgView>('POST', `/api/orgs/${id}/start`),
  pause: (id: string) => request<OrgView>('POST', `/api/orgs/${id}/pause`),
  step: (id: string) => request<OrgView>('POST', `/api/orgs/${id}/step`),
  stop: (id: string) => request<OrgView>('POST', `/api/orgs/${id}/stop`),
  steer: (id: string, text: string) => request<OrgView>('POST', `/api/orgs/${id}/steer`, { text }),
  settings: (id: string, patch: Partial<OrgSettings>) => request<OrgView>('PATCH', `/api/orgs/${id}/settings`, patch),
  agents: (id: string, execId: string, agentCount: number) => request<OrgView>('PATCH', `/api/orgs/${id}/executives/${execId}`, { agentCount }),
  privilege: (id: string, seatId: string, privilege: string, allowed: boolean) => request<OrgView>('PATCH', `/api/orgs/${id}/privileges`, { seatId, privilege, allowed }),
  workApproach: (id: string, seatId: string, approachId: string, allowed: boolean) => request<OrgView>('PATCH', `/api/orgs/${id}/work-approaches`, { seatId, approachId, allowed }),
  business: (id: string, command: unknown) => request<OrgView>('POST', `/api/orgs/${id}/business`, command),
  reviewNow: (id: string) => request<OrgView>('POST', `/api/orgs/${id}/review-now`),
  activity: (id: string) => request<ActivityEntry[]>('GET', `/api/orgs/${id}/activity`),
  history: (id: string) => request<ActivityEntry[]>('GET', `/api/orgs/${id}/activity/history`),
  task: (id: string, taskId: string) => request<{ task: Task }>('GET', `/api/orgs/${id}/tasks/${taskId}`),
  /** Answer a request to the signatory: it is done, it is rejected (with the reason), or the answer is taken back. */
  answerRequest: (id: string, requestId: string, action: 'done' | 'rejected' | 'reopen', note: string) =>
    request<OrgView>('POST', `/api/orgs/${id}/requests/${requestId}`, { action, note }),
  signatoryNote: (id: string, text: string) => request<OrgView>('POST', `/api/orgs/${id}/signatory/notes`, { text }),
  archiveSession: (id: string, planId: string) => request<{ archived: number; left: number; view: OrgView }>('POST', `/api/orgs/${id}/plans/${planId}/archive-session`),
  archiveSessions: (id: string) => request<{ archived: number; left: number; view: OrgView }>('POST', `/api/orgs/${id}/archive-sessions`),
  connections: () => request<KeysView>('GET', '/api/connections'),
  connect: (body: { presetId: string; apiKey: string; region?: string; baseURL?: string; label?: string }) => request<KeysView>('POST', '/api/connections', body),
  refreshConnection: (id: string) => request<KeysView>('POST', `/api/connections/${id}/refresh`),
  patchConnection: (id: string, body: { label?: string; apiKey?: string; addModel?: string; price?: { model: string; input: number | null; output?: number } }) =>
    request<KeysView>('PATCH', `/api/connections/${id}`, body),
  disconnect: (id: string) => request<KeysView>('DELETE', `/api/connections/${id}`),
  /** Search the organisation's memory. With nothing to look for, it answers with how much the memory holds. */
  memory: (id: string, query: string, kind: MemoryKind | null) =>
    request<MemorySearch>('GET', `/api/orgs/${id}/memory?q=${encodeURIComponent(query)}${kind ? `&kind=${kind}` : ''}`),
  remembered: (id: string, itemId: string) => request<MemoryWhole>('GET', `/api/orgs/${id}/memory/item?id=${encodeURIComponent(itemId)}`),
  files: (id: string) => request<WorkspaceFile[]>('GET', `/api/orgs/${id}/files`),
  file: (id: string, path: string) =>
    request<{ path: string; content: string; truncated: boolean }>('GET', `/api/orgs/${id}/file?path=${encodeURIComponent(path)}`),
};

/** How long a dashboard may be out of view before it gives its stream up. Long enough that a glance at another tab costs nothing. */
const REST_AFTER_MS = 2000;

/**
 * Keeps a live view of one organisation. The server pushes a fresh view on
 * every change; the browser reconnects by itself if the stream drops, and a
 * stream it has given up on is opened again from here.
 *
 * A dashboard that is out of view gives its stream up, and opens it again when
 * it is looked at: `resumed` counts those returns, for whatever must then ask
 * again for what it missed.
 */
export function useOrgStream(id: string) {
  const [view, setView] = useState<OrgView | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [missing, setMissing] = useState(false);
  const [resumed, setResumed] = useState(0);
  const seen = useRef(new Set<string>());

  useEffect(() => {
    setView(null);
    setActivity([]);
    setMissing(false);
    seen.current = new Set();
    let closed = false;

    // The most recent calls, asked for when the page opens and again after a spell out of view. What the stream has
    // already brought is kept, and what it brought while the answer was on its way is not lost to it.
    const recent = () =>
      api
        .activity(id)
        .then((entries) => {
          if (closed) return;
          const fresh = entries.filter((e) => !seen.current.has(e.id + e.at));
          for (const e of fresh) seen.current.add(e.id + e.at);
          if (fresh.length) setActivity((list) => [...list, ...fresh].sort((a, b) => a.at.localeCompare(b.at)).slice(-300));
        })
        .catch(() => {});
    void recent();

    let source: EventSource;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const open = () => {
      const stream = (source = new EventSource(`/api/orgs/${id}/events`));
      stream.addEventListener('open', () => {
        failures = 0;
        setConnected(true);
      });
      stream.addEventListener('view', (event) => setView(JSON.parse((event as MessageEvent).data) as OrgView));
      stream.addEventListener('activity', (event) => {
        const entry = JSON.parse((event as MessageEvent).data) as ActivityEntry;
        const key = entry.id + entry.at;
        if (seen.current.has(key)) return;
        seen.current.add(key);
        setActivity((list) => [...list.slice(-299), entry]);
      });
      stream.addEventListener('error', () => {
        setConnected(false);
        // A stream that drops, the browser opens again. One that is answered with an error (by a proxy in front of a
        // server that is away, say) it closes for good, so that one is opened again from here: after a second, then
        // two, then four, up to half a minute.
        if (stream.readyState === EventSource.CLOSED && !closed) retry = setTimeout(open, Math.min(30_000, 1000 * 2 ** failures++));
        // A stream that never opened may mean the organisation is gone; ask once to tell the two apart.
        api.orgs().then(
          (orgs) => {
            if (!closed && !orgs.some((o) => o.id === id)) {
              closed = true;
              setMissing(true);
              clearTimeout(retry);
              source.close();
            }
          },
          () => {},
        );
      });
    };
    open();

    // A browser keeps at most six connections to one server, and a stream holds one for as long as it is open. With six
    // dashboards open, nothing more could be asked of the server from any of them: every button waited, without a word.
    // So a dashboard nobody is looking at lets its stream go, and one that is looked at again opens it and is sent the
    // organisation as it then is.
    let resting = false;
    let rest: ReturnType<typeof setTimeout> | undefined;
    const onVisibility = () => {
      clearTimeout(rest);
      if (closed) return;
      if (document.visibilityState === 'hidden') {
        rest = setTimeout(() => {
          resting = true;
          clearTimeout(retry);
          source.close();
        }, REST_AFTER_MS);
      } else if (resting) {
        resting = false;
        failures = 0;
        setResumed((n) => n + 1);
        void recent();
        open();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();

    return () => {
      closed = true;
      clearTimeout(retry);
      clearTimeout(rest);
      document.removeEventListener('visibilitychange', onVisibility);
      source.close();
    };
  }, [id]);

  return { view, setView, activity, connected, missing, resumed };
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
