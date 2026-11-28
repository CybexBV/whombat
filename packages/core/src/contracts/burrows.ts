/** The burrow, onboarding (3 steps, CT-68, CT-1506) and connected repos. */
import { z } from 'zod';
import { AgentFace, AgentName, AgentProvider } from '../domain/agent.js';
import { Burrow, BurrowName } from '../domain/burrow.js';
import { Email, RepoFullName } from '../domain/common.js';
import {
  LocalModelApiKey,
  LocalModelBaseUrl,
  LocalModelCheck,
  LocalModelLabel,
  LocalModelView,
} from '../domain/local-model.js';
import { ModelId } from '../domain/models.js';
import { OnboardingState, OnboardingStep } from '../domain/onboarding.js';
import { Agent, Person } from '../domain/principal.js';
import { LIVE_PROVIDERS, LiveProvider } from '../domain/providers.js';
import { LocalRepoName, Repo } from '../domain/repo.js';
import { WebSearchApiKey, WebSearchCheck, WebSearchView } from '../domain/web-search.js';
import { EventId, RepoId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

export const SlugCheckResponse = z.object({
  name: z.string(),
  /** `burrow-hq` */
  slug: z.string(),
  /** `app.whombat.com/burrow-hq` (`burrowAddress`) — the URL preview under the name input. */
  host: z.string(),
  available: z.boolean(),
  reason: z.enum(['taken', 'reserved', 'invalid']).nullable(),
});
export type SlugCheckResponse = z.infer<typeof SlugCheckResponse>;

export const CreateBurrowResponse = z.object({
  burrow: Burrow,
  /** The person whose Whombat it is. */
  me: Person,
  onboarding: OnboardingState,
});

export const CompleteOnboardingBody = z.object({
  /**
   * The provider picked in “Set up your AI”; absent = this Whombat's default (`defaultAgentProvider`). The agent runs
   * on the person's own sign-in for it (OP-09).
   */
  provider: AgentProvider.optional(),
});

export const CompleteOnboardingResponse = z.object({
  burrow: Burrow,
  /** The agent with the name and face chosen in “Meet your agent” (OA-13). */
  agent: Agent,
  /** Where "Open {burrow}" goes, e.g. `/burrow-hq/chat`. */
  redirectTo: z.string(),
});

/**
 * Creating a repository on this Whombat (`repos.create`, CT-192), as the caller may: whether they may, and the Git
 * identity its first commit is made with.
 */
export const RepoCreateInfo = z.object({
  /** The caller may create one now. */
  allowed: z.boolean(),
  /** Why not, in a sentence; null when allowed. */
  reason: z.string().max(300).nullable(),
  /** The Git identity of the first commit and of the repo's own config: the caller's name and email. */
  author: z.object({ name: z.string().min(1).max(200), email: Email }).nullable(),
});
export type RepoCreateInfo = z.infer<typeof RepoCreateInfo>;

export const ReposResponse = z.object({
  repos: z.array(Repo),
  /** The burrow is connected to GitHub (`api.github.status`). */
  githubConnected: z.boolean(),
  /** Creating a repository on this Whombat (CT-192). Absent: it can't. */
  create: RepoCreateInfo.optional(),
});

/** `repos.create` (CT-192): a new Git repository on this Whombat, in the burrow's default working directory. */
export const CreateRepoBody = z.object({
  name: LocalRepoName,
  /** Shown in Settings and written into the README. */
  description: z.string().trim().max(280).optional(),
});
export type CreateRepoBody = z.input<typeof CreateRepoBody>;

/** `owner/name` of a GitHub repository (defined in the domain since 0.26, CT-170). */
export { RepoFullName };

/** “Agents may reach your local network” (Whombat resourceful-agents.md RA-41, 0.44.0; local-network.md LN-01, 0.56.0). */
export const SetAgentsReachLanBody = z.object({ agentsReachLan: z.boolean() });
export type SetAgentsReachLanBody = z.input<typeof SetAgentsReachLanBody>;

/**
 * “Send Claude Code through Fusebox” and “Send ChatGPT through Fusebox” (0.76, CT-332; Whombat ai-gateway.md AIG-05):
 * the switches to change, at least one; the other keeps its state.
 */
export const SetAiGatewayBody = z
  .strictObject({ claude: z.boolean().optional(), codex: z.boolean().optional() })
  .refine((b) => b.claude !== undefined || b.codex !== undefined, 'Nothing to change.');
export type SetAiGatewayBody = z.input<typeof SetAiGatewayBody>;

/**
 * `burrows.setLocalModel` (0.124, CT-1171): the model on the person's network. `label` absent or null: none. `apiKey`: a
 * new key; null: none any more; absent: keep the saved one — only while the address stays on the same origin (scheme,
 * host and port), so a saved key never goes to another server (else `validation_failed` on `apiKey`).
 */
export const SetLocalModelBody = z.strictObject({
  baseUrl: LocalModelBaseUrl,
  model: ModelId,
  label: LocalModelLabel.nullable().optional(),
  apiKey: LocalModelApiKey.nullable().optional(),
});
export type SetLocalModelBody = z.input<typeof SetLocalModelBody>;

/**
 * `burrows.testLocalModel` (0.124, CT-1171): `draft` tries a model before it is saved (its `apiKey` absent: the saved
 * key, under `SetLocalModelBody`'s same-origin rule); without one the saved model is checked again and the result kept
 * (`LocalModelView.check`, the burrow published).
 */
export const TestLocalModelBody = z.strictObject({
  draft: z
    .strictObject({
      baseUrl: LocalModelBaseUrl,
      model: ModelId,
      apiKey: LocalModelApiKey.nullable().optional(),
    })
    .optional(),
});
export type TestLocalModelBody = z.input<typeof TestLocalModelBody>;

/** `burrows.setWebSearch` (Whombat web-search.md): the Brave Search key the person pasted. */
export const SetWebSearchBody = z.strictObject({ apiKey: WebSearchApiKey });
export type SetWebSearchBody = z.input<typeof SetWebSearchBody>;

export const burrowEndpoints = {
  slugCheck: endpoint({
    id: 'burrows.slugCheck',
    method: 'GET',
    path: '/burrows/slug-check',
    summary: 'Slug and URL preview for a burrow name, and whether it is free.',
    query: z.object({ name: z.string().max(80) }),
    response: SlugCheckResponse,
  }),
  create: endpoint({
    id: 'burrows.create',
    method: 'POST',
    path: '/burrows',
    summary:
      'Create the burrow (onboarding step 1) for the person whose Whombat it is. A Whombat holds one burrow: once it has one, 409 `conflict` (OA-01).',
    body: z.object({ name: BurrowName }),
    response: CreateBurrowResponse,
    status: 201,
  }),
  get: endpoint({
    id: 'burrows.get',
    method: 'GET',
    path: '/burrows/:burrow',
    summary: 'A burrow by slug.',
    params: B,
    response: z.object({ burrow: Burrow }),
  }),
  update: endpoint({
    id: 'burrows.update',
    method: 'PATCH',
    path: '/burrows/:burrow',
    summary: 'Rename the burrow or change its time zone (key burrow.manage).',
    params: B,
    body: z.object({
      name: BurrowName.optional(),
      timeZone: z.string().min(1).optional(),
    }),
    response: z.object({ burrow: Burrow }),
  }),
  setAgentsReachLan: endpoint({
    id: 'burrows.setAgentsReachLan',
    method: 'PUT',
    path: '/burrows/:burrow/agents-reach-lan',
    summary:
      '“The agent may reach your local network” on or off (key burrow.manage): the agent’s commands and the Vault reach every private address from their next command (off: the home network list only). Signs `burrow.agents_lan_changed` (Keys).',
    params: B,
    body: SetAgentsReachLanBody,
    response: z.object({ burrow: Burrow, eventId: EventId.nullable() }),
  }),
  setAiGateway: endpoint({
    id: 'burrows.setAiGateway',
    method: 'PUT',
    path: '/burrows/:burrow/ai-gateway',
    summary:
      'Send Claude Code or ChatGPT turns through the burrow’s AI gateway, or stop (key burrow.manage; AIG-05): every turn of an agent on that provider that starts afterwards goes through it, whoever asks; a running turn finishes the way it started. Signs `burrow.ai_gateway_changed` (Keys) per switch it changes (`gatewayKeysText`; `eventId`: the last, null when nothing changed) and publishes the burrow. Without a gateway connection: `not_found`. Feature `ai.gateway`.',
    params: B,
    body: SetAiGatewayBody,
    response: z.object({ burrow: Burrow, eventId: EventId.nullable() }),
  }),
  setLocalModel: endpoint({
    id: 'burrows.setLocalModel',
    method: 'PUT',
    path: '/burrows/:burrow/local-model',
    summary:
      'Set the custom OpenAI-compatible AI model (an internet service over https such as OpenRouter or Google Gemini, or a server on the person’s network; key burrow.manage): a base URL, the model, an optional name and API key (kept on the server, never answered). Saves it, tests it at once (`localModel.check`; a failed test doesn’t undo the save), signs `burrow.local_model_changed` (Keys; `eventId` null when nothing changed) and publishes the burrow. Turns on `local` that start afterwards use it. Feature `ai.local_model`.',
    params: B,
    body: SetLocalModelBody,
    response: z.object({ burrow: Burrow, localModel: LocalModelView, eventId: EventId.nullable() }),
  }),
  testLocalModel: endpoint({
    id: 'burrows.testLocalModel',
    method: 'POST',
    path: '/burrows/:burrow/local-model/test',
    summary:
      'Test a custom OpenAI-compatible AI model (key burrow.manage): `GET <base>/models` and one short completion, at most 20 s. A draft is only tried; the saved one is checked again and the result kept. Without a saved model and without a draft: `not_found`. Feature `ai.local_model`.',
    params: B,
    body: TestLocalModelBody,
    response: z.object({ check: LocalModelCheck }),
  }),
  clearLocalModel: endpoint({
    id: 'burrows.clearLocalModel',
    method: 'DELETE',
    path: '/burrows/:burrow/local-model',
    summary:
      'Remove the custom AI model and its key (key burrow.manage). The agent and Chat threads on `local` keep that choice but can’t reply (“the custom AI model isn’t set up”) until it is set again or another is picked. Signs `burrow.local_model_changed` (Keys) and publishes the burrow; `removed` false when there was none. Feature `ai.local_model`.',
    params: B,
    response: z.object({ burrow: Burrow, removed: z.boolean(), eventId: EventId.nullable() }),
  }),
  setWebSearch: endpoint({
    id: 'burrows.setWebSearch',
    method: 'PUT',
    path: '/burrows/:burrow/web-search',
    summary:
      'Turn on web search with a Brave Search API key (key burrow.manage; Whombat web-search.md): one search checks the key first; a key Brave turns away is `validation_failed` on `apiKey` and nothing is saved. Kept on the server, never answered. Signs `burrow.web_search_changed` (Keys; `eventId` null when nothing changed) and publishes the burrow. The person’s turns that start afterwards get `web_search` (under “Browse the web”).',
    params: B,
    body: SetWebSearchBody,
    response: z.object({ burrow: Burrow, webSearch: WebSearchView, eventId: EventId.nullable() }),
  }),
  testWebSearch: endpoint({
    id: 'burrows.testWebSearch',
    method: 'POST',
    path: '/burrows/:burrow/web-search/test',
    summary:
      'Check the saved Brave Search key again with one search (key burrow.manage), at most 15 s; the result is kept (`webSearch.check`) and the burrow published. Without web search: `not_found`.',
    params: B,
    response: z.object({ check: WebSearchCheck }),
  }),
  clearWebSearch: endpoint({
    id: 'burrows.clearWebSearch',
    method: 'DELETE',
    path: '/burrows/:burrow/web-search',
    summary:
      'Turn off web search and forget the Brave Search key (key burrow.manage). Signs `burrow.web_search_changed` (Keys) and publishes the burrow; `removed` false when there was none.',
    params: B,
    response: z.object({ burrow: Burrow, removed: z.boolean(), eventId: EventId.nullable() }),
  }),
};

export const onboardingEndpoints = {
  get: endpoint({
    id: 'onboarding.get',
    method: 'GET',
    path: '/burrows/:burrow/onboarding',
    summary: 'Onboarding progress: step, burrow name, chosen AI clients, the agent’s name and face.',
    params: B,
    response: OnboardingState,
  }),
  update: endpoint({
    id: 'onboarding.update',
    method: 'PATCH',
    path: '/burrows/:burrow/onboarding',
    summary:
      'Save progress (current step, burrow name, chosen AI clients and provider, the agent’s name and face).',
    params: B,
    body: z.object({
      step: OnboardingStep.optional(),
      burrowName: BurrowName.optional(),
      /** “Meet your agent” (OA-13): its name (`validation_failed` on `agentName` when malformed or reserved). */
      agentName: AgentName.optional(),
      /** “Meet your agent”: its face. */
      agentFace: AgentFace.optional(),
      /** “Set up your AI”: the chosen clients, unique (CT-68). Installing them is `clients.install`. */
      clients: z
        .array(LiveProvider)
        .max(LIVE_PROVIDERS.length)
        .refine((c) => new Set(c).size === c.length, 'each client once')
        .optional(),
      provider: AgentProvider.optional(),
    }),
    response: OnboardingState,
  }),
  complete: endpoint({
    id: 'onboarding.complete',
    method: 'POST',
    path: '/burrows/:burrow/onboarding/complete',
    summary: '"Open {burrow}": give the agent its name, face and default keys.',
    params: B,
    body: CompleteOnboardingBody,
    response: CompleteOnboardingResponse,
  }),
};

export const repoEndpoints = {
  list: endpoint({
    id: 'repos.list',
    method: 'GET',
    path: '/burrows/:burrow/repos',
    summary:
      'The burrow’s repos: every one the connected GitHub account owns, others the agent named, and the ones created on ' +
      'this Whombat.',
    params: B,
    response: ReposResponse,
  }),
  update: endpoint({
    id: 'repos.update',
    method: 'PATCH',
    path: '/burrows/:burrow/repos/:repoId',
    summary:
      'Older apps’ repo switch: every repo is the agent’s, so switching one on is accepted and switching one off is a ' +
      '409.',
    params: B.extend({ repoId: RepoId }),
    body: z.object({ enabled: z.boolean() }),
    response: z.object({ repo: Repo }),
  }),
  add: endpoint({
    id: 'repos.add',
    method: 'POST',
    path: '/burrows/:burrow/repos',
    summary:
      'Add a repo the connected gh account can reach, by `owner/name` (key burrow.manage; older apps’ picker): it is ' +
      'always switched on, whatever `enabled` says, and an added repo that was off is switched on.',
    params: B,
    body: z.object({ fullName: RepoFullName, enabled: z.boolean().default(true) }),
    response: z.object({ repo: Repo }),
  }),
  create: endpoint({
    id: 'repos.create',
    method: 'POST',
    path: '/burrows/:burrow/repos/local',
    summary:
      'Create a Git repository on this Whombat (CT-192): kept by Whombat, branch `main` with a first commit (a README) ' +
      'made as the caller, by their name and email. It joins the burrow as `local/<name>`, switched on; the agent checks ' +
      'it out and pushes to it as it does to GitHub (key burrow.manage).',
    params: B,
    body: CreateRepoBody,
    status: 201,
    response: z.object({ repo: Repo }),
  }),
  sync: endpoint({
    id: 'repos.sync',
    method: 'POST',
    path: '/burrows/:burrow/repos/sync',
    summary:
      'Bring in the repos the connected GitHub account owns and re-read the burrow’s from GitHub (description, ' +
      'language, default branch, last push).',
    params: B,
    response: ReposResponse,
  }),
};
