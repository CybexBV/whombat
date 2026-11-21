// The assistant (docs/ASSIST.md): settings, Claude Code / Codex providers and
// investigations. Calls, query hooks and the cache reducers the SSE events
// (`assistant.*`, events.ts) and the mutations share. Admins only; every
// change of the settings and providers needs a recent sign-in (the client's
// reauth handler asks and retries).

import { type QueryClient, useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { ApiError, apiRequest } from './client';
import { useAuthState } from './queries';

export type {
  ProviderId,
  Access,
  InvestigationState,
  AssistantSettings,
  ProviderState,
  AssistantState,
  Investigation,
  InvestigationEvent,
  InvestigationDetail,
  InvestigationStart,
  InvestigationFilter,
} from './assist-types';
import type { AssistantSettings, AssistantState, Investigation, InvestigationDetail, InvestigationEvent, InvestigationFilter, InvestigationStart, ProviderId } from './assist-types';

// ------------------------------------------------------------------ calls

const e = encodeURIComponent;
const BASE = '/assistant';
const inv = (id: string) => `${BASE}/investigations/${e(id)}`;

/** A bare list or one wrapped in `items`. */
function items<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  const list = (v as { items?: unknown } | null)?.items;
  return Array.isArray(list) ? (list as T[]) : [];
}

export const assistApi = {
  state: async (signal?: AbortSignal): Promise<AssistantState> => (await apiRequest('GET', BASE, { signal })) as AssistantState,
  saveSettings: async (patch: Partial<AssistantSettings>): Promise<AssistantState> => (await apiRequest('PUT', `${BASE}/settings`, { body: patch })) as AssistantState,
  /** Install, or update to the newest version (202: progress follows in `assistant.state`). */
  install: async (p: ProviderId): Promise<AssistantState> => (await apiRequest('POST', `${BASE}/providers/${p}/install`, { body: {} })) as AssistantState,
  uninstall: async (p: ProviderId): Promise<AssistantState> => (await apiRequest('DELETE', `${BASE}/providers/${p}`)) as AssistantState,
  /** Claude Code: the `claude setup-token` token; Codex: starts the device login (`login` in the answer). */
  signIn: async (p: ProviderId, token?: string): Promise<AssistantState> =>
    (await apiRequest('POST', `${BASE}/providers/${p}/login`, { body: p === 'claude' ? { token } : {} })) as AssistantState,
  /** Sign out, or cancel a pending device login. */
  signOut: async (p: ProviderId): Promise<AssistantState> => (await apiRequest('DELETE', `${BASE}/providers/${p}/login`)) as AssistantState,

  investigations: async (f: InvestigationFilter, signal?: AbortSignal): Promise<Investigation[]> =>
    items<Investigation>(await apiRequest('GET', `${BASE}/investigations`, { params: { server: f.server, alert: f.alert, limit: f.limit }, signal })),
  start: async (s: InvestigationStart): Promise<Investigation> => (await apiRequest('POST', `${BASE}/investigations`, { body: s })) as Investigation,
  investigation: async (id: string, signal?: AbortSignal): Promise<InvestigationDetail> => {
    const d = (await apiRequest('GET', inv(id), { signal })) as InvestigationDetail;
    return { investigation: d.investigation, events: d.events ?? [] };
  },
  send: async (id: string, text: string): Promise<Investigation> => (await apiRequest('POST', `${inv(id)}/messages`, { body: { text } })) as Investigation,
  stop: async (id: string): Promise<Investigation> => (await apiRequest('POST', `${inv(id)}/stop`, { body: {} })) as Investigation,
  decide: async (id: string, approvalId: string, approve: boolean, reply?: string): Promise<Investigation> =>
    (await apiRequest('POST', `${inv(id)}/approvals/${e(approvalId)}`, { body: { approve, ...(reply ? { reply } : {}) } })) as Investigation,
  remove: async (id: string): Promise<void> => {
    await apiRequest('DELETE', inv(id));
  },
};

// ------------------------------------------------------------------ cache reducers (pure)

/** Whether an investigation belongs in a list with these filters. */
export function matchesFilter(i: Investigation, f: InvestigationFilter): boolean {
  return (!f.server || i.server === f.server) && (!f.alert || i.alert_id === f.alert);
}

const newer = (a: Investigation, b: Investigation) => Date.parse(a.updated_at) >= Date.parse(b.updated_at);

/**
 * The list with `i` replaced (unless the cached copy is newer), or added in
 * its place by creation time (newest first) when it is new and matches the
 * filters; the list keeps its limit.
 */
export function upsertInvestigation(list: Investigation[], i: Investigation, f: InvestigationFilter = {}): Investigation[] {
  const at = list.findIndex((x) => x.id === i.id);
  if (at >= 0) {
    if (!newer(i, list[at]!)) return list;
    const out = list.slice();
    out[at] = i;
    return out;
  }
  if (!matchesFilter(i, f)) return list;
  const created = Date.parse(i.created_at);
  const pos = list.findIndex((x) => Date.parse(x.created_at) < created);
  const out = pos < 0 ? [...list, i] : [...list.slice(0, pos), i, ...list.slice(pos)];
  return f.limit && out.length > f.limit ? out.slice(0, f.limit) : out;
}

export function removeInvestigation(list: Investigation[], id: string): Investigation[] {
  return list.some((x) => x.id === id) ? list.filter((x) => x.id !== id) : list;
}

/** The detail with `ev` added in `seq` order; an event already there (by seq) is ignored. */
export function appendEvent(d: InvestigationDetail, ev: InvestigationEvent): InvestigationDetail {
  if (d.events.some((x) => x.seq === ev.seq)) return d;
  const last = d.events[d.events.length - 1];
  const events = !last || last.seq < ev.seq ? [...d.events, ev] : [...d.events, ev].sort((a, b) => a.seq - b.seq);
  return { ...d, events };
}

/** The detail with its investigation replaced (unless the cached copy is newer). */
export function withInvestigation(d: InvestigationDetail, i: Investigation): InvestigationDetail {
  if (d.investigation.id !== i.id || !newer(i, d.investigation)) return d;
  return { ...d, investigation: i };
}

// ------------------------------------------------------------------ queries

export const assistKeys = {
  all: ['assistant'] as const,
  state: ['assistant', 'state'] as const,
  lists: ['assistant', 'investigations'] as const,
  list: (f: InvestigationFilter) => ['assistant', 'investigations', f.server ?? '', f.alert ?? '', f.limit ?? 0] as const,
  detail: (id: string) => ['assistant', 'investigation', id] as const,
};

/** The filters of a list query key (assistKeys.list). */
function filterOfKey(key: readonly unknown[]): InvestigationFilter {
  const [, , server, alert, limit] = key;
  return { server: (server as string) || undefined, alert: (alert as string) || undefined, limit: (limit as number) || undefined };
}

/** Put an investigation (created, changed) into every cached list and its detail. */
export function storeInvestigation(qc: QueryClient, i: Investigation): void {
  for (const [key, list] of qc.getQueriesData<Investigation[]>({ queryKey: assistKeys.lists })) {
    if (Array.isArray(list)) qc.setQueryData(key, upsertInvestigation(list, i, filterOfKey(key)));
  }
  qc.setQueryData<InvestigationDetail>(assistKeys.detail(i.id), (d) => (d ? withInvestigation(d, i) : d));
}

function dropInvestigation(qc: QueryClient, id: string): void {
  for (const [key, list] of qc.getQueriesData<Investigation[]>({ queryKey: assistKeys.lists })) {
    if (Array.isArray(list)) qc.setQueryData(key, removeInvestigation(list, id));
  }
  qc.removeQueries({ queryKey: assistKeys.detail(id) });
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/** Applies one `assistant.*` SSE payload to the caches (events.ts). */
export function applyAssistantEvent(qc: QueryClient, name: string, data: Record<string, unknown>): void {
  switch (name) {
    case 'assistant.state':
      if (isObj(data.settings) && isObj(data.providers)) qc.setQueryData(assistKeys.state, data as unknown as AssistantState);
      break;
    case 'assistant.investigation':
      if (typeof data.id === 'string' && typeof data.state === 'string') storeInvestigation(qc, data as unknown as Investigation);
      break;
    case 'assistant.event': {
      const ref = data.investigation;
      const id = typeof ref === 'string' ? ref : isObj(ref) && typeof ref.id === 'string' ? ref.id : '';
      const ev = data.event;
      if (!id || !isObj(ev) || typeof ev.seq !== 'number') break;
      qc.setQueryData<InvestigationDetail>(assistKeys.detail(id), (d) => (d ? appendEvent(d, ev as unknown as InvestigationEvent) : d));
      break;
    }
    case 'assistant.deleted':
      if (typeof data.id === 'string') dropInvestigation(qc, data.id);
      break;
  }
}

/** Refusals (4xx) do not pass on a second try. */
const retry = (count: number, err: Error) => !(err instanceof ApiError && err.status < 500) && count < 2;

/** Settings, runner and providers. Polled fast while a provider installs or waits for its device login (SSE also pushes them). */
export function useAssistant(enabled = true): UseQueryResult<AssistantState> {
  return useQuery({
    queryKey: assistKeys.state,
    queryFn: ({ signal }) => assistApi.state(signal),
    enabled,
    retry,
    refetchInterval: (q) => {
      const p = q.state.data?.providers;
      return p && Object.values(p).some((x) => x.busy || x.login) ? 2_000 : 60_000;
    },
  });
}

/** Admins see the assistant's buttons (Investigate, Ask assistant) while it is on. */
export function useAssistantEnabled(): boolean {
  const auth = useAuthState();
  const admin = auth.data?.user?.role === 'admin' && !auth.data.kiosk;
  const s = useAssistant(admin);
  return admin && s.data?.settings?.enabled === true;
}

/** Investigations, newest first. */
export function useInvestigations(f: InvestigationFilter = {}, enabled = true): UseQueryResult<Investigation[]> {
  return useQuery({ queryKey: assistKeys.list(f), queryFn: ({ signal }) => assistApi.investigations(f, signal), enabled, retry, refetchInterval: 30_000 });
}

/** One investigation with its transcript; SSE appends to it. */
export function useInvestigation(id: string, enabled = true): UseQueryResult<InvestigationDetail> {
  return useQuery({ queryKey: assistKeys.detail(id), queryFn: ({ signal }) => assistApi.investigation(id, signal), enabled: enabled && !!id, retry, refetchInterval: 30_000 });
}

// ------------------------------------------------------------------ mutations

/** Changes that answer the whole AssistantState (settings, providers). */
export function useAssistantChange<V>(fn: (v: V) => Promise<AssistantState>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (s) => qc.setQueryData(assistKeys.state, s) });
}

/** Starts an investigation and puts it into the cached lists. */
export function useStartInvestigation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (s: InvestigationStart) => assistApi.start(s), onSuccess: (i) => storeInvestigation(qc, i) });
}

/** Changes of one investigation that answer it (message, stop, approval). */
export function useInvestigationChange<V>(fn: (v: V) => Promise<Investigation>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: (i) => storeInvestigation(qc, i) });
}

export function useDeleteInvestigation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => assistApi.remove(id), onSuccess: (_d, id) => dropInvestigation(qc, id) });
}
