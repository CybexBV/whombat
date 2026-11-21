/**
 * A model on the burrow's network in the demo world (Whombat hermes-engine.md HE-32; contracts 0.124 CT-1170…CT-1175;
 * hermes-engine-app.md AP-5126): with `localModel` on (`EXPO_PUBLIC_WHOMBAT_LOCAL_MODEL=1`) Lumio has “Llama on the NAS”
 * (`llama3.3:70b` at `http://192.168.1.20:11434/v1`, a key saved), last tested fine with `qwen3:32b` listed too; off,
 * none. Serves `burrows.setLocalModel`, `burrows.testLocalModel` and `burrows.clearLocalModel` as the server does: a
 * save tests at once and keeps the result, a draft is only tried, the saved one's test is kept, the burrow goes out as
 * `burrow.updated`. The NAS serves three models; any other name answers `no_model`. Pure TypeScript.
 */
import type { Burrow, LocalModelCheck, LocalModelView, RealtimeEvent } from '@whombat/core';
import type { SetLocalModelBody, TestLocalModelBody } from '@whombat/core/contracts';
import { BURROW_ID, burrow as fixtureBurrow } from '@whombat/fixtures';

/** What the NAS's model server serves (`GET /models`). */
export const NAS_MODELS = ['llama3.3:70b', 'qwen3:32b', 'mistral-small'] as const;

/** The seeded model: Llama on the NAS, tested a quarter of an hour before the world's moment. */
export function nasLocalModel(now: Date): LocalModelView {
  const at = new Date(now.getTime() - 15 * 60_000).toISOString();
  return {
    baseUrl: 'http://192.168.1.20:11434/v1',
    model: 'llama3.3:70b',
    label: 'Llama on the NAS',
    hasApiKey: true,
    check: { state: 'ok', at, models: ['llama3.3:70b', 'qwen3:32b'], detail: null },
    updatedAt: at,
  };
}

export interface LocalModelFixtureOptions {
  now: () => Date;
  emit: (topic: string, event: RealtimeEvent) => void;
  /** Start with Llama on the NAS. */
  on: boolean;
  /** The burrow as the rest of this world has it (its web search); the model goes on top. */
  burrow?: () => Burrow;
}

export function createLocalModelFixtures(options: LocalModelFixtureOptions) {
  const { now, emit } = options;
  let view: LocalModelView | null = options.on ? nasLocalModel(now()) : null;
  let seq = 0;

  /** A test as the NAS answers it: the model it serves, else `no_model`. */
  const test = (model: string): LocalModelCheck => {
    const served = (NAS_MODELS as readonly string[]).includes(model);
    return {
      state: served ? 'ok' : 'no_model',
      at: now().toISOString(),
      models: [...NAS_MODELS],
      detail: served ? null : `model “${model}” not found`,
    };
  };

  /** The burrow as the bootstrap has it in this world, with its model on the network. */
  const burrowNow = (): Burrow => ({
    ...(options.burrow?.() ?? { ...fixtureBurrow, name: 'Lumio' }),
    localModel: view,
  });
  const publish = () => emit(`burrow:${BURROW_ID}`, { type: 'burrow.updated', burrow: burrowNow() });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const bodyOf = <T>(init: RequestInit | undefined): T => JSON.parse(String(init?.body ?? '{}')) as T;

  return {
    view: () => view,
    /** A burrow read by anyone (the bootstrap, `burrows.get`), with the model as it is now. */
    burrow<B extends { localModel?: LocalModelView | null }>(b: B): B {
      return { ...b, localModel: view };
    },
    handle(id: string | undefined, init: RequestInit | undefined): Response | null {
      switch (id) {
        case 'burrows.setLocalModel': {
          const body = bodyOf<SetLocalModelBody>(init);
          const keyed = body.apiKey === undefined ? (view?.hasApiKey ?? false) : body.apiKey !== null;
          const at = now().toISOString();
          view = {
            baseUrl: body.baseUrl.trim(),
            model: body.model.trim(),
            label: body.label?.trim() || null,
            hasApiKey: keyed,
            check: test(body.model.trim()),
            updatedAt: at,
          };
          publish();
          return json({ burrow: burrowNow(), localModel: view, eventId: `evt_local-model-${++seq}` });
        }
        case 'burrows.testLocalModel': {
          const body = bodyOf<TestLocalModelBody>(init);
          if (body.draft) return json({ check: test(body.draft.model.trim()) });
          if (!view) return json({ error: { code: 'not_found', message: 'No model to test.' } }, 404);
          view = { ...view, check: test(view.model) };
          publish();
          return json({ check: view.check });
        }
        case 'burrows.clearLocalModel': {
          const removed = view !== null;
          view = null;
          if (removed) publish();
          return json({
            burrow: burrowNow(),
            removed,
            eventId: removed ? `evt_local-model-${++seq}` : null,
          });
        }
        default:
          return null;
      }
    },
  };
}
