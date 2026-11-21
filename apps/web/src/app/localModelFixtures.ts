/**
 * A model on your network in fixture mode (Whombat hermes-engine.md HE-32; contracts 0.124 CT-1170…CT-1175; app
 * hermes-engine-app.md AP-5047). Always served, so you can set one up in any fixture world: `burrows.setLocalModel`
 * (saves, then tests at once), `burrows.testLocalModel` (a draft is only tried; the saved one keeps its result) and
 * `burrows.clearLocalModel`, with the burrow's `localModel` in the bootstrap and `burrows.get` and Local in
 * `chats.runtime` while there is one. The model server it plays is at 192.168.1.20 and serves llama3.3:70b, qwen3:32b
 * and mistral-small; any other address doesn't answer. `seeded` (`VITE_FIXTURE_LOCAL_MODEL=1`, option `localModel`)
 * starts with “Llama on the NAS” saved with a key and tested 2 minutes before the mock world's moment. Outermost but
 * the photos; state lives in the closure, built to the contracts' schemas.
 */
import type { Burrow, ChatRuntimeView } from '@whombat/core';
import { API_ENDPOINTS, matchPath, SetLocalModelBody, TestLocalModelBody } from '@whombat/core/contracts';
import {
  type LocalModelCheck,
  type LocalModelView,
  localModelUrlProblem,
  localProviderModels,
} from '@whombat/core/domain';
import { burrow } from '@whombat/fixtures';

const API_BASE = '/api/v1';
/** The mock world's moment is 09:22 UTC on Wednesday 23 September 2026. */
const TESTED = '2026-09-23T09:20:00.000Z';
const NOW = '2026-09-23T09:22:00.000Z';

/** The model server this world plays, and what it serves. */
const SERVER_HOST = '192.168.1.20';
const SERVED = ['llama3.3:70b', 'qwen3:32b', 'mistral-small'];

export const FIXTURE_LOCAL_MODEL: LocalModelView = {
  baseUrl: `http://${SERVER_HOST}:11434/v1`,
  model: 'llama3.3:70b',
  label: 'Llama on the NAS',
  hasApiKey: true,
  check: { state: 'ok', at: TESTED, models: SERVED, detail: null },
  updatedAt: '2026-09-21T15:04:00.000Z',
};

/** What the model server says to a test: it answers at 192.168.1.20 with its models, else not at all. */
export function fixtureLocalCheck(baseUrl: string, model: string): LocalModelCheck {
  const host = (() => {
    try {
      return new URL(baseUrl).hostname;
    } catch {
      return '';
    }
  })();
  if (localModelUrlProblem(baseUrl)) return { state: 'blocked', at: NOW, models: [], detail: null };
  if (host !== SERVER_HOST)
    return { state: 'unreachable', at: NOW, models: [], detail: 'connect ETIMEDOUT after 20 s' };
  if (!SERVED.includes(model)) return { state: 'no_model', at: NOW, models: SERVED, detail: null };
  return { state: 'ok', at: NOW, models: SERVED, detail: null };
}

export interface LocalModelFixtures {
  handle(req: Request, inner: (r: Request) => Promise<Response>): Promise<Response | null>;
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createLocalModelFixtures({ seeded = false }: { seeded?: boolean } = {}): LocalModelFixtures {
  let view: LocalModelView | null = seeded ? { ...FIXTURE_LOCAL_MODEL } : null;
  let seq = 0;

  const match = (req: Request) => {
    const url = new URL(req.url, 'http://fixtures.local');
    const path = url.pathname.startsWith(API_BASE) ? url.pathname.slice(API_BASE.length) : url.pathname;
    for (const ep of API_ENDPOINTS) {
      if (ep.method !== req.method) continue;
      const params = matchPath(ep.path, path);
      if (params && params.burrow === burrow.slug) return { id: ep.id, params };
    }
    return null;
  };

  /** The burrow as it is now, from the layers under this one. */
  const burrowNow = async (inner: (r: Request) => Promise<Response>): Promise<Burrow> => {
    const boot = await inner(
      new Request(new URL(`${API_BASE}/burrows/${burrow.slug}/bootstrap`, 'http://fixtures.local')),
    );
    const data = (await boot.json()) as { burrow: Burrow };
    return { ...data.burrow, localModel: view };
  };

  const invalid = (fields: Record<string, string[]>) =>
    json({ error: { code: 'validation_failed', message: 'Check the fields.', fields } }, 422);

  const fieldsOf = (issues: readonly { path: readonly PropertyKey[]; message: string }[]) => {
    const fields: Record<string, string[]> = {};
    for (const issue of issues) {
      const key = issue.path.map(String).join('.') || 'body';
      fields[key] = [...(fields[key] ?? []), issue.message];
    }
    return fields;
  };

  return {
    async handle(req, inner) {
      const m = match(req);
      if (!m) return null;
      switch (m.id) {
        case 'burrows.setLocalModel': {
          const parsed = SetLocalModelBody.safeParse(await req.clone().json());
          if (!parsed.success) return invalid(fieldsOf(parsed.error.issues));
          const body = parsed.data;
          const hasApiKey = body.apiKey === undefined ? !!view?.hasApiKey : body.apiKey !== null;
          view = {
            baseUrl: body.baseUrl,
            model: body.model,
            label: body.label ?? null,
            hasApiKey,
            check: fixtureLocalCheck(body.baseUrl, body.model),
            updatedAt: NOW,
          };
          return json({ burrow: await burrowNow(inner), localModel: view, eventId: `evt_local_${++seq}` });
        }
        case 'burrows.testLocalModel': {
          const parsed = TestLocalModelBody.safeParse(await req.clone().json());
          if (!parsed.success) return invalid(fieldsOf(parsed.error.issues));
          const draft = parsed.data.draft;
          if (draft) return json({ check: fixtureLocalCheck(draft.baseUrl, draft.model) });
          if (!view)
            return json(
              { error: { code: 'not_found', message: 'There is no custom AI model set up.' } },
              404,
            );
          view = { ...view, check: fixtureLocalCheck(view.baseUrl, view.model) };
          return json({ check: view.check });
        }
        case 'burrows.clearLocalModel': {
          const removed = !!view;
          view = null;
          return json({
            burrow: await burrowNow(inner),
            removed,
            eventId: removed ? `evt_local_${++seq}` : null,
          });
        }
        default:
          return null;
      }
    },

    async decorate(req, response) {
      if (!response.ok) return response;
      const m = match(req);
      if (!m) return response;
      switch (m.id) {
        case 'chats.runtime': {
          if (req.method !== 'GET') return response;
          const data = (await response.json()) as ChatRuntimeView;
          if (!view) return json(data);
          return json({
            ...data,
            providers: [
              ...data.providers.filter((p) => p.provider !== 'local'),
              {
                provider: 'local',
                ready: true,
                models: localProviderModels(view),
                fastBlocked: null,
                usage: null,
              },
            ],
          });
        }
        default: {
          // Every answer that carries the burrow (the bootstrap, `burrows.get`, the other burrow switches) has it.
          if (!response.headers.get('content-type')?.includes('application/json')) return response;
          const data = (await response.clone().json()) as { burrow?: Burrow };
          if (data?.burrow?.id !== burrow.id) return response;
          return json({ ...data, burrow: { ...data.burrow, localModel: view } }, response.status);
        }
      }
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
