/**
 * “Asks you first” in the one-Whombat demo world (server-asks-mobile.md AP-1746): every server starts at Before risky
 * actions; `hosts.updateServer {asksFirst}` changes it, `hosts.serverSettings` reads it, and the fleet and the server's
 * page carry it. In the “Clean up Docker on thetitan” chat Neo asks to run a command on thetitan (approval #32, a
 * Servers call with `params.server`), so the approval screen offers “Don’t ask again on thetitan”; that yes sets
 * thetitan to Never, as the server's commit does (SA-07). The name a person gives a server is Whombat's too:
 * `hosts.updateServer {name}` keeps it (null puts the id back) and the fleet, the page, the settings and Home say it.
 */
import {
  type Approval,
  type ApprovalAction,
  actionCopy,
  type HostAsksFirst,
  HostServerGivenName,
  type HostServerSettings,
  type HostServerSettingsPatch,
} from '@whombat/core';
import { AGENT, at, deployApproval, mara } from '@whombat/fixtures';

export const SERVER_ASKS_APPROVAL = 32;
/** What the server says when a name is someone else's. */
export const SERVER_NAME_TAKEN = 'Another server already goes by that name.';
export const DOCKER_CHAT_ID = 'cnv_chat-thetitan-docker';

const ACTION: Extract<ApprovalAction, { type: 'connection_call' }> = {
  type: 'connection_call',
  params: {
    connectionId: 'con_whombat_servers',
    handle: 'servers',
    tool: 'server_command',
    toolHash: '5e1c0a7d2b9f4e8a6c3d1f0b7a9e2c4d6f8b0a1c3e5d7f9b2a4c6e8d0f1a3b5c',
    words: 'run “docker image prune -a” on thetitan',
    server: { id: 'thetitan', name: 'thetitan' },
  },
};

/** Neo asks to run a command on thetitan: a Servers call that asks only for its sensitive rules. */
export function serverAsksApproval(
  overrides: Partial<Approval> = {},
  requesterId: string = AGENT.id,
): Approval {
  const base = deployApproval();
  const copy = actionCopy(ACTION);
  return deployApproval({
    id: 'apr_thetitan-prune',
    number: SERVER_ASKS_APPROVAL,
    requesterId,
    keyId: 'connections.write',
    action: ACTION,
    connection: { label: 'Servers', catalogId: 'whombat_servers', argumentsPreview: 'docker image prune -a' },
    title: copy.title,
    question: copy.question,
    target: copy.target,
    whatHappens: [],
    explainer: 'Running a command on a server asks a person first.',
    summary: copy.runs,
    conditions: base.conditions.filter((c) => c.kind === 'person_approves'),
    conversationId: DOCKER_CHAT_ID,
    messageId: null,
    involvedIds: [],
    eventId: null,
    createdAt: at('14:02'),
    ...overrides,
  });
}

/** The world's setting per server and the pending approval. */
export function createServerAsksFixtures(options: { now: () => Date; requesterId: string }) {
  const asks = new Map<string, HostAsksFirst>();
  const names = new Map<string, string>();
  let approval = serverAsksApproval({}, options.requesterId);

  return {
    /** A server's setting; Before risky actions without one (SA-04). */
    of(serverId: string): HostAsksFirst {
      return asks.get(serverId) ?? 'risky';
    },
    /** The name a person gave the server, or undefined while it goes by its id. */
    nameOf(serverId: string): string | undefined {
      return names.get(serverId);
    },
    /**
     * `hosts.updateServer`'s `asksFirst` and `name` (the rest of the body is the hosts service's): why the name can't
     * be used, or null when the patch is kept. `ids` are the world's servers, whose ids and names are taken.
     */
    patch(serverId: string, body: HostServerSettingsPatch, ids: readonly string[]): string | null {
      if ('name' in body && body.name !== undefined) {
        const parsed = body.name === null ? null : HostServerGivenName.safeParse(body.name);
        if (parsed && !parsed.success) return parsed.error.issues[0]?.message ?? 'Give it a name.';
        const name = parsed?.data ?? null;
        const same = (a: string | undefined) => !!a && !!name && a.toLowerCase() === name.toLowerCase();
        if (ids.some((id) => id !== serverId && (same(id) || same(names.get(id))))) return SERVER_NAME_TAKEN;
        if (name && name !== serverId) names.set(serverId, name);
        else names.delete(serverId);
      }
      if (body.asksFirst) asks.set(serverId, body.asksFirst);
      return null;
    },
    /** `hosts.serverSettings` for a server of the world. */
    settings(serverId: string, group: string): HostServerSettings {
      const on = {
        console: true,
        power: true,
        hostShell: true,
        hostPower: true,
        manage: true,
        diagnose: true,
      };
      return {
        id: serverId,
        name: names.get(serverId) ?? null,
        group,
        location: null,
        remoteControl: on,
        agentPolicy: on,
        asksFirst: asks.get(serverId) ?? 'risky',
      };
    },
    approval(): Approval {
      return approval;
    },
    /** A yes or a no; a yes with scope `agent` also stops asking on the server (SA-07). */
    decide(decision: 'approve' | 'decline', scope: string | undefined): Approval {
      if (approval.state !== 'pending') return approval;
      const decidedAt = options.now().toISOString();
      const yes = decision === 'approve';
      if (yes && scope === 'agent' && ACTION.params.server) asks.set(ACTION.params.server.id, 'never');
      // The command runs at once (Whombat has nothing else to wait for) and the card says how it went.
      approval = {
        ...approval,
        state: yes ? 'approved' : 'declined',
        ...(yes && scope === 'agent' ? { scope: 'agent' as const } : {}),
        decidedById: mara.id,
        decidedAt,
        executedAt: yes ? decidedAt : null,
        ...(yes
          ? {
              execution: {
                state: 'succeeded' as const,
                startedAt: decidedAt,
                finishedAt: decidedAt,
                durationMs: 1800,
                resultUrl: null,
                error: null,
              },
            }
          : {}),
        conditions: approval.conditions.map((c) => (c.kind === 'person_approves' ? { ...c, met: yes } : c)),
      };
      return approval;
    },
  };
}
