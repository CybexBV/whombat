/**
 * A report tracker's driver (docs/decisions/report-trackers.md): the code that teaches this Whombat one tracker's API.
 * The workflow — mirroring new items, the customer's answers, writing an assessment back, replying, feature-request
 * cards, following a fix until it is live — is Whombat's own (`trackers/`); a driver only reads and writes its tracker.
 *
 * A driver is owner-trusted code: the person who runs the box puts it there (`$WHOMBAT_HOME/plugins/<id>/plugin.mjs`),
 * never an agent and never the apps, and it runs inside the server with the server's own rights (no sandbox). The
 * server imports it at start, checks what it answers with the schemas below, gives every call a time limit and tells a
 * driver that keeps failing on its connections' “Whether it answers” check.
 *
 * Version 1 of the interface (`api: 1`). A driver module's default export is a `TrackerDriver`, or a function that
 * returns one. Everything a driver answers is data from outside: checked here, never trusted further than that.
 */
import { z } from 'zod';

/** The interface version this Whombat speaks. A driver declares the one it was written for. */
export const TRACKER_DRIVER_API = 1 as const;

/* What a driver tells about itself ---------------------------------------------------------------------------- */

/** The words a tracker's items and people are called by (filled into the generic workflow's sentences). */
export const TrackerWords = z.object({
  /** The tracker's name as customers know it (“Acme Desk”). */
  product: z.string().trim().min(1).max(40),
  /** Who answers customers there, as the tracker shows Whombat's replies (“Acme Desk team”). */
  team: z.string().trim().min(1).max(60),
});
export type TrackerWords = z.infer<typeof TrackerWords>;

/**
 * The driver's own lines for the agent's prompts, plain sentences that name the tracker (each optional: the generic
 * words stand without them). Kept on the automation's recipe when it is made, so its definition stays what it was.
 */
export const TrackerGuidance = z.object({
  /** Who sent the item and through what, before it is quoted (“A signed-in Acme customer sent the report below …”). */
  source: z.string().trim().max(400).optional(),
  /** What `tracker_read` reaches with the organization's access (“its devices, deployments and audit”). */
  access: z.string().trim().max(200).optional(),
  /** What a feature request is measured against (“how it fits Acme”). */
  fits: z.string().trim().max(120).optional(),
});
export type TrackerGuidance = z.infer<typeof TrackerGuidance>;

/** What a driver is: its id (the plugin's folder name), version, the interface version and its data. */
export const TrackerDriverInfo = z.object({
  api: z.literal(TRACKER_DRIVER_API),
  id: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  version: z.string().min(1).max(40),
  words: TrackerWords,
  guidance: TrackerGuidance.default({}),
  /**
   * Paths of a repository whose changes reach customers with a release of their own, not with a deploy Whombat can see
   * (a device agent): a fix touching one is told at its merge and followed no further.
   */
  releasedSeparately: z.array(z.string().min(1).max(200)).max(20).default([]),
  /**
   * Paths of a repository whose changes reach no customer at all (the repository's own checks and their budgets): a fix
   * that changes them besides `releasedSeparately` still changes only what is released separately, as for docs.
   */
  reachesNoCustomer: z.array(z.string().min(1).max(200)).max(20).default([]),
  /**
   * How a customer gets the separately released part right away, by notice language (`en`, `nl`): one sentence said
   * after the notice that a fix to it is ready for them (“Press ‘Update now’ on your Nest to get it right away; …”).
   */
  separateNow: z
    .object({ en: z.string().trim().min(1).max(300), nl: z.string().trim().min(1).max(300) })
    .partial()
    .default({}),
  /**
   * A literal every pull request line `prLine` writes starts with, for finding people's own merged fixes in the mirror
   * (an SQL `like` prefilter; `prMatch` then reads them). Absent: only Whombat's own marker is followed.
   */
  prPrefix: z.string().min(4).max(60).optional(),
});
export type TrackerDriverInfo = z.infer<typeof TrackerDriverInfo>;

/* What a driver reads ------------------------------------------------------------------------------------------ */

/**
 * A tracker item as Whombat understands it, in the tracker vocabulary of `@whombat/core` (`TRACKER_STATUS_LABELS`: new,
 * investigating, needs_information, planned, in_progress, awaiting_release, available, confirmed, closed, not_planned,
 * duplicate; assessments likely_bug, reproduced, needs_information, duplicate, feature_request; priorities urgent,
 * high, normal, low): a driver maps its tracker's own values onto these. A value outside them is kept as the tracker
 * said it and shown in its own words.
 */
export const TrackerItem = z.object({
  /** The tracker's id of the item (any string, at most 100). */
  id: z.string().min(1).max(100),
  /** The number people say (“#15”): one sequence per tracker installation. */
  number: z.number().int().positive(),
  kind: z.enum(['bug', 'feature']),
  title: z.string().max(300).nullable(),
  description: z.string().max(100_000).default(''),
  expected: z.string().max(100_000).default(''),
  organization: z.object({ id: z.string().max(200).nullable(), name: z.string().max(200).nullable() }),
  /** Where the customer was when they filed it: `production`, `development`, or not known. */
  environment: z.enum(['production', 'development']).nullable(),
  /** The tracker's product version they used, when it said. */
  version: z.string().max(64).nullable(),
  page: z.string().max(160).nullable(),
  browser: z.string().max(120).nullable(),
  status: z.string().min(1).max(40),
  priority: z.string().max(40).nullable(),
  assessment: z.string().max(40).nullable(),
  /** The tracker's id of the original this one repeats, when it is linked as a duplicate. */
  duplicateOf: z.string().max(100).nullable(),
  createdAt: z.string().max(40),
  updatedAt: z.string().max(40),
  /** The conversation, oldest first: the reporter's messages and the team's (Whombat's replies arrive as the team). */
  messages: z
    .array(
      z.object({
        /** The tracker's id of the message: Whombat sends its request id as one, to know what it sent already. */
        id: z.string().max(200).nullable(),
        author: z.enum(['reporter', 'team']),
        body: z.string().max(100_000),
        at: z.string().max(40).nullable(),
      }),
    )
    .max(1000),
  hasScreenshot: z.boolean(),
  /** It came with something beyond its text: recent actions, device diagnostics, linked packages. */
  hasDiagnostics: z.boolean(),
  /** The release the tracker recorded for its fix, when there is one. */
  release: z
    .object({ component: z.string().max(100), version: z.string().max(100), evidence: z.string().max(2000) })
    .nullable(),
});
export type TrackerItem = z.infer<typeof TrackerItem>;

/** An item read on its own (`item`): what people and the agent read beyond the poll's view. */
export const TrackerItemFull = TrackerItem.extend({
  /** For people only (never an agent): who filed it. */
  reporter: z.object({ name: z.string().max(200).nullable(), email: z.string().max(320).nullable() }),
  /** A data URL of its screenshot, for people only; null without one. */
  screenshot: z
    .string()
    .max(4 * 1024 * 1024)
    .nullable(),
  /**
   * What came with it beyond its text, for the agent, in the tracker's own terms (recent actions and requests, audit,
   * device diagnostics, linked packages), at most 6 000 characters; '' when nothing did.
   */
  evidence: z.string().max(16_000).default(''),
});
export type TrackerItemFull = z.infer<typeof TrackerItemFull>;

/** What a poll read: the items it understood, the entries it couldn't, and whether it could reach `after`. */
export const TrackerPoll = z.object({
  items: z.array(TrackerItem).max(10_000),
  /** Entries listed that didn't parse: their number and id where they had one. */
  unreadable: z
    .array(z.object({ id: z.string().max(100).nullable(), number: z.number().int().nullable() }))
    .max(10_000),
  /**
   * The newest items past `after` are more than a poll reads at once: nothing past `after` may be taken as handled.
   * Never set for a first read (`after` null).
   */
  backlog: z.boolean(),
});
export type TrackerPoll = z.infer<typeof TrackerPoll>;

/** What an installation runs (its health): which one it is, its version, and the clean source revision it runs. */
export const TrackerHealth = z.object({
  environment: z.enum(['production', 'development']).nullable(),
  version: z.string().max(100).nullable(),
  /** A clean, full git revision (40 hex) of what it runs; null when it doesn't say or the build wasn't clean. */
  revision: z
    .string()
    .regex(/^[0-9a-f]{40}$/)
    .nullable(),
  /**
   * What the installation offers customers now of the part released on its own (`info.releasedSeparately`): its
   * version and the clean, full git revision (40 hex) it was built from. Null (or absent) when the tracker doesn't say:
   * then a fix that changes only that part is told at its merge and followed no further.
   */
  separate: z
    .object({
      version: z.string().max(100).nullable(),
      revision: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .nullable(),
    })
    .nullable()
    .default(null),
});
export type TrackerHealth = z.infer<typeof TrackerHealth>;

/** The connection's check: whether its token works. */
export const TrackerCheck = z.object({
  ok: z.boolean(),
  /** The tracker refused the token (it needs a new one). */
  refused: z.boolean(),
  status: z.number().int().nullable(),
  message: z.string().max(500).nullable(),
});
export type TrackerCheck = z.infer<typeof TrackerCheck>;

/** An organization's read-only access for one step (a tracker that grants one). */
export const TrackerGrant = z.object({
  token: z.string().min(8).max(4096),
  expiresAt: z.string().max(40),
  scopes: z.array(z.string().max(64)).max(32),
  organizationId: z.string().max(200).nullable(),
});
export type TrackerGrant = z.infer<typeof TrackerGrant>;

/** What a write of an assessment did: the values it sent (null: not sent), or nothing new to send. */
export const TrackerWriteResult = z.union([
  z.object({
    sent: z.object({ assessment: z.string().max(40).nullable(), priority: z.string().max(40).nullable() }),
  }),
  z.object({ unchanged: z.literal(true) }),
]);
export type TrackerWriteResult = z.infer<typeof TrackerWriteResult>;

/** What a send did: what it set, whether the tracker had it already, the item's status as the tracker had it. */
export const TrackerSendResult = z.union([
  z.object({
    sent: z.literal(true),
    /** The status it set (null: the status stayed). */
    status: z.string().max(40).nullable(),
    /** The tracker already had this request id's message: an earlier send went through, nothing was sent now. */
    already: z.boolean(),
    /** The item's status as the tracker had it when it was read for the send. */
    now: z.string().max(40),
  }),
  z.object({ skipped: z.string().max(500), now: z.string().max(40) }),
]);
export type TrackerSendResult = z.infer<typeof TrackerSendResult>;

/* The calls ---------------------------------------------------------------------------------------------------- */

/** The connection a call is about: its address and token, as the person set them. */
export interface TrackerConnection {
  id: string;
  label: string;
  /** The tracker's address, without a trailing slash. */
  baseUrl: string;
  /** Its API token. */
  token: string;
}

/** What a send says to the tracker (all safe to repeat with the same `requestId`). */
export interface TrackerSend {
  /** Kept by the tracker so a repeat changes nothing twice (and shows nothing twice). */
  requestId: string;
  /** A public reply the customer reads (signed already); absent: only a status. */
  message?: string;
  /**
   * The status to set, decided against the item's status as the tracker has it when the driver reads it for the send
   * (before each attempt): a value, null to leave it, or `{skip}` to send nothing (the reason is answered back).
   */
  status: (now: string) => string | null | { skip: string };
  /** The original a `duplicate` status links to (its tracker id). */
  duplicateOf?: string;
  /** The release record an `available` status needs: the version that runs the fix and the evidence the customer reads. */
  release?: { version: string; evidence: string };
}

/**
 * The calls of interface version 1. Every call may throw an error with a `code` (`TrackerErrorCode`) and a message in
 * plain words; any other throw counts as `unreachable`. Each has a time limit set by the server: at it the server stops
 * waiting, but a version 1 call can't be cancelled and goes on in the background. Version 2 should pass each call an
 * `AbortSignal` the driver hands to its requests.
 */
export interface TrackerDriver {
  /** What the driver is (`TrackerDriverInfo`). */
  info: TrackerDriverInfo;
  /** Whether the connection's token works (the connection's check, and confirming a refused token). */
  check(conn: TrackerConnection): Promise<TrackerCheck>;
  /** What the installation runs (read at most once a minute). */
  health(conn: TrackerConnection): Promise<TrackerHealth>;
  /**
   * The newest items, newest first. `after` null: only the newest page (a first read, or samples with `pages`). Else
   * reading on until an item numbered `after` or lower was listed and the lowest `watch` number too — a few pages
   * normally, much further to catch up after a gap — and `backlog` when even that doesn't reach `after`.
   */
  poll(
    conn: TrackerConnection,
    input: { after: number | null; watch: readonly number[]; pages?: number },
  ): Promise<TrackerPoll>;
  /** One item read now, in full. Throws `not_found` when the tracker has no such item. */
  item(conn: TrackerConnection, id: string): Promise<TrackerItemFull>;
  /** A diagnostics package the item links, as text (at most `maxBytes`). Throws `not_found` for one it doesn't link. */
  diagnostics(
    conn: TrackerConnection,
    id: string,
    pkg: string,
    maxBytes: number,
  ): Promise<{ text: string; cut: boolean }>;
  /**
   * Writes an assessment and a priority (null: none), only what the tracker doesn't have yet. `resend`: this request id
   * may have been sent before, so values it has count as written.
   */
  write(
    conn: TrackerConnection,
    id: string,
    input: { assessment: string | null; priority: string | null; requestId: string; resend: boolean },
  ): Promise<TrackerWriteResult>;
  /** A reply and/or a status (see `TrackerSend`). Throws `conflict` when the item changed under it twice in a row. */
  send(conn: TrackerConnection, id: string, input: TrackerSend): Promise<TrackerSendResult>;
  /** Read-only access to the item's organization for about an hour (absent: the tracker grants none). */
  grant?(conn: TrackerConnection, id: string): Promise<TrackerGrant>;
  /**
   * A GET of `path` on the tracker with a grant's token; refused paths throw `rejected` with why. Answers the tracker's
   * HTTP status and its body as text (at most `maxBytes`).
   */
  read?(
    conn: TrackerConnection,
    grant: { token: string },
    path: string,
    maxBytes: number,
  ): Promise<{ status: number; body: string; cut: boolean }>;
  /** Ends every access granted for the item. True when the tracker confirmed it. */
  revoke?(conn: TrackerConnection, id: string): Promise<boolean>;
  /**
   * The line a fix's pull request carries for the tracker's own tooling (it may look for merged fixes by it), or null.
   * Its text starts with `info.prPrefix`.
   */
  prLine?(conn: TrackerConnection, number: number): string | null;
  /** The items a pull request's description names by `prLine`: the tracker's host and the item's number. */
  prMatch?(body: string): { host: string; number: number }[];
}

/** Why a call failed, as a driver says it. */
export const TRACKER_ERROR_CODES = [
  /** The tracker refused the token (401/403): the connection may need a new one. */
  'refused',
  /** It didn't answer, or answered with a server error: try again later. */
  'unreachable',
  /** It answered with something the driver doesn't understand. */
  'invalid_answer',
  /** The item changed under the write twice in a row. */
  'conflict',
  /** It has no such item (or package). */
  'not_found',
  /** It refused this request (its own words in the message): repeating it won't help. */
  'rejected',
  /** It didn't grant the organization's access (the message says why). */
  'access_refused',
] as const;
export type TrackerErrorCode = (typeof TRACKER_ERROR_CODES)[number];

/** A driver's failure, as the server handles it (`TrackerFailure.of` reads whatever a driver threw). */
export class TrackerFailure extends Error {
  override name = 'TrackerFailure';
  constructor(
    readonly code: TrackerErrorCode,
    message: string,
  ) {
    super(message);
  }

  /** What a driver threw, as a failure: its `code` when it is one of ours, else `unreachable`. */
  static of(err: unknown, product = 'The tracker'): TrackerFailure {
    if (err instanceof TrackerFailure) return err;
    const code = (err as { code?: unknown } | null)?.code;
    const message = err instanceof Error && err.message ? err.message : `${product} didn’t answer.`;
    return new TrackerFailure(
      typeof code === 'string' && (TRACKER_ERROR_CODES as readonly string[]).includes(code)
        ? (code as TrackerErrorCode)
        : 'unreachable',
      message.slice(0, 500),
    );
  }
}
