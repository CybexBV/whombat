/**
 * Servers changes in the commit pipeline (one-whombat-servers.md ONE-DH09, ONE-DH12): `hosts.change` signs what a person
 * (or Whombat through the Servers tools) changed on a server once the hosts service accepted it, and records it for
 * Done recently with the recipe that undoes it (ONE-08) — power (the inverse action), configuration (the previous
 * values), switches and settings (the previous ones), an alert's acknowledgement (taken back), and a Servers tool's
 * change its own inverse call takes back (`hosts.tool_inverse`).
 *
 * The call itself runs before this commit (the ops are `never` resent, contracts CT-339), so a refusal signs nothing:
 * the hosts service audits refused attempts under the person's name itself.
 */
import { ConversationId, GuideCard, thingHref } from '@whombat/core';
import { z } from 'zod';
import { type CommitResult, defineCommand } from '../commit/types';
import { postMessage } from '../domain/messages';
import { EVERYDAY_CHANGE_PREFIX } from '../home/changes';
import { homeAudience, publishHomeChanged } from '../home/notify';
import { recordChange, recordOrMergeChange } from '../home/registry';
import { forbidden, notFound } from '../lib/errors';
import { loadConversationRow } from '../read/conversations';
import { AGENT_WATCH_CHANGE_KIND } from '../things/quiet/commands';
import { forgetServerAsks, setServerAsks } from './asks';
import { isMergingOp, settingsMerge } from './merge';
import { forgetServerName } from './names';
import { serverLabel } from './self';

/** What Undo needs, by kind (sealed with the change). */
export const HOSTS_UNDO_KINDS = [
  'hosts.guest_power',
  'hosts.guest_config',
  'hosts.server_settings',
  'hosts.alert_ack',
  // A Servers tool's change undone by the tool's own inverse call (backup protection and notes, firewall on/off and a
  // rule's on/off, a backup job's pause and guests, HA that wasn't there; proxmox-server.md).
  'hosts.tool_inverse',
] as const;

export const HostsChangeInput = z.object({
  /** The signed line: “Restarted web on pve-02”. */
  text: z.string().min(1).max(300),
  op: z.string().min(1).max(60),
  serverId: z.string().min(1).max(200),
  guestId: z.string().max(200).nullable().optional(),
  /** Ids the service gave (action, task, audit), for the log's payload. */
  ids: z.record(z.string(), z.string().max(500)).optional(),
  /** Done recently (ONE-08): the change's title and, when it can be undone, its recipe. */
  change: z
    .object({
      title: z.string().min(1).max(200),
      detail: z.string().max(1000).nullable().optional(),
      subject: z
        .object({ kind: z.string(), id: z.string(), name: z.string().optional() })
        .nullable()
        .optional(),
      undo: z
        .object({ kind: z.enum(HOSTS_UNDO_KINDS), payload: z.unknown() })
        .nullable()
        .optional(),
      /**
       * A settings save (`server_settings`, `guest_config`; home-redesign.md HR-06): the fields it changed and what they
       * belong to (“pve-01”, “web on pve-02”). It merges into the actor's last such change of the same server or guest
       * within 2 minutes, and the title names the fields.
       */
      merge: z
        .object({
          fields: z.array(z.string().min(1).max(80)).min(1).max(50),
          target: z.string().min(1).max(200),
        })
        .optional(),
      /**
       * An everyday step (a click on a Mac's screen by position, macos-servers.md): only the server's own list of
       * changes shows it, not Done recently.
       */
      everyday: z.boolean().optional(),
    })
    .optional(),
  /** Whombat made it through a Servers tool: the person it was for. */
  forPersonId: z.string().max(64).nullable().optional(),
  conversationId: z.string().max(64).nullable().optional(),
  /**
   * The thread of that conversation it was made in; absent: the agent's turn's there. A followed task's change is
   * recorded when it ends, in the thread the task was told in (task-feedback.md TF-13).
   */
  threadRootId: z.string().max(64).nullable().optional(),
  /** This change undoes an earlier one. */
  undoes: z
    .object({ changeId: z.string().max(64), byId: z.string().max(64) })
    .nullable()
    .optional(),
});
export type HostsChangeInput = z.infer<typeof HostsChangeInput>;

export const recordHostsChange = defineCommand({
  name: 'hosts.change',
  schema: HostsChangeInput,
  async apply(_tx, ctx, input) {
    // A removed server's “Asks you first” goes with it (server-asks.md SA-04).
    if (input.op === 'server_remove') {
      await forgetServerAsks(ctx, input.serverId);
      await forgetServerName(ctx, input.serverId);
    }
    const event = await ctx.emit({
      type: 'hosts.change',
      kind: 'System',
      text: input.text,
      where: `Servers · ${serverLabel(input.serverId)}`,
      payload: {
        op: input.op,
        serverId: input.serverId,
        ...(input.guestId ? { guestId: input.guestId } : {}),
        ...(input.ids ?? {}),
      },
    });
    let changeId: string | null = null;
    if (input.change) {
      const agent = ctx.actor.kind === 'agent';
      const change = {
        burrowId: ctx.burrow.id,
        actorId: ctx.actor.id,
        agentId: agent ? ctx.actor.id : null,
        personId: agent ? (input.forPersonId ?? null) : ctx.actor.id,
        kind: `${input.change.everyday ? EVERYDAY_CHANGE_PREFIX : ''}hosts.${input.op}`,
        title: input.change.title,
        detail: input.change.detail ?? null,
        subject: input.change.subject ?? {
          kind: 'server',
          id: input.serverId,
          name: serverLabel(input.serverId),
        },
        undo: input.change.undo ? { kind: input.change.undo.kind, payload: input.change.undo.payload } : null,
        link: thingHref('server', input.serverId),
        conversationId: input.conversationId ?? null,
        ...(input.threadRootId !== undefined ? { threadRootId: input.threadRootId } : {}),
        at: ctx.now,
        undoes: input.undoes ?? null,
      };
      // Settings saved in a row are one change (HR-06).
      const merge = input.change.merge;
      changeId =
        merge && isMergingOp(input.op)
          ? (
              await recordOrMergeChange(
                ctx,
                change,
                settingsMerge({ op: input.op, serverId: input.serverId, guestId: input.guestId, ...merge }),
              )
            ).changeId
          : await recordChange(ctx, change);
    }
    return { eventId: event.id, changeId };
  },
});

/**
 * `server_add` (server-signin.md SI-10): Whombat puts a card in the conversation it was asked in, whose one button opens
 * Add a server filled in. Posted as the agent, waking nobody; the person signs in there and the model never sees the
 * password. The card is made (and checked against the contract) by the tool.
 */
export const askAddServer = defineCommand({
  name: 'hosts.ask_add_server',
  schema: z.object({ conversationId: ConversationId, card: GuideCard }),
  async apply(tx, ctx, input) {
    if (ctx.actor.kind !== 'agent') throw forbidden('Only Whombat asks for a server this way.');
    const conversation = await loadConversationRow(tx, input.conversationId);
    if (!conversation) throw notFound('Conversation');
    const posted = await postMessage(ctx, { conversation, text: '', card: input.card, dispatch: false });
    return { messageId: posted.id };
  },
});

/**
 * A commit's result, or its refusal as an error: what Sign in once and `server_add` commit (a person's Vault key and
 * server, an agent's card) needs no key, so a held or blocked commit is a failure here (`routes/define`'s `ok` is the
 * REST handlers', which also answer 202/403).
 */
export function committed<R>(result: CommitResult<R>): R {
  if (result.status === 'ok') return result.result;
  throw new Error(result.message);
}

/**
 * Ignore, Remind me tomorrow, Stop watching and their Undo on a server's alert or rule (quiet-notices.md QN-17, QN-23;
 * QN-S54): the hosts service did it already (its acknowledgement, its watch settings), so this only signs it, without
 * text, and records it as an everyday change of the server: its Activity says who quieted what, Done recently doesn't.
 * Everyone who sees servers gets `home.changed`, so the dot, Watch and Needs you follow. A hint's are the quiet store's
 * own commands (`things/quiet/commands.ts`).
 */
export const recordServerQuiet = defineCommand({
  name: 'hosts.quiet',
  schema: z.object({
    serverId: z.string().min(1).max(200),
    serverName: z.string().min(1).max(120),
    kind: z.enum([
      'quiet.ignore',
      'quiet.snooze',
      'quiet.unignore',
      'quiet.unsnooze',
      'watch.on',
      'watch.off',
    ]),
    title: z.string().min(1).max(200),
    check: z.string().min(1).max(80),
    subject: z.string().max(160).optional(),
    /**
     * The assistant switched a rule because the person said so (on-purpose.md): recorded as its change for them, in
     * what it did with Undo.
     */
    agent: z
      .object({
        agentId: z.string().min(1).max(64),
        undo: z.object({
          thing: z.string().min(1).max(220),
          check: z.string().min(1).max(80),
          subject: z.object({ id: z.string().min(1).max(160), name: z.string().min(1).max(80) }).optional(),
          watched: z.boolean(),
        }),
      })
      .optional(),
  }),
  async apply(_tx, ctx, input) {
    if (ctx.actor.kind !== 'person') throw forbidden('Only people quiet what Whombat watches.');
    const thing = `server:${input.serverId}`;
    await ctx.emit({
      type: 'thing.quiet',
      kind: 'System',
      // An everyday change (SD-08): the server's own Activity says it, the burrow's log doesn't.
      text: null,
      where: null,
      payload: { thing, kind: input.kind, check: input.check, subject: input.subject ?? '' },
    });
    const changeId = await recordChange(ctx, {
      burrowId: ctx.burrow.id,
      actorId: ctx.actor.id,
      personId: ctx.actor.id,
      ...(input.agent
        ? {
            agentId: input.agent.agentId,
            kind: AGENT_WATCH_CHANGE_KIND,
            undo: { kind: AGENT_WATCH_CHANGE_KIND, payload: input.agent.undo, until: null },
          }
        : { kind: `${EVERYDAY_CHANGE_PREFIX}${input.kind}` }),
      title: input.title,
      subject: { kind: 'server', id: input.serverId, name: input.serverName },
      link: thingHref('server', input.serverId),
      at: ctx.now,
    });
    publishHomeChanged(ctx, await homeAudience(ctx, ctx.burrow.id), ['things', 'watch', 'needsYou']);
    return { changeId };
  },
});

export const HOSTS_COMMANDS = [recordHostsChange, askAddServer, setServerAsks, recordServerQuiet];
