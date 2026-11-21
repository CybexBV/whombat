/**
 * Free checks of a pasted key (PV-03): a request that runs no model and uses no tokens — listing the models the key
 * may use. 200: valid. 401: the provider refused the key. Anything else (403 for a key without that permission,
 * rate limits, no network): not verified until first use. Never a paid probe; never a model call.
 */
export type Verification =
  | { result: 'valid' }
  | { result: 'invalid'; message: string }
  | { result: 'unverified'; message: string };

export type Fetch = (url: string, init: RequestInit) => Promise<Pick<Response, 'status'>>;

const TIMEOUT_MS = 10_000;

async function probe(fetchImpl: Fetch, url: string, headers: Record<string, string>): Promise<number | null> {
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.status;
  } catch {
    return null;
  }
}

function verdict(status: number | null, provider: string): Verification {
  if (status === 200) return { result: 'valid' };
  if (status === 401)
    return { result: 'invalid', message: `${provider} didn’t accept this key. Check it and paste it again.` };
  return {
    result: 'unverified',
    message:
      status === null
        ? `${provider} couldn’t be reached to check the key; it’s saved and will be checked on first use.`
        : `${provider} didn’t confirm the key (${status}); it’s saved and will be checked on first use.`,
  };
}

/** Anthropic: `GET /v1/models?limit=1` (the Models API). */
export async function verifyAnthropicKey(key: string, fetchImpl: Fetch = fetch): Promise<Verification> {
  const status = await probe(fetchImpl, 'https://api.anthropic.com/v1/models?limit=1', {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
  });
  return verdict(status, 'Anthropic');
}

/** OpenAI: `GET /v1/models`. */
export async function verifyOpenAIKey(key: string, fetchImpl: Fetch = fetch): Promise<Verification> {
  const status = await probe(fetchImpl, 'https://api.openai.com/v1/models', {
    authorization: `Bearer ${key}`,
  });
  return verdict(status, 'OpenAI');
}
