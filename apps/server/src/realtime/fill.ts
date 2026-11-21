/**
 * What a frame's stored form leaves out and its delivery fills in (one-person.md OP-S69): a Vault event's detail
 * (docs/decisions/vault.md VT-52), a `connection_call` approval's connection and arguments preview, which is never
 * stored in the clear (connections-catalog.md CX-21), and a `schedule` card's schedule (resourceful-agents.md RA-30).
 * Every other frame goes as published.
 *
 * Which frames need it is decided by their type and card before anything is awaited (server-efficiency.md SV-10): most
 * frames — every plain message, typing, badges — need none.
 */
import type { Approval, RealtimeEvent } from '@whombat/core';
import { approvalConnectionDetails } from '../connections/approvals';
import type { Db } from '../db/client';
import { scheduleCardsFor } from '../schedules/store';
import { auditVaultDetails, isVaultEvent } from '../vault/detail';

/** A `connection_call` approval the frame carries (its own, or a message's approval card), else null. */
function connectionCall(event: RealtimeEvent): Approval | null {
  if (event.type === 'approval.updated')
    return event.approval.action.type === 'connection_call' ? event.approval : null;
  if (event.type !== 'message.created' && event.type !== 'message.updated') return null;
  const card = event.message.card;
  return card?.kind === 'approval' && card.approval.action.type === 'connection_call' ? card.approval : null;
}

async function withConnection(db: Db, event: RealtimeEvent, approval: Approval, viewerId: string) {
  const connection = (await approvalConnectionDetails(db, [approval], viewerId)).get(approval.id);
  if (!connection) return event;
  if (event.type === 'approval.updated') return { ...event, approval: { ...event.approval, connection } };
  if (event.type === 'message.created' || event.type === 'message.updated')
    return {
      ...event,
      message: {
        ...event.message,
        card: { kind: 'approval' as const, approval: { ...approval, connection } },
      },
    };
  return event;
}

/** The frame as it is delivered to `viewerId` (the person's device): filled in where it needs it, else as published. */
export async function fillFrame(db: Db, event: RealtimeEvent, viewerId: string): Promise<RealtimeEvent> {
  if (event.type === 'audit.appended') {
    if (!isVaultEvent(event.event)) return event;
    const vault = (await auditVaultDetails(db, [event.event])).get(event.event.id);
    return vault ? { ...event, event: { ...event.event, vault } } : event;
  }
  const approval = connectionCall(event);
  if (approval) return withConnection(db, event, approval, viewerId);
  if ((event.type === 'message.created' || event.type === 'message.updated') && event.message.card) {
    const card = event.message.card;
    if (card.kind !== 'schedule') return event;
    const schedule = (await scheduleCardsFor(db, [card.scheduleId])).get(card.scheduleId) ?? null;
    return { ...event, message: { ...event.message, card: { ...card, schedule } } };
  }
  return event;
}
