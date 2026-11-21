/**
 * A turn's resolved runtime when it is queued (docs/decisions/chat-runtime.md CR-02, CR-03; chat-runtime-server.md
 * CR-S04): the dispatch queue, a quiet wake, a retry and a turn queued again after a usage limit ask this. Kept apart from
 * `chats/runtime.ts` (commands, the popover's view) so the queue imports only reads.
 */
import {
  type ChatProvider,
  type ChatRuntime,
  type DispatchTrigger,
  type LocalModelView,
  localProviderModels,
  type ProviderModel,
} from '@whombat/core';
import { eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/client';
import { burrows, chatThreadRuntimes } from '../db/schema/index';
import { localModelView } from '../local-model/store';
import type { ConversationRow } from '../read/conversations';
import { agentRuntimeOf, type PrincipalRow } from '../read/principals';
import type { Services } from '../services';
import { chatRoomOf } from './rooms';
import { followsThreadChoice, resolveThreadRuntime } from './runtime-rules';

/**
 * The runtime a new turn is resolved to (CR-02, CR-03; CR-S04): when it is woken in a thread of its person's Chat by
 * something done in that thread (`followsThreadChoice`) and the thread has a choice, that choice (null when it is the
 * assistant's own now); null for every other turn.
 */
export async function dispatchRuntimeFor(
  db: Db,
  args: {
    agent: Pick<PrincipalRow, 'id' | 'kind' | 'runtime'>;
    conversation: ConversationRow | null | undefined;
    threadRootId: string | null;
    trigger: DispatchTrigger;
  },
): Promise<ChatRuntime | null> {
  const { agent, conversation, threadRootId } = args;
  if (!threadRootId || !conversation || !followsThreadChoice(args.trigger)) return null;
  if (agent.kind !== 'agent' || conversation.dmAgentId !== agent.id || chatRoomOf(conversation) !== 'chat')
    return null;
  const [row] = await db
    .select({ runtime: chatThreadRuntimes.runtime, conversationId: chatThreadRuntimes.conversationId })
    .from(chatThreadRuntimes)
    .where(eq(chatThreadRuntimes.rootId, threadRootId));
  if (!row || row.conversationId !== conversation.id) return null;
  return resolveThreadRuntime(agentRuntimeOf(agent.runtime), row.runtime);
}

/**
 * The models the runner listed for a provider (model-effort.md ME-04), null while none has. For `local` (CT-1173): the
 * burrow's own model and the ones its last test listed (`localProviderModels`), null without a model on the network.
 */
export function providerModels(
  services: Pick<Services, 'runtime'>,
  provider: ChatProvider,
  localModel?: Pick<LocalModelView, 'model' | 'label' | 'check'> | null,
): ProviderModel[] | null {
  if (provider === 'local') return localModel ? localProviderModels(localModel) : null;
  return services.runtime.setupStatus().providers.find((p) => p.provider === provider)?.models ?? null;
}

/** The burrow's model on its network as the person reads it (`Burrow.localModel`), or null. */
export async function burrowLocalModel(db: Db, burrowId: string): Promise<LocalModelView | null> {
  const [row] = await db
    .select({ localModel: burrows.localModel, localModelKeyEnc: burrows.localModelKeyEnc })
    .from(burrows)
    .where(eq(burrows.id, burrowId));
  return row ? localModelView(row) : null;
}

/** The stored choices of these threads (by first message); a thread without one is left out. */
export async function threadChoices(db: Db, rootIds: readonly string[]): Promise<Map<string, ChatRuntime>> {
  if (rootIds.length === 0) return new Map();
  const rows = await db
    .select({ rootId: chatThreadRuntimes.rootId, runtime: chatThreadRuntimes.runtime })
    .from(chatThreadRuntimes)
    .where(inArray(chatThreadRuntimes.rootId, [...rootIds]));
  return new Map(rows.map((r) => [r.rootId, r.runtime]));
}
