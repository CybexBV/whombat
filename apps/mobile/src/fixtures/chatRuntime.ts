/**
 * What answers in Chat, in the one-Whombat demo world (Whombat chat-runtime.md CR-01…CR-11; chat-runtime-android.md
 * AP-2732): Neo on Claude Code's default (Opus, automatic effort) with Claude Code 2.1.296 (Opus with fast replies,
 * Fable, Sonnet, Haiku) and Codex 0.162.1 (GPT-6.1 Sol, GPT-6 Astra, GPT-6 Luna with fast replies on by default, and
 * four more) both ready for Mara, this 5-hour window at 38% and 12%; the pve-02 thread switched to ChatGPT at High
 * effort with fast replies, Zonneplan's on fast replies, the heat pump's asking for Fable. Serves `chats.runtime` and
 * `chats.setThreadRuntime` (a `chat.thread_runtime` frame to Mara's devices), what a new top-level message or thread
 * chose (`messages.send` / `chats.start` `runtime`), “Make this Neo’s default” and Runs on's `host.agents`; and says
 * what a new reply ran on (`ranOn`). With a model on the burrow's network (`localModel`, AP-5126) Local is the third
 * provider, its models the burrow's own and the others its server listed. Pure TypeScript; every answer parses with its
 * endpoint's schema (tested).
 */
import {
  type AgentModelRuntime,
  type AgentSetupStatus,
  type ChatRuntime,
  type ChatRuntimeView,
  chatRuntimeEquals,
  chatRuntimeOf,
  type LocalModelView,
  localProviderModels,
  modelOf,
  type ProviderModel,
  type RanOn,
  type RealtimeEvent,
  turnEffort,
  turnFast,
} from '@whombat/core';

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

/** Claude Code's list (its `initialize`): Opus by default, with fast replies off unless asked. */
export const CLAUDE_MODELS: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: 'Everyday, complex tasks',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: true,
    fast: 'off',
  },
  {
    id: 'fable',
    label: 'Fable',
    description: 'Hardest, longest tasks',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: false,
  },
  {
    id: 'sonnet',
    label: 'Sonnet',
    description: 'Routine tasks',
    efforts: [...CLAUDE_EFFORTS],
    isDefault: false,
  },
  { id: 'haiku', label: 'Haiku', description: 'Quick answers', efforts: [], isDefault: false },
];

/** Codex's `model/list`: GPT-6.1 Sol by default; every model has the fast tier, on by default on GPT-6 Luna. */
export const CODEX_MODELS: ProviderModel[] = [
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1 Sol',
    description: 'Coding and everyday work',
    efforts: [...CODEX_EFFORTS],
    isDefault: true,
    fast: 'off',
  },
  {
    id: 'gpt-6-astra',
    label: 'GPT-6 Astra',
    description: 'Most demanding work',
    efforts: [...CODEX_EFFORTS],
    isDefault: false,
    fast: 'off',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6 Luna',
    description: 'Quick, light tasks',
    efforts: ['low', 'medium', 'high'],
    isDefault: false,
    fast: 'on',
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6 Sol',
    description: 'The previous Sol',
    efforts: [...CODEX_EFFORTS],
    isDefault: false,
    fast: 'on',
  },
  {
    id: 'gpt-5.5',
    label: 'GPT-5.5',
    description: 'Older, steady',
    efforts: ['low', 'medium', 'high', 'xhigh'],
    isDefault: false,
    fast: 'off',
  },
  {
    id: 'gpt-5.5-mini',
    label: 'GPT-5.5 Mini',
    description: 'Small and quick',
    efforts: ['low', 'medium'],
    isDefault: false,
    fast: 'off',
  },
  {
    id: 'gpt-5-codex',
    label: 'GPT-5 Codex',
    description: 'Code only',
    efforts: ['low', 'medium', 'high'],
    isDefault: false,
    fast: 'off',
  },
];

const MODELS = { claude: CLAUDE_MODELS, codex: CODEX_MODELS } as const;

/**
 * What a reply that ran on `runtime` says (CR-07): the model asked for (or the default), its effort and speed. `local`:
 * the models of the burrow's model on its network (`localProviderModels`).
 */
export function ranOnFor(
  runtime: ChatRuntime,
  extra: Partial<RanOn> = {},
  local: LocalModelView | null = null,
): RanOn {
  const models = runtime.provider === 'local' ? localProviderModels(local) : MODELS[runtime.provider];
  const model = modelOf(models, runtime.model);
  return {
    provider: runtime.provider,
    model: runtime.model ?? null,
    modelLabel: model?.label ?? null,
    effort: turnEffort(runtime.effort, 'chat', model?.efforts ?? null),
    fast: turnFast(runtime.fast, model?.fast) ?? model?.fast === 'on',
    ...extra,
  };
}

/** The demo's replies that say what answered them, by thread (`chatChannel.ts` puts them on its messages). */
export const DEMO_RAN_ON = {
  zonneplanFirst: ranOnFor({ provider: 'claude', fast: true }),
  zonneplanLast: ranOnFor({ provider: 'claude', fast: true }, { fast: false, fastSkipped: 'busy' }),
  heat: ranOnFor({ provider: 'claude' }, { model: 'opus', modelSkipped: 'fable' }),
  memoryFirst: ranOnFor({ provider: 'claude', effort: 'high' }),
  memoryLast: ranOnFor({ provider: 'codex', effort: 'high' }),
} satisfies Record<string, RanOn>;

export interface ChatRuntimeFixtureOptions {
  now: () => Date;
  emit: (topic: string, event: RealtimeEvent) => void;
  assistantId: string;
  assistantName: () => string;
  /** Mara's topic, where a thread's choice goes to her devices. */
  meTopic: string;
  /** The Chat's conversation, for `chat.thread_runtime`. */
  chatId: string;
  /** Threads that start with a choice of their own. */
  threads: Record<string, ChatRuntime>;
  /** The burrow's model on its network as it is now; null: none (no Local in the picker). */
  localModel?: () => LocalModelView | null;
}

export function createChatRuntimeFixtures(options: ChatRuntimeFixtureOptions) {
  const { now, emit } = options;
  let assistantDefault: ChatRuntime = { provider: 'claude' };
  const threads = new Map<string, ChatRuntime | null>(Object.entries(options.threads));
  const resetsAt = () => new Date(now().getTime() + 2 * 60 * 60_000 + 14 * 60_000).toISOString();

  const localNow = () => options.localModel?.() ?? null;
  const view = (thread: string | null): ChatRuntimeView => {
    const local = localNow();
    return {
      assistantId: options.assistantId as ChatRuntimeView['assistantId'],
      assistantName: options.assistantName(),
      default: assistantDefault,
      ...(thread ? { thread: threads.get(thread) ?? null } : {}),
      providers: [
        {
          provider: 'claude',
          ready: true,
          models: CLAUDE_MODELS,
          fastBlocked: null,
          usage: { usedPct: 38, resetsAt: resetsAt() },
        },
        {
          provider: 'codex',
          ready: true,
          models: CODEX_MODELS,
          fastBlocked: null,
          usage: { usedPct: 12, resetsAt: resetsAt() },
        },
        // Local (CT-1174): listed while the burrow has a model on its network; no usage, no fast replies.
        ...(local
          ? [
              {
                provider: 'local' as const,
                ready: true,
                models: localProviderModels(local),
                fastBlocked: null,
                usage: null,
              },
            ]
          : []),
      ],
    };
  };

  /** A thread's choice (CR-02): one equal to Neo's own is stored as null; Mara's devices hear of it. */
  const set = (rootId: string, runtime: ChatRuntime | null): ChatRuntime | null => {
    const stored = runtime && !chatRuntimeEquals(runtime, assistantDefault) ? runtime : null;
    threads.set(rootId, stored);
    emit(options.meTopic, {
      type: 'chat.thread_runtime',
      conversationId: options.chatId as never,
      rootId: rootId as never,
      runtime: stored,
    });
    return stored;
  };

  return {
    view,
    set,
    /** What a new reply in the thread runs on: its own choice, else Neo's. */
    ranOn: (rootId: string): RanOn => ranOnFor(threads.get(rootId) ?? assistantDefault, {}, localNow()),
    /** “Make this Neo’s default” (`agents.update` `runtime`). */
    setDefault(runtime: AgentModelRuntime) {
      assistantDefault = chatRuntimeOf(runtime) ?? assistantDefault;
    },
    /** Runs on's read of the tools (`host.agents`): both ready, with their models. */
    agentSetup(): AgentSetupStatus {
      const at = now().toISOString();
      return {
        runner: { connected: true, seenAt: at },
        hermes: { ready: true, version: '0.22.5', problem: null, detail: null },
        providers: [
          {
            provider: 'claude',
            state: 'ready',
            version: '2.1.296',
            detail: null,
            sandboxProblem: null,
            models: CLAUDE_MODELS,
          },
          {
            provider: 'codex',
            state: 'ready',
            version: 'Hermes 0.22.5',
            detail: null,
            sandboxProblem: null,
            models: CODEX_MODELS,
          },
        ],
        defaultProvider: 'claude',
        checkedAt: at,
        recheckPending: false,
      };
    },
  };
}
