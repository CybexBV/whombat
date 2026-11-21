/**
 * (h2) `push.resolve {ref} → {burrow, link}` (contracts 0.5.2 CT-49, MA-20, runtime MR-39): a notification tap.
 * The person registers a push handle with control and gives it to the appliance; an approval puts an item in their
 * inbox, and the appliance asks control (through the manager) to wake the handle — control records the delivery. The
 * item's ref resolves to its link. A well-formed ref of an item that doesn't exist answers `not_found`, identical to a
 * ref nobody issued.
 */
import { randomBytes } from 'node:crypto';
import { newId } from '@whombat/core/ids';
import { beforeAll, describe, expect, it } from 'vitest';
import { psql } from '../src/dev/postgres.ts';
import { CONTROL_DB } from '../src/dev/services.ts';
import { sleep } from '../src/lib/proc.ts';
import { type ApplianceSession, sessionOps } from '../src/scenario-kit/app-client.ts';
import { controlApi } from '../src/scenario-kit/cloud.ts';
import { note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { pushRefOf, refused } from '../src/scenario-kit/trust.ts';
import {
  api,
  collect,
  createApprovalAutomation,
  ensureWorkspace,
  eventType,
  type Workspace,
} from '../src/scenario-kit/work.ts';
import { env, type Persona, persona } from '../src/scenario-kit/world.ts';

let slice: SliceState;
let owner: ApplianceSession;
let p: Persona;

beforeAll(async () => {
  slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
  p = await persona(slice.owner.email.split('@')[0] ?? '', slice.owner.name);
});

interface InboxItem {
  id: string;
  kind: string;
  approvalId: string | null;
  link: Record<string, unknown>;
}

/** Runs an automation that asks for approval and returns the inbox item it put in `s`'s inbox. */
async function approvalItem(s: ApplianceSession, w: Workspace, marker: string): Promise<InboxItem> {
  const events = collect(s, [`burrow:${w.burrowId}`, `conv:${w.conversationId}`]);
  try {
    const automation = await createApprovalAutomation(s, w, marker);
    await api(s, 'automations.runNow', 'POST', {
      params: { burrow: w.slug, id: automation.id },
      body: { test: false },
    });
    await events.waitFor(
      (e) =>
        eventType(e) === 'approval.updated' &&
        (e.event as { approval?: { state?: string } }).approval?.state === 'pending',
      90_000,
      'approval requested',
    );
  } finally {
    events.close();
  }
  for (let i = 0; i < 20; i++) {
    const inbox = await api<{ sections: { kind: string; items: InboxItem[] }[] }>(
      s,
      'notifications.inbox',
      'GET',
      { params: { burrow: w.slug }, query: { filter: 'needs_you' } },
    );
    const item = inbox.sections.flatMap((x) => x.items).find((x) => x.kind === 'needs_you' && x.approvalId);
    if (item) return item;
    await sleep(500);
  }
  throw new Error(`no needs-you item in ${w.slug}'s inbox`);
}

describe('h2 push.resolve', () => {
  it('own item resolves to its link; the ref of a missing item and an unknown ref get the same not_found', async (ctx) => {
    const e = env();
    // The person's device registers a push handle (control) and hands it to the appliance.
    const token = `harness-${randomBytes(24).toString('hex')}`;
    const { handle } = await controlApi<{ handle: string }>(
      e.control?.url ?? '',
      'POST',
      '/v1/push/handles',
      {
        token: p.session.token,
        body: { platform: 'fcm', token, appId: 'com.whombat.harness' },
      },
    );
    await sessionOps.pushHandlesSet(owner, handle);

    const w = await ensureWorkspace(owner, `Push ${randomBytes(3).toString('hex')}`);
    const mine = await approvalItem(owner, w, `push-${randomBytes(3).toString('hex')}`);
    const ref = pushRefOf(mine.id);
    const resolved = (await sessionOps.pushResolve(owner, ref)) as { burrow: string; link: unknown };
    note(ctx, 'inbox item', { item: mine.id, link: mine.link, ref, resolved });
    expect(resolved.burrow).toBe(w.slug);
    expect(resolved.link).toEqual(mine.link);

    // The appliance woke the person's handle through the manager and control (content-free: kind + opaque ref).
    let deliveries: string[] = [];
    for (let i = 0; i < 40 && !deliveries.includes('sent'); i++) {
      const r = await psql(
        `select kind || ':' || result from push_deliveries where handle_id = '${handle.replace(/'/g, '')}'`,
        CONTROL_DB,
      );
      deliveries = r.stdout.split('\n').filter(Boolean);
      if (!deliveries.some((d) => d.endsWith(':sent'))) await sleep(500);
      else break;
    }
    note(ctx, 'control push deliveries for the handle', { handle, deliveries });
    expect(deliveries.some((d) => d.endsWith(':sent'))).toBe(true);

    // A ref the box would issue for an item it doesn't have, and one it never issued: the same answer.
    const missing = await refused(
      sessionOps.pushResolve(owner, pushRefOf(newId('notification'))),
      'a missing item’s ref',
    );
    const unknown = await refused(
      sessionOps.pushResolve(owner, randomBytes(32).toString('base64url')),
      'an unknown ref',
    );
    note(ctx, 'refusals', { missing, unknown });
    expect(missing.code).toBe('not_found');
    expect(missing).toEqual(unknown);
  });
});
