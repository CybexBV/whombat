/**
 * Test kit for Whombat Feedback (docs/decisions/feedback.md): integrations of the seeded burrow, submissions filed as an
 * opened drop files them (`fileReport`), and hostile images (a bomb header, a truncated PNG, a JPEG carrying EXIF, SVG,
 * GIF, HTML).
 */
import { randomBytes } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import {
  type AutomationDefinitionInput,
  type DispatchContext,
  definitionHash,
  type FeedbackAssessmentSubmissionInput,
  type FeedbackIntegration,
  type FeedbackIntegrationSettingsInput,
  type FeedbackPublicErrorCode,
  type FeedbackSubmissionInput,
  runnerApi,
  validateDefinition,
} from '@whombat/core';
import { feedbackReferenceFor } from '@whombat/core/feedback/drop';
import { eq } from 'drizzle-orm';
import jpeg from 'jpeg-js';
import { createAutomation, publishAutomationDraft } from '../automations/commands';
import { loadAutomationRow } from '../automations/store';
import { feedbackIntegrations, feedbackReports } from '../db/schema/index';
import { FeedbackPublicFailure, unavailable } from '../feedback/errors';
import { fileSubmission, type VerifiedReporter } from '../feedback/file';
import { createFeedbackIntegration, type IntegrationRow } from '../feedback/integrations';
import { checkSubmission, parentAllowed } from '../feedback/submission';
import { IDS } from '../seed/test-world';
import type { TestServer } from './harness';

export { IDS };

export const SITE_ORIGIN = 'https://app.lumio.example';

export function integrationSettings(
  over: Partial<FeedbackIntegrationSettingsInput> = {},
): FeedbackIntegrationSettingsInput {
  return {
    name: 'Lumio website',
    productLabel: 'Lumio',
    allowedOrigins: [SITE_ORIGIN],
    repoId: 'rep_billing',
    projectContext: 'Lumio is the billing portal.',
    reportTypes: ['bug', 'feature'],
    contextKeys: ['plan'],
    redactPaths: ['/customers/*'],
    limits: { reportsPerHour: 1000, reportsPerDay: 10_000, perSourcePerHour: 100 },
    ...over,
  };
}

export async function createIntegration(
  t: TestServer,
  over: Partial<FeedbackIntegrationSettingsInput> = {},
  by: string = IDS.mara,
): Promise<FeedbackIntegration> {
  const res = await t.commit(by, createFeedbackIntegration, integrationSettings(over));
  if (res.status !== 'ok') throw new Error(`create integration: ${res.status}`);
  return res.result;
}

export function newSubmissionId(): string {
  return randomBytes(16).toString('base64url');
}

export function submission(over: Partial<FeedbackSubmissionInput> = {}): FeedbackSubmissionInput {
  return {
    submissionId: newSubmissionId(),
    parentOrigin: SITE_ORIGIN,
    type: 'bug',
    description: 'The invoice total is off by a cent.',
    expected: 'The total matches the lines.',
    steps: '1. Open an invoice\n2. Compare',
    reporter: { name: 'Ada Visitor', email: 'ada@example.com' },
    context: {
      page: { url: `${SITE_ORIGIN}/customers/acme/invoices?token=secret#frag`, title: 'Invoices' },
      browser: { name: 'Chrome 131 · macOS', language: 'en', viewport: { width: 1440, height: 900 } },
      app: { version: '1.4.2', environment: 'production' },
      custom: { plan: 'pro', secret: 'drop-me' },
      references: ['req_123'],
    },
    attachments: [],
    ...over,
  };
}

/** What filing a submission came to, as a drop's outcome says it (`drop/receive.ts`). */
export type Filing =
  | { outcome: 'filed' | 'duplicate'; reference: string; receivedAt: string }
  | { outcome: 'refused'; code: FeedbackPublicErrorCode; fields?: string[]; retryAfter?: number };

/**
 * Files `body` for the site `siteId` as an opened drop is filed (feedback-drop.md FD-23, `drop/receive.ts`): the site's
 * integration (not a connected system's), the submission checked, its parent and type allowed, then the one filing path
 * (`fileSubmission`) under the reference the frame showed. `reporter`: control's attested reporter (FR-09).
 */
export async function fileReport(
  t: Pick<TestServer, 'services'>,
  siteId: string,
  body: unknown,
  reporter: VerifiedReporter | null = null,
): Promise<Filing> {
  const [row] = await t.services.db
    .select()
    .from(feedbackIntegrations)
    .where(eq(feedbackIntegrations.siteId, siteId));
  try {
    if (!row) throw unavailable();
    const submission = checkSubmission(body);
    if (!parentAllowed(row as IntegrationRow, submission.parentOrigin)) throw unavailable();
    if (!row.settings.reportTypes.includes(submission.type))
      throw new FeedbackPublicFailure('invalid', { fields: ['type'] });
    const filed = await fileSubmission(
      t.services,
      row as IntegrationRow,
      submission,
      {
        via: 'drop',
        dropId: `fdr_test-${randomBytes(9).toString('base64url')}`,
        reference: feedbackReferenceFor(siteId, submission.submissionId),
      },
      reporter,
    );
    return {
      outcome: filed.created ? 'filed' : 'duplicate',
      reference: filed.reference,
      receivedAt: filed.receivedAt,
    };
  } catch (err) {
    if (err instanceof FeedbackPublicFailure) return { outcome: 'refused', code: err.code, ...err.extra };
    throw err;
  }
}

/** Files a submission that must be filed (`fileReport`) and returns what it came to. */
export async function filed(
  t: Pick<TestServer, 'services'>,
  siteId: string,
  body: unknown,
  reporter: VerifiedReporter | null = null,
): Promise<{ reference: string; receivedAt: string; created: boolean }> {
  const res = await fileReport(t, siteId, body, reporter);
  if (res.outcome === 'refused') throw new Error(`file: refused ${res.code}`);
  return { reference: res.reference, receivedAt: res.receivedAt, created: res.outcome === 'filed' };
}

export function attachmentOf(bytes: Buffer, contentType: 'image/png' | 'image/jpeg', name = 'shot.png') {
  return { name, contentType, data: bytes.toString('base64') };
}

// --- Images -------------------------------------------------------------------------------------------------

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** An interlaced (Adam7) RGB PNG whose image data is `raw`, deflated. */
export function interlacedPng(width: number, height: number, raw: Buffer): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[12] = 1;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG whose IHDR claims `width × height` (a decompression bomb header over a 1×1 image's data). */
export function pngClaiming(png: Buffer, width: number, height: number): Buffer {
  const ihdr = Buffer.from(png.subarray(16, 29));
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([png.subarray(0, 8), pngChunk('IHDR', ihdr), png.subarray(33)]);
}

/** A PNG with a text chunk (metadata that must not survive) and trailing bytes after IEND. */
export function pngWithMetadata(png: Buffer, text: string): Buffer {
  const iend = png.length - 12;
  return Buffer.concat([
    png.subarray(0, iend),
    pngChunk('tEXt', Buffer.from(`Comment\0${text}`, 'latin1')),
    png.subarray(iend),
    Buffer.from(`<script>${text}</script>`),
  ]);
}

/** A real JPEG; with `exif`, an APP1 EXIF segment carrying `marker` right after SOI. */
export function makeJpeg(width: number, height: number, exif?: string): Buffer {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([30, 140, 200, 255], i * 4);
  const encoded = Buffer.from(jpeg.encode({ width, height, data }, 85).data);
  if (!exif) return encoded;
  const payload = Buffer.concat([
    Buffer.from('Exif\0\0MM\0*\0\0\0\x08', 'latin1'),
    Buffer.from(exif, 'latin1'),
  ]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([encoded.subarray(0, 2), header, payload, encoded.subarray(2)]);
}

/** A JPEG whose SOF header claims `width × height` (the pixels are a small image's). */
export function jpegClaiming(jpg: Buffer, width: number, height: number): Buffer {
  const out = Buffer.from(jpg);
  for (let i = 2; i + 9 < out.length; i++) {
    if (out[i] === 0xff && out[i + 1] === 0xc0) {
      out.writeUInt16BE(height, i + 5);
      out.writeUInt16BE(width, i + 7);
      return out;
    }
  }
  throw new Error('no SOF0 marker');
}

export const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
export const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>',
);
export const HTML = Buffer.from(
  '<!doctype html><html><body><script>alert(document.cookie)</script></body></html>',
);

// --- Automations ----------------------------------------------------------------------------------------------

/** Imports and publishes an automation as `by` (Mara by default). */
export async function publishAutomation(
  t: TestServer,
  definition: Omit<AutomationDefinitionInput, 'version'>,
  by: string = IDS.mara,
): Promise<string> {
  const ok = async <R>(p: Promise<{ status: string; result?: R }>) => {
    const res = await p;
    if (res.status !== 'ok') throw new Error(`automation: ${res.status}`);
    return res.result as R;
  };
  const { automationId } = await ok(
    t.commit(by, createAutomation, {
      name: 'Listens to #billing-v2',
      source: {
        kind: 'import',
        file: {
          whombat: 'automation',
          name: 'Listens to #billing-v2',
          description: '',
          definition: JSON.parse(JSON.stringify({ version: 1, ...definition })),
        },
      },
    }),
  );
  const row = await loadAutomationRow(t.services.db, t.burrowId, automationId);
  const check = validateDefinition(row.draftJson);
  if (!check.ok) throw new Error(check.problems.join(' '));
  await ok(
    t.commit(by, publishAutomationDraft, {
      automationId,
      enable: true,
      definitionHash: definitionHash(check.definition),
    }),
  );
  return automationId;
}

// --- Assessment (docs/decisions/feedback.md FB-20 … FB-24) -------------------------------------------------------

/** A valid assessment as an agent would submit it (`submit_assessment`). */
export function assessmentInput(
  over: Partial<FeedbackAssessmentSubmissionInput> = {},
): FeedbackAssessmentSubmissionInput {
  return {
    outcome: 'likely_bug',
    summary: 'Invoice totals round each line before summing, so the total can be a cent off.',
    confidence: 'medium',
    uncertainty: 'I read the code but ran nothing.',
    reproduction: { status: 'not_attempted', notes: '' },
    evidence: [{ kind: 'file', ref: 'src/billing/invoice.ts:88', note: 'rounds per line', hypothesis: true }],
    revision: { inspected: 'main', reported: '1.4.2', mismatch: null },
    severity: { level: 'medium', rationale: 'Totals are visible to customers.' },
    missingInformation: [],
    nextAction: 'Sum unrounded amounts, round once.',
    duplicateOf: null,
    feature: null,
    reply: 'This looks like a rounding bug, but I only read the code, so I can’t say for sure yet.',
    bugVerdict: 'unsure',
    decision: null,
    ...over,
  };
}

/** The report a receipt names. */
export async function reportByReference(t: Pick<TestServer, 'services'>, reference: string) {
  const [row] = await t.services.db
    .select()
    .from(feedbackReports)
    .where(eq(feedbackReports.reference, reference));
  if (!row) throw new Error(`no report ${reference}`);
  return row;
}

/** Files a new report (`fileReport`) and returns its row. */
export async function submitReport(
  t: Pick<TestServer, 'services'>,
  siteId: string,
  over: Partial<FeedbackSubmissionInput> = {},
) {
  const res = await fileReport(t, siteId, submission(over));
  if (res.outcome !== 'filed') throw new Error(`file: ${JSON.stringify(res)}`);
  return reportByReference(t, res.reference);
}

/** The runner protocol as a test drives it (runner token of the dev setup). */
export function runnerProtocol(t: TestServer, runnerId = 'rnr_feedback-test') {
  const headers = { authorization: 'Bearer dev-runner-token' };
  const post = (url: string, payload: object) =>
    t.api.inject({ method: 'POST', url: `/internal/runner${url}`, headers, payload });
  return {
    async claim(): Promise<DispatchContext | null> {
      const res = await post('/claim', { runnerId, providers: ['claude'], waitMs: 0 });
      if (res.statusCode !== 200) throw new Error(`claim: ${res.statusCode} ${res.body}`);
      return runnerApi.claim.response.parse(res.json()).dispatch;
    },
    async progress(ctx: DispatchContext, extra: Record<string, unknown> = {}) {
      const res = await post(`/dispatches/${ctx.dispatch.id}/progress`, {
        state: 'running',
        runnerId,
        attempt: ctx.dispatch.attempts,
        ...extra,
      });
      if (res.statusCode !== 200) throw new Error(`progress: ${res.statusCode} ${res.body}`);
      return res.json();
    },
    async complete(ctx: DispatchContext, body: Record<string, unknown>) {
      const res = await post(`/dispatches/${ctx.dispatch.id}/complete`, {
        runnerId,
        attempt: ctx.dispatch.attempts,
        ...body,
      });
      return res.statusCode;
    },
  };
}
