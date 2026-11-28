/**
 * Update on a server's or a service's page (app-updates.md): the person's tap asks through the same approval card as
 * the assistant's `app_update` (Yes, now · Yes, tonight · No) — never a second way to say yes. The server commits the
 * call as the person's assistant, for them, with `ask: true` so it asks on every server, and the reasons the card must
 * say; the card goes in their Chat and in the Inbox, and the page opens it. The yes runs the call as any yes does.
 */
import {
  APP_UPDATE_MAX,
  agentReportsApps,
  appUpdateState,
  type HostGuest,
  type HostManageResult,
} from '@whombat/core';
import { and, eq } from 'drizzle-orm';
import {
  callArgsAad,
  callConnectionTool,
  executeConnectionCall,
  newCallId,
  otherTargetsOf,
} from '../connections/call';
import { callTarget } from '../connections/call-target';
import { catalogConnections, connectionTools } from '../db/schema/index';
import { personalDmId } from '../domain/personal-dm';
import { tServer } from '../i18n/catalog';
import { burrowLocale } from '../i18n/locale';
import { ApiError } from '../lib/errors';
import { loadAgentRow } from '../read/principals';
import type { Services } from '../services';
import { addressIndex } from '../things/runs-on';
import { HOSTS_API, seg } from './client';
import { arr, obj, toHostGuest } from './map';
import { HOSTS_TEXT, hostsFor, WHOMBAT_ACTOR } from './service';
import { bindingOf, cardReasons, proxmoxGuestOf, withSharedImage } from './tools-apps';

/** Why the page's Update can't ask, in the person's words and `locale` (English when none); null when it can. */
export function appAskRefusal(
  guests: readonly HostGuest[],
  wanted: readonly string[],
  locale?: string | null,
): string | null {
  const hasApps = agentReportsApps(guests);
  for (const id of wanted) {
    const g = guests.find((x) => x.id === id);
    if (!g) return tServer(locale, 'hosts.apps.refuse.gone');
    const state = appUpdateState(g, hasApps);
    if (state === 'outdated') return tServer(locale, 'hosts.apps.refuse.outdated');
    if (state === 'none') return tServer(locale, 'hosts.apps.refuse.none');
    if (state === 'blocked') return tServer(locale, 'hosts.apps.refuse.blocked', { app: g.name });
    if (state === 'updating') return tServer(locale, 'hosts.apps.refuse.updating', { app: g.name });
  }
  return null;
}

/** Asks to update apps for the person; the approval's number, which the page opens. */
export async function askAppUpdate(
  services: Services,
  input: { burrowId: string; personId: string; serverId: string; apps: string[]; snapshot?: boolean },
): Promise<HostManageResult> {
  const { db } = services;
  const apps = [...new Set(input.apps)].slice(0, APP_UPDATE_MAX);
  // The person reads why it can't ask on the page, in their language.
  const locale = await burrowLocale(services, input.burrowId);
  const agent = await loadAgentRow(db, input.burrowId);
  if (!agent) throw new ApiError('conflict', tServer(locale, 'hosts.apps.refuse.noAssistant'));
  const [row] = await db
    .select()
    .from(catalogConnections)
    .where(
      and(
        eq(catalogConnections.burrowId, input.burrowId),
        eq(catalogConnections.catalogId, 'whombat_servers'),
      ),
    );
  if (row?.status !== 'active')
    throw new ApiError('unavailable', HOSTS_TEXT.down, { details: { code: 'hosts_unavailable' } });
  const [toolRow] = await db
    .select()
    .from(connectionTools)
    .where(and(eq(connectionTools.connectionId, row.id), eq(connectionTools.name, 'app_update')));
  if (!toolRow) throw new ApiError('conflict', tServer(locale, 'hosts.apps.refuse.off'));
  const page = await hostsFor(services).call<unknown>({
    path: `${HOSTS_API}/servers/${seg(input.serverId)}/guests`,
    query: { platform: 'docker', limit: 500 },
    actor: WHOMBAT_ACTOR,
  });
  const guests = arr(obj(page).guests).map((g) => toHostGuest(g, input.serverId));
  const refused = appAskRefusal(guests, apps, locale);
  if (refused) throw new ApiError('conflict', refused);
  // The card names, and the yes is bound to, the apps as they are now and those that share their image.
  const picked = withSharedImage(
    guests,
    guests.filter((g) => apps.includes(g.id)),
  );
  const reasons = cardReasons(picked);
  const expect = picked.flatMap((g) => bindingOf(g) ?? []);
  // A snapshot first is offered whenever the server is a Proxmox guest Whombat watches, unless the page said no.
  const snapshot =
    input.snapshot ??
    (await addressIndex(hostsFor(services))
      .then((index) => proxmoxGuestOf(index, input.serverId) !== null)
      .catch(() => false));
  const args = {
    server: input.serverId,
    apps: picked.map((g) => g.id),
    ask: true,
    ...(reasons.length ? { reasons } : {}),
    ...(snapshot ? { snapshot: true } : {}),
    ...(expect.length ? { expect } : {}),
  };
  const callId = newCallId();
  const argsEnc = services.custody.seal(callArgsAad(callId), JSON.stringify(args));
  const target = callTarget(row);
  const others = await otherTargetsOf(services, row, 'app_update', args);
  const conversationId = await personalDmId(db, agent.id, input.personId);
  const res = await services.pipeline.commit(
    callConnectionTool,
    {
      connectionId: row.id,
      handle: row.handle,
      tool: 'app_update',
      toolHash: toolRow.hash,
      callId,
      argsEnc,
      ...(conversationId ? { conversationId } : {}),
      target,
      others,
    },
    { burrowId: input.burrowId, actorId: agent.id, onBehalfOf: { principalId: input.personId } },
  );
  if (res.status === 'pending_approval') return { ok: true, approvalNumber: res.approvalNumber };
  if (res.status === 'blocked') throw new ApiError('forbidden', res.message);
  // Asked with `ask: true`, it always asks; should a setting let it run, it runs as the yes would have.
  if (!res.result.deferred)
    await executeConnectionCall(services, {
      burrowId: input.burrowId,
      agentId: agent.id,
      connectionId: row.id,
      tool: 'app_update',
      handle: row.handle,
      callId,
      args,
      where: null,
      conversationId: conversationId ?? null,
      threadRootId: null,
      personId: input.personId,
      target,
      others,
    });
  return { ok: true };
}
