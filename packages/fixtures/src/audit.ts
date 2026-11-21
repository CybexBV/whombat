/**
 * The signed audit chain. Every row in `LOG` (`Whombat Desktop.dc.html`) becomes a real event, appended
 * oldest-first with `appendEvent()` so the chain (hash, sig, seq, prevHash) verifies with `verifyChain()`
 * — the mock's fake `fp()` hash is not used. Event ids are `evt_<suffix>`, matching the mock's `e-<suffix>`
 * refs (`formatEventRef`/`parseEventRef`). Told with one agent and one person: what the mock's agents did is Dusty's,
 * and what its people did is Mara's (she reviews PR #482). Conversation refs point at Chat (`{type: 'dm'}`) or the branch room (`{type: 'pr'}`).
 *
 * One event not in the mock is prepended: `burrow.created` (System), so every `AuditKind` has at least one
 * row. See `docs/decisions/fixtures.md`.
 *
 * A few rows are not in `LOG` at all: they fill Dusty's RECENT with older work (the churn notes, the service map, a
 * missing migration, the onboarding plan) — see `docs/decisions/seed-wiring.md` SW-04.
 */
import type { ChainHead, EventDraft } from '@whombat/core/audit';
import { appendEvent } from '@whombat/core/audit';
import { actionHash } from '@whombat/core/automations';
import type { AuditKind } from '@whombat/core/domain';
import { keyLabel } from '@whombat/core/keys';
import { BURROW_ID } from './burrow.js';
import { canvasOnboardingRevamp, canvasServiceMap } from './canvas.js';
import { dusty, mara, secretKeyOf } from './principals.js';
import { at } from './time.js';
import { approval } from './work.js';

interface Row {
  actorId: string;
  type: string;
  kind: AuditKind;
  text: string;
  where: string | null;
  createdAt: string;
  keyId?: string;
  keyNote?: string;
  onBehalfOf?: string;
  aboutId?: string;
  approvalId?: string;
  ref?: EventDraft['ref'];
  decided?: EventDraft['decided'];
  payload?: EventDraft['payload'];
}

function draft(id: string, row: Row): EventDraft {
  return {
    id,
    burrowId: BURROW_ID,
    actorId: row.actorId,
    type: row.type,
    kind: row.kind,
    text: row.text,
    where: row.where,
    ...(row.keyId ? { keyUsed: { id: row.keyId as never, label: keyLabel(row.keyId as never) } } : {}),
    ...(row.keyNote ? { keyNote: row.keyNote } : {}),
    ...(row.onBehalfOf ? { onBehalfOf: row.onBehalfOf } : {}),
    ...(row.aboutId ? { aboutId: row.aboutId } : {}),
    ...(row.approvalId ? { approvalId: row.approvalId as never } : {}),
    ...(row.ref ? { ref: row.ref } : {}),
    ...(row.decided ? { decided: row.decided } : {}),
    payload: row.payload ?? {},
    createdAt: row.createdAt,
  };
}

/** Oldest first — chain order. Mirrors `LOG` (newest first in the mock UI) plus one leading System row. */
const ROWS: [id: string, row: Row][] = [
  [
    'evt_burrow',
    {
      actorId: mara.id,
      type: 'burrow.created',
      kind: 'System',
      text: 'Created the burrow',
      where: null,
      createdAt: '2026-01-05T09:00:00.000Z',
    },
  ],
  [
    // New — not in `LOG`. Older research of Dusty's; the mock's literal "Tue" label is unreachable from
    // `SEED_NOW` (a Wednesday), so this lands on Monday instead. See `docs/decisions/seed-wiring.md` SW-04.
    'evt_churn-notes',
    {
      actorId: dusty.id,
      type: 'research.posted',
      kind: 'Messages',
      text: 'Collected churn interview notes',
      where: 'Chat',
      ref: { type: 'dm' },
      createdAt: at('11:00', -2),
    },
  ],
  [
    // New — not in `LOG`. Ties to the "Service map" canvas (`canvas.ts`). See `docs/decisions/seed-wiring.md` SW-04.
    'evt_svc-map',
    {
      actorId: dusty.id,
      type: 'canvas.updated',
      kind: 'Messages',
      text: 'Updated the service map',
      where: 'Canvases',
      ref: { type: 'canvas', slug: canvasServiceMap.slug },
      createdAt: at('14:00', -2),
    },
  ],
  [
    'evt_9cf4',
    {
      actorId: mara.id,
      type: 'keys.changed',
      kind: 'Keys',
      text: 'Moved Dusty’s “Deploy to production” key to ask first',
      where: 'Agent · Dusty',
      aboutId: dusty.id,
      ref: { type: 'agent' },
      createdAt: at('11:47', -1),
    },
  ],
  [
    'evt_9d0e',
    {
      actorId: dusty.id,
      type: 'pipeline.retried',
      kind: 'Code',
      text: 'Retried the staging pipeline',
      where: 'Run #1896',
      keyId: 'pipelines.retry',
      onBehalfOf: 'Pipeline failure alert',
      createdAt: at('15:02', -1),
    },
  ],
  [
    'evt_9d31',
    {
      actorId: dusty.id,
      type: 'action.blocked',
      kind: 'Blocked',
      text: 'Tried to merge PR #479 into main. Blocked.',
      where: 'whombat/billing · PR #479',
      keyId: 'merge.main',
      keyNote: 'not one of Dusty’s keys',
      onBehalfOf: 'Mara’s approval on PR #479',
      // No ref: PR #479 is not in the world, so a deep link would 404; the mock's row has no link either.
      createdAt: at('15:08', -1),
    },
  ],
  [
    // New — not in `LOG`. See `docs/decisions/seed-wiring.md` SW-04.
    'evt_migration-flag',
    {
      actorId: dusty.id,
      type: 'pr.flagged',
      kind: 'Code',
      text: 'Flagged a missing migration',
      where: 'whombat/billing',
      createdAt: at('16:00', -1),
    },
  ],
  [
    'evt_9d52',
    {
      actorId: mara.id,
      type: 'keys.granted',
      kind: 'Keys',
      text: 'Gave Dusty a new key: Run tests',
      where: 'Agent · Dusty',
      aboutId: dusty.id,
      ref: { type: 'agent' },
      createdAt: at('16:40', -1),
    },
  ],
  [
    'evt_9d77',
    {
      actorId: dusty.id,
      type: 'approval.requested',
      kind: 'Asks',
      text: 'Asked to refund €24,00 on account 3310',
      where: 'Help widget',
      keyId: 'refunds.issue',
      keyNote: 'asks a person first',
      onBehalfOf: 'Customer conversation #5521',
      decided: { byId: mara.id, at: at('17:20', -1), decision: 'approved' },
      createdAt: at('17:12', -1),
    },
  ],
  [
    // New — not in `LOG`. Ties to the "Onboarding revamp · plan" canvas (`canvas.ts`). See
    // `docs/decisions/seed-wiring.md` SW-04.
    'evt_onb-split',
    {
      actorId: dusty.id,
      type: 'canvas.created',
      kind: 'Messages',
      text: 'Split onboarding revamp into 9 tasks',
      where: 'Canvases',
      ref: { type: 'canvas', slug: canvasOnboardingRevamp.slug },
      createdAt: at('17:45', -1),
    },
  ],
  [
    'evt_9e20',
    {
      actorId: dusty.id,
      type: 'job.ran',
      kind: 'Code',
      text: 'Ran the nightly sync. 0 errors, 2 retries.',
      where: 'Run #1901',
      keyId: 'jobs.scheduled.run',
      onBehalfOf: 'Schedule · every day at 06:00',
      // No ref: Run #1901 is not in the world.
      createdAt: at('06:00'),
    },
  ],
  [
    // New — not in `LOG`: Mara's approval that `evt_9d31` acted on. See `docs/decisions/seed-wiring.md` SW-04.
    'evt_pr479-approved',
    {
      actorId: mara.id,
      type: 'pr.approved',
      kind: 'Code',
      text: 'Approved PR #479',
      where: 'whombat/billing · PR #479',
      ref: { type: 'pr', number: 479 },
      createdAt: at('09:02'),
    },
  ],
  [
    'evt_9e3b',
    {
      actorId: dusty.id,
      type: 'tickets.tagged',
      kind: 'Messages',
      text: 'Tagged 41 tickets with invoice-copy',
      where: 'Help widget',
      keyId: 'tickets.tag',
      onBehalfOf: 'Mara in Chat',
      createdAt: at('09:05'),
    },
  ],
  [
    'evt_9e51',
    {
      actorId: dusty.id,
      type: 'canvas.created',
      kind: 'Messages',
      text: 'Wrote the canvas “Invoice PDF export · plan”',
      where: 'Chat',
      keyId: 'canvas.write',
      onBehalfOf: 'Mara in Chat',
      ref: { type: 'canvas', slug: 'invoice-pdf-export-plan' },
      createdAt: at('09:13'),
    },
  ],
  [
    // New — not in `LOG`. Ties to Dusty's research card in Mara's Chat (`messages.ts#msg_dm_dusty_dusty_0941`).
    // See `docs/decisions/seed-wiring.md` SW-04.
    'evt_pdf-research',
    {
      actorId: dusty.id,
      type: 'research.posted',
      kind: 'Messages',
      text: 'Compared 3 PDF libraries, 14 sources',
      where: 'Chat',
      onBehalfOf: 'Mara in Chat',
      ref: { type: 'dm' },
      createdAt: at('09:41'),
    },
  ],
  [
    'evt_9ea0',
    {
      actorId: mara.id,
      type: 'message.posted',
      kind: 'Messages',
      text: 'Reported that customer 8812’s invoice is €0,01 off',
      where: 'Chat',
      ref: { type: 'dm' },
      createdAt: at('10:40'),
    },
  ],
  [
    'evt_9ea4',
    {
      actorId: dusty.id,
      type: 'answer.posted',
      kind: 'Messages',
      text: 'Answered Mara with 3 receipts',
      where: 'Chat',
      keyId: 'messages.search',
      onBehalfOf: 'Mara in Chat',
      ref: { type: 'dm' },
      createdAt: at('10:41'),
    },
  ],
  [
    'evt_9ec1',
    {
      actorId: dusty.id,
      type: 'pr.opened',
      kind: 'Code',
      text: 'Opened PR #482 · invoice PDF export',
      where: 'whombat/billing',
      keyId: 'pr.open',
      onBehalfOf: 'Invoice PDF export plan, step 2',
      ref: { type: 'pr', number: 482 },
      createdAt: at('10:48'),
    },
  ],
  [
    'evt_9ee7',
    {
      actorId: mara.id,
      type: 'pr.changes_requested',
      kind: 'Code',
      text: 'Requested 2 changes on PR #482',
      where: 'whombat/billing · PR #482',
      ref: { type: 'pr', number: 482 },
      createdAt: at('11:20'),
    },
  ],
  [
    'evt_9f02',
    {
      actorId: dusty.id,
      type: 'run.started',
      kind: 'Code',
      text: 'Started a run to address the review on PR #482',
      where: 'Run #1907',
      keyId: 'branch.feature.readwrite',
      onBehalfOf: 'Mara’s review on PR #482',
      ref: { type: 'run', number: 1907 },
      createdAt: at('11:24'),
    },
  ],
  [
    // Timestamp pinned to the approval's own `createdAt` / `eventId` (world.ts), not the mock's literal
    // "11:30" — see docs/decisions/fixtures.md.
    'evt_9f18',
    {
      actorId: dusty.id,
      type: 'approval.requested',
      kind: 'Asks',
      text: 'Asked to deploy feat/invoice-pdf to staging',
      where: 'feat/invoice-pdf',
      keyId: 'deploy.staging',
      keyNote: 'asks a person first',
      onBehalfOf: 'Invoice PDF export plan, step 4',
      approvalId: 'apr_staging-482',
      ref: { type: 'approval', number: 12 },
      // The hash the approval's execution is checked against, signed with the request (as every request carries it).
      payload: { actionHash: actionHash({ action: approval.action, input: null }) },
      createdAt: at('11:25'),
    },
  ],
  [
    'evt_9f2c',
    {
      actorId: dusty.id,
      type: 'run.tests',
      kind: 'Code',
      text: 'Ran the billing test suite. 41 of 41 passed.',
      where: 'Run #1907',
      keyId: 'tests.run',
      onBehalfOf: 'Mara’s review on PR #482',
      ref: { type: 'run', number: 1907 },
      createdAt: at('11:35'),
    },
  ],
  [
    'evt_9f31',
    {
      actorId: dusty.id,
      type: 'branch.pushed',
      kind: 'Code',
      text: 'Pushed 7be20f to feat/invoice-pdf',
      where: 'whombat/billing · PR #482',
      keyId: 'branch.feature.readwrite',
      onBehalfOf: 'Mara’s review on PR #482',
      ref: { type: 'pr', number: 482 },
      createdAt: at('11:36'),
    },
  ],
];

export const AUDIT_CHAIN = (() => {
  let head: ChainHead | null = null;
  const events = [];
  for (const [id, row] of ROWS) {
    const signed = appendEvent(head, draft(id, row), secretKeyOf(row.actorId));
    events.push(signed);
    head = { seq: signed.seq, hash: signed.hash };
  }
  return events;
})();

/**
 * Pre-signing draft form of every row, oldest first — what `seed.ts#seedWorld()` maps onto
 * `SeedWorld.events` (the loader signs each one itself with the actor's *seeded* key via `session.append()`,
 * so the already-signed `AUDIT_CHAIN` entries, with their `hash`/`sig`/`signer`/`seq`/`prevHash`, are not
 * reused directly). `seedWorld()` slices this up to and including `evt_9f18`: `evt_9f2c` and `evt_9f31`
 * postdate the seeded "now" and exist only for `createFixtureFetch()`'s post-decision simulation. See
 * `docs/decisions/seed-wiring.md` SW-02.
 */
export const AUDIT_DRAFTS: EventDraft[] = ROWS.map(([id, row]) => draft(id, row));
