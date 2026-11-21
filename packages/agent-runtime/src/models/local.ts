/**
 * A model on the person's network (docs/decisions/hermes-engine.md HE-32, HE-S55): an OpenAI-compatible endpoint, checked
 * before the person saves it and when they ask — `GET <base URL>/models` answers, and says which models it serves. Plain
 * `fetch`: whoever calls it decides where from (the server, on the appliance's own network).
 */

/** How long the check waits for an answer. */
export const LOCAL_MODEL_CHECK_MS = 5000;
/** The most model ids kept from an answer. */
export const LOCAL_MODEL_IDS_MAX = 200;

export type LocalModelCheck =
  | { ok: true; models: string[] }
  | { ok: false; reason: 'bad_url' | 'unreachable' | 'refused' | 'not_openai' };

/** The base URL as Hermes gets it: http(s), no query or fragment, no trailing slash; null when it isn't one. */
export function localModelBaseUrl(text: string): string | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password || u.search || u.hash)
    return null;
  return u.toString().replace(/\/+$/, '');
}

type Fetch = (url: string, init: RequestInit) => Promise<{ status: number; json(): Promise<unknown> }>;

/** Asks the endpoint for its models (`{data: [{id}]}`, or Ollama's `{models: [{name}]}`). */
export async function checkLocalModel(
  baseUrl: string,
  options: { fetch?: Fetch; timeoutMs?: number; key?: string } = {},
): Promise<LocalModelCheck> {
  const base = localModelBaseUrl(baseUrl);
  if (!base) return { ok: false, reason: 'bad_url' };
  const fetcher: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  let res: Awaited<ReturnType<Fetch>>;
  try {
    res = await fetcher(`${base}/models`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? LOCAL_MODEL_CHECK_MS),
      headers: options.key ? { authorization: `Bearer ${options.key}` } : {},
    });
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
  if (res.status === 401 || res.status === 403) return { ok: false, reason: 'refused' };
  if (res.status < 200 || res.status >= 300) return { ok: false, reason: 'not_openai' };
  const body = (await res.json().catch(() => null)) as {
    data?: { id?: unknown }[];
    models?: { name?: unknown }[];
  } | null;
  const ids = [
    ...(Array.isArray(body?.data) ? body.data.map((m) => m?.id) : []),
    ...(Array.isArray(body?.models) ? body.models.map((m) => m?.name) : []),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200);
  if (!Array.isArray(body?.data) && !Array.isArray(body?.models)) return { ok: false, reason: 'not_openai' };
  return { ok: true, models: [...new Set(ids)].slice(0, LOCAL_MODEL_IDS_MAX) };
}
