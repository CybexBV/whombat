/** Contracts 0.96.0: provider, model, effort and fast replies in Chat (CT-456…CT-468). */
import { describe, expect, it } from 'vitest';
import { api, CompleteBody, REALTIME_EVENT_TOPICS, RealtimeEvent } from '../contracts/index.js';
import { AgentModelRuntime } from './agent.js';
import {
  type ChatRuntime,
  ChatRuntime as ChatRuntimeSchema,
  ChatRuntimeView,
  chatRuntimeEquals,
  chatRuntimeOf,
  chatRuntimeWithModel,
  chatRuntimeWithProvider,
  RanOn,
} from './chat-runtime.js';
import { ChatThread } from './conversation.js';
import { Message } from './message.js';
import { modelFast, type ProviderModel, ProviderModel as ProviderModelSchema, turnFast } from './models.js';

const T = '2026-10-19T15:00:00.000Z';

const claude: ProviderModel[] = [
  {
    id: 'opus',
    label: 'Opus',
    description: null,
    efforts: ['low', 'medium', 'high', 'max'],
    isDefault: true,
    fast: 'off',
  },
  { id: 'sonnet', label: 'Sonnet', description: null, efforts: ['low', 'medium'], isDefault: false },
  { id: 'tiny', label: 'Tiny', description: null, efforts: [], isDefault: false, fast: null },
];

const ranOn = {
  provider: 'claude',
  model: 'opus',
  modelLabel: 'Opus',
  effort: 'high',
  fast: true,
} as const;

describe('fast replies on a model and an agent (CT-456, CT-457)', () => {
  it('lists a model’s fast replies, optional as from older runners', () => {
    expect(ProviderModelSchema.parse(claude[0]).fast).toBe('off');
    expect(ProviderModelSchema.parse(claude[1]).fast).toBeUndefined();
    expect(ProviderModelSchema.safeParse({ ...claude[0], fast: 'auto' }).success).toBe(false);
    expect(AgentModelRuntime.parse({ provider: 'claude', fast: true }).fast).toBe(true);
    expect(AgentModelRuntime.parse({ provider: 'claude' }).fast).toBeUndefined();
  });

  it('reads the model’s fast replies, the default model’s without an id', () => {
    expect(modelFast(claude, 'opus')).toBe('off');
    expect(modelFast(claude, null)).toBe('off');
    expect(modelFast(claude, 'sonnet')).toBeNull();
    expect(modelFast(claude, 'tiny')).toBeNull();
    expect(modelFast(undefined, 'opus')).toBeNull();
  });

  it('asks for fast only when the runtime says so and the model has it', () => {
    expect(turnFast(true, 'off')).toBe(true);
    expect(turnFast(false, 'on')).toBe(false);
    expect(turnFast(undefined, 'on')).toBeNull();
    expect(turnFast(true, null)).toBeNull();
    expect(turnFast(false, undefined)).toBeNull();
  });
});

describe('what the runner ran (CT-458)', () => {
  it('reports the model, effort and fast, optional for older runners', () => {
    const base = { attempt: 1, outcome: 'done' } as const;
    const ran = { model: null, effort: 'medium', fast: false, fastSkipped: 'credits' } as const;
    expect(CompleteBody.parse({ ...base, ran }).ran).toEqual(ran);
    expect(CompleteBody.parse(base).ran).toBeUndefined();
    expect(CompleteBody.safeParse({ ...base, ran: { ...ran, fastSkipped: 'later' } }).success).toBe(false);
    expect(CompleteBody.safeParse({ ...base, ran: { model: 'opus', effort: null } }).success).toBe(false);
  });
});

describe('a choice of what answers (CT-459)', () => {
  it('takes Claude or ChatGPT, nothing else', () => {
    expect(
      ChatRuntimeSchema.parse({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', fast: true }),
    ).toEqual({
      provider: 'codex',
      model: 'gpt-6.1-sol',
      effort: 'high',
      fast: true,
    });
    expect(ChatRuntimeSchema.safeParse({ provider: 'acp' }).success).toBe(false);
  });

  it('reads the assistant’s own runtime, none on another provider', () => {
    expect(chatRuntimeOf({ provider: 'claude', model: 'opus', effort: 'high', fast: false })).toEqual({
      provider: 'claude',
      model: 'opus',
      effort: 'high',
      fast: false,
    });
    expect(chatRuntimeOf({ provider: 'codex' })).toEqual({ provider: 'codex' });
    expect(chatRuntimeOf(null)).toBeNull();
  });

  it('resets model, effort and fast with another provider', () => {
    const runtime: ChatRuntime = { provider: 'claude', model: 'opus', effort: 'high', fast: true };
    expect(chatRuntimeWithProvider(runtime, 'codex')).toEqual({ provider: 'codex' });
    expect(chatRuntimeWithProvider(runtime, 'claude')).toBe(runtime);
  });

  it('keeps the effort within the model’s and drops fast where it has none', () => {
    const runtime: ChatRuntime = { provider: 'claude', model: 'opus', effort: 'max', fast: true };
    expect(chatRuntimeWithModel(runtime, 'sonnet', claude)).toEqual({
      provider: 'claude',
      model: 'sonnet',
      effort: 'medium',
    });
    expect(chatRuntimeWithModel(runtime, 'tiny', claude)).toEqual({ provider: 'claude', model: 'tiny' });
    expect(chatRuntimeWithModel({ ...runtime, model: 'sonnet' }, null, claude)).toEqual({
      provider: 'claude',
      effort: 'max',
      fast: true,
    });
    expect(chatRuntimeWithModel({ provider: 'claude' }, 'sonnet', claude)).toEqual({
      provider: 'claude',
      model: 'sonnet',
    });
    // A model the list doesn't have keeps both.
    expect(chatRuntimeWithModel(runtime, 'fable', claude)).toEqual({ ...runtime, model: 'fable' });
    expect(chatRuntimeWithModel(runtime, 'fable', undefined)).toEqual({ ...runtime, model: 'fable' });
  });

  it('compares choices, absent and null alike', () => {
    expect(chatRuntimeEquals(null, undefined)).toBe(true);
    expect(chatRuntimeEquals({ provider: 'claude' }, null)).toBe(false);
    expect(
      chatRuntimeEquals({ provider: 'claude', effort: 'high' }, { effort: 'high', provider: 'claude' }),
    ).toBe(true);
    expect(chatRuntimeEquals({ provider: 'claude', fast: false }, { provider: 'claude' })).toBe(false);
    expect(chatRuntimeEquals({ provider: 'claude' }, { provider: 'codex' })).toBe(false);
  });

  it('is stored with a Chat thread, optional as from older servers', () => {
    const thread = {
      conversationId: 'cnv_chat',
      room: 'chat',
      rootId: 'msg_root1',
      authorId: 'prn_john',
      text: 'Why is pve-02 slow?',
      createdAt: T,
      replyCount: 1,
      lastAt: T,
      working: false,
    } as const;
    expect(ChatThread.parse(thread).runtime).toBeUndefined();
    expect(ChatThread.parse({ ...thread, runtime: null }).runtime).toBeNull();
    expect(ChatThread.parse({ ...thread, runtime: { provider: 'codex' } }).runtime).toEqual({
      provider: 'codex',
    });
  });
});

describe('what answered a reply (CT-460)', () => {
  const message = {
    id: 'msg_reply1',
    conversationId: 'cnv_chat',
    authorId: 'prn_neo',
    createdAt: T,
    editedAt: null,
    text: 'It’s swapping.',
    mentions: [],
    card: null,
    attachments: [],
    reactions: [],
    threadRootId: 'msg_root1',
    replyCount: 0,
    lastReplyAt: null,
    threadParticipantIds: [],
    clientId: null,
  };

  it('rides on the message, optional as from older servers', () => {
    expect(Message.parse(message).ranOn).toBeUndefined();
    const skipped = { ...ranOn, fast: false, fastSkipped: 'busy', modelSkipped: 'fable' } as const;
    expect(Message.parse({ ...message, ranOn: skipped }).ranOn).toEqual(skipped);
    expect(RanOn.parse({ ...ranOn, model: null, modelLabel: null, effort: null }).model).toBeNull();
    expect(RanOn.safeParse({ ...ranOn, provider: 'acp' }).success).toBe(false);
    expect(RanOn.safeParse({ ...ranOn, modelLabel: 'x'.repeat(61) }).success).toBe(false);
  });
});

describe('chats.runtime and chats.setThreadRuntime (CT-461, CT-462)', () => {
  const view = {
    assistantId: 'prn_neo',
    assistantName: 'Neo',
    default: { provider: 'claude' },
    thread: null,
    providers: [
      {
        provider: 'claude',
        ready: true,
        models: claude,
        fastBlocked: null,
        usage: { usedPct: 38, resetsAt: T },
      },
      { provider: 'codex', ready: false, models: [], fastBlocked: 'gateway', usage: null },
    ],
  } as const;

  it('reads what answers, a thread’s choice with `thread`', () => {
    const e = api.chats.runtime;
    expect([e.id, e.method, e.path]).toEqual(['chats.runtime', 'GET', '/burrows/:burrow/chats/runtime']);
    expect(e.query.parse({ thread: 'msg_root1' }).thread).toBe('msg_root1');
    expect(e.query.parse({})).toEqual({});
    expect(e.query.safeParse({ thread: 'cnv_chat' }).success).toBe(false);
    expect(e.response.parse(view)).toEqual(ChatRuntimeView.parse(view));
    const { thread: _, ...noThread } = view;
    expect(e.response.parse(noThread).thread).toBeUndefined();
    // At most one per provider: Claude, ChatGPT and Local (CT-1174).
    const four = [...view.providers, ...view.providers];
    expect(e.response.safeParse({ ...view, providers: four }).success).toBe(false);
    const over = { ...view.providers[0], usage: { usedPct: 101, resetsAt: null } };
    expect(e.response.safeParse({ ...view, providers: [over] }).success).toBe(false);
  });

  it('sets a thread’s choice, null to follow the assistant again', () => {
    const e = api.chats.setThreadRuntime;
    expect([e.id, e.method, e.path]).toEqual([
      'chats.setThreadRuntime',
      'PUT',
      '/burrows/:burrow/chats/threads/:rootId/runtime',
    ]);
    expect(e.params.parse({ burrow: 'lumio', rootId: 'msg_root1' }).rootId).toBe('msg_root1');
    expect(e.body.parse({ runtime: null }).runtime).toBeNull();
    expect(e.body.parse({ runtime: { provider: 'codex', fast: true } }).runtime).toEqual({
      provider: 'codex',
      fast: true,
    });
    expect(e.body.safeParse({}).success).toBe(false);
    expect(e.response.parse({ thread: null }).thread).toBeNull();
  });

  it('starts a thread with a choice', () => {
    const body = api.chats.start.body.parse({
      text: 'Quick one',
      runtime: { provider: 'codex', effort: 'low' },
    });
    expect(body.runtime).toEqual({ provider: 'codex', effort: 'low' });
    expect(api.chats.start.body.parse({ text: 'Quick one' }).runtime).toBeUndefined();
  });

  it('tells the person’s own devices about a thread’s new choice', () => {
    const event = {
      type: 'chat.thread_runtime',
      conversationId: 'cnv_chat',
      rootId: 'msg_root1',
      runtime: null,
    };
    expect(RealtimeEvent.parse(event)).toEqual(event);
    expect(REALTIME_EVENT_TOPICS['chat.thread_runtime']).toEqual(['me']);
  });
});

describe('0.96.1: the Chat box sends its choice with the message (CT-469)', () => {
  it('SendMessageBody takes a runtime, also with files only', async () => {
    const { SendMessageBody } = await import('../contracts/conversations.js');
    const runtime: ChatRuntime = { provider: 'codex', effort: 'high', fast: true };
    expect(SendMessageBody.parse({ text: 'Hi', runtime }).runtime).toEqual(runtime);
    expect(
      SendMessageBody.safeParse({ text: '', attachmentIds: ['att_abcdefghijkl'], runtime }).success,
    ).toBe(true);
    expect(SendMessageBody.parse({ text: 'Hi' }).runtime).toBeUndefined();
    expect(SendMessageBody.safeParse({ text: 'Hi', runtime: { provider: 'acp' } }).success).toBe(false);
  });
});
