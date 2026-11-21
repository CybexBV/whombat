/**
 * An agent's model and effort in fixture mode (`VITE_FIXTURE_MODELS=1`, option `models`; Whombat model-effort.md
 * ME-01…ME-07; app docs/decisions/model-effort.md AP-1134). The shared fixture world has no `host.agents`; this layer,
 * only when asked for, gives it a runner that reports what turns run on ready (hermes-engine-app.md AP-5046) and Claude
 * Code and Codex ready with their models as the tools list them (ME-04): Claude Code's Opus (its default), Fable,
 * Sonnet and Haiku, each Low…Max; Codex's GPT-6.1-Sol (its default, Low…Ultra) and GPT-5.5 (Low…Extra high). The agent
 * runs on them with each person's own sign-in: Claude Code with Fable at High effort — its last turn ran on the default
 * model because Fable wasn't on Priya's sign-in (ME-05). `agent.update` saves a model runtime as the server does: a
 * model or an effort the list doesn't have is refused (a model on the network takes any name and no effort), and a new
 * model (or provider) clears the note. State lives in the closure; outermost but the photos, so it decorates every other
 * layer's agent.
 */

import type { Agent, AgentProfile, Bootstrap } from '@whombat/core';
import { API_ENDPOINTS, matchPath } from '@whombat/core/contracts';
import {
  type AgentEffort,
  type AgentModelFallback,
  type AgentModelRuntime,
  type AgentSetupStatus,
  modelOf,
  PROVIDER_LABELS,
  type ProviderModel,
} from '@whombat/core/domain';
import { EFFORT_LABELS } from '@whombat/core/text';
import { burrow } from '@whombat/fixtures';
import { WHOMBAT_HANDLE } from './oneFixtures';

const API_BASE = '/api/v1';
/** The mock world's moment is 09:22 UTC on Wednesday 23 September 2026. */
const CHECKED = '2026-09-23T09:20:00.000Z';

const CLAUDE_EFFORTS: AgentEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude Code 2.1.296's `initialize` models, `default` left out and Opus its default (ME-04). */
export const FIXTURE_CLAUDE_MODELS: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Opus 5.5 · Best for everyday, complex tasks',
    efforts: CLAUDE_EFFORTS,
    isDefault: true,
    // Claude Code's `supportsFastMode` (chat-runtime.md CR-06): offered, off unless asked.
    fast: 'off',
  },
  {
    id: 'fable',
    label: 'Fable',
    description: 'Fable 5.1 · Most capable for long, hard work',
    efforts: CLAUDE_EFFORTS,
    isDefault: false,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Sonnet 5 · Fast and capable for everyday tasks',
    efforts: CLAUDE_EFFORTS,
    isDefault: false,
  },
  {
    id: 'haiku',
    label: 'Haiku',
    description: 'Haiku 4.5 · Fastest for quick answers',
    efforts: CLAUDE_EFFORTS,
    isDefault: false,
  },
];

/** Codex 0.162.1's `model/list`, hidden ones left out (ME-04). */
export const FIXTURE_CODEX_MODELS: ProviderModel[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    description: 'Latest frontier model for coding and long tasks',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    isDefault: true,
    // Codex's priority tier, its default service tier here (CR-06).
    fast: 'on',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Fast, dependable coding model',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    isDefault: false,
  },
];

/** `host.agents`: what turns run on and both tools ready, the tools with their models. */
export function fixtureSetupStatus(): AgentSetupStatus {
  return {
    runner: { connected: true, seenAt: CHECKED },
    hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
    providers: [
      {
        provider: 'claude',
        state: 'ready',
        version: '2.1.296 (Claude Code)',
        detail: null,
        sandboxProblem: null,
        models: FIXTURE_CLAUDE_MODELS,
      },
      {
        provider: 'codex',
        state: 'ready',
        // What the runner says for ChatGPT on Hermes's own loop (Whombat hermes-native.md HN-C07); never shown (AP-5613).
        version: 'Hermes 0.22.5',
        detail: null,
        sandboxProblem: null,
        models: FIXTURE_CODEX_MODELS,
      },
    ],
    defaultProvider: 'claude',
    checkedAt: CHECKED,
    recheckPending: false,
  };
}

const MODELS: Record<'claude' | 'codex', ProviderModel[]> = {
  claude: FIXTURE_CLAUDE_MODELS,
  codex: FIXTURE_CODEX_MODELS,
};

interface AgentModelState {
  runtime: AgentModelRuntime;
  fallback: AgentModelFallback | null;
}

/** Where the agent starts (and the mock world's crew, for the screens that still draw it). */
function seed(): Map<string, AgentModelState> {
  const agent: AgentModelState = {
    runtime: { provider: 'claude', model: 'fable', effort: 'high' },
    fallback: { model: 'fable', where: { kind: 'account', name: 'Priya' }, at: '2026-09-23T09:05:00.000Z' },
  };
  return new Map<string, AgentModelState>([[WHOMBAT_HANDLE, agent]]);
}

export interface ModelFixtures {
  /** `host.agents` and `agent.update` with a runtime; null for every other request. */
  handle(req: Request, inner: (r: Request) => Promise<Response>): Promise<Response | null>;
  /** The agent's model runtime in the bootstrap and `agent.get` (with the fallback). */
  decorate(req: Request, response: Response): Promise<Response>;
}

export function createModelFixtures(): ModelFixtures {
  const state = seed();
  const stateOf = (handle: string): AgentModelState =>
    state.get(handle) ?? { runtime: { provider: 'claude' }, fallback: null };

  /** The mock world's agent on its model runtime, on the person's own sign-in. */
  const live = (agent: Agent): Agent => {
    const { runtime } = stateOf(WHOMBAT_HANDLE);
    const { model: _model, effort: _effort, fast: _fast, ...host } = agent.runtime;
    return { ...agent, runtime: { ...host, ...runtime } };
  };

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

  /** The server's checks of a new model and effort (ME-04): the refusal's sentence, or null. */
  const refusal = (runtime: AgentModelRuntime): string | null => {
    if (runtime.provider !== 'claude' && runtime.provider !== 'codex') return null;
    const models = MODELS[runtime.provider];
    const model = modelOf(models, runtime.model);
    if (runtime.model && !model)
      return `${PROVIDER_LABELS[runtime.provider]} has no model called “${runtime.model}” on this Whombat.`;
    if (runtime.effort && model && !model.efforts.includes(runtime.effort))
      return `${model.label} doesn’t take ${EFFORT_LABELS[runtime.effort]} effort.`;
    return null;
  };

  return {
    async handle(req, inner) {
      const m = match(req);
      if (!m) return null;
      if (m.id === 'host.agents') return json(fixtureSetupStatus());
      if (m.id !== 'agent.update') return null;
      const body = (await req.clone().json()) as { runtime?: AgentModelRuntime };
      const handle = WHOMBAT_HANDLE;
      // The name and the face are another layer's (the one-Whombat world's).
      if (!body.runtime) return null;
      const read = await inner(
        new Request(new URL(`${API_BASE}/burrows/${burrow.slug}/agent`, 'http://fixtures.local')),
      );
      if (!read.ok) return read;
      const agent = ((await read.json()) as AgentProfile).agent;
      const refused = refusal(body.runtime);
      if (refused)
        return json(
          { error: { code: 'validation_failed', message: refused, fields: { runtime: [refused] } } },
          422,
        );
      const before = stateOf(handle);
      const { provider, model, effort, fast } = body.runtime;
      const tool = provider === 'local' ? null : MODELS[provider];
      const runtime: AgentModelRuntime = {
        provider,
        ...(model ? { model } : {}),
        // A model on the network takes no effort and has no fast replies (CT-1173).
        ...(effort && tool ? { effort } : {}),
        // Fast replies (chat-runtime.md CR-10): kept where the model offers them, as the server does.
        ...(fast !== undefined && tool && modelOf(tool, model)?.fast ? { fast } : {}),
      };
      // A new model (a new provider is one too) clears the note (ME-05).
      const fallback =
        before.fallback && before.runtime.provider === provider && before.runtime.model === model
          ? before.fallback
          : null;
      state.set(handle, { runtime, fallback });
      return json({ agent: live(agent) });
    },

    async decorate(req, response) {
      if (!response.ok) return response;
      const m = match(req);
      if (!m) return response;
      switch (m.id) {
        case 'conversations.bootstrap': {
          const data = (await response.json()) as Bootstrap;
          return json({
            ...data,
            principals: data.principals.map((p) => (p.kind === 'agent' ? live(p) : p)),
          });
        }
        case 'agent.get': {
          const data = (await response.json()) as AgentProfile;
          const agent = live(data.agent);
          if (agent === data.agent) return json(data);
          return json({ ...data, agent, modelFallback: stateOf(WHOMBAT_HANDLE).fallback });
        }
        default:
          return response;
      }
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
