/**
 * Settings → Skills (0.92, CT-415; since 0.125 on Hermes's skills, CT-1210…CT-1216; since 2.0 Hermes's own skills, hub
 * and guard, CT-1410…CT-1419; since 3.0 one list, CT-1570…CT-1575; Whombat hermes-engine.md HE-38, hermes-skills.md
 * HSK-01…HSK-13, one-person.md OP-08): the skills the agent has, one list in the person's Hermes profile as Hermes lays
 * it out — Hermes's built-in skills, what you installed from Hermes's hub and what the agent learned working with you.
 * Burrow-scoped; the server reads and changes them through the runner (HE-38). Spread into `api.skills`.
 *
 * - `skills.library`: every skill (`SkillLibraryItem`) and Hermes's categories.
 * - `skills.librarySkill` / `skills.librarySkillFile`: one skill's text and files (and, for a changed or removed
 *   built-in, the version Hermes ships: Compare).
 * - `skills.libraryEdit` (checked by Hermes's scan), `librarySwitch` (Hermes's `skills.disabled`), `libraryRemove` (a
 *   built-in stays `removed` until restored, a hub skill is uninstalled, a learned one goes), `libraryRestore` (Hermes's
 *   reset of a built-in).
 * - Add skills (HSK-06…HSK-09): `skills.hubSearch` (browse or search Hermes's hub, three sources), `skills.hubPreview`
 *   (one skill as Hermes's scan and policy see it), `skills.hubInstall`, `skills.hubUpdates` (Hermes's update check, at
 *   most once an hour) and `skills.hubUpdate`.
 *
 * Reads that can outgrow one CONTROL message (the library, a skill, a file, a hub search or preview) are read through
 * an export stream over the session (`@whombat/protocol`'s `EXPORT_READ_OPS`, CT-1418); every change answers one row.
 */
import { z } from 'zod';
import { Count, Timestamp } from '../domain/common.js';
import { LibrarySkillBody, SkillDescription } from '../domain/skills.js';
import { skillPathProblem } from '../skills/files.js';
import {
  SCAN_FINDINGS_MAX,
  ScanFinding,
  ScanVerdict,
  SkillHubIdentifier,
  SkillHubSource,
  SkillPolicy,
  SkillTrust,
} from '../skills/hub.js';
import { SkillCategory, SkillCategoryInfo, SkillName, SkillNeeds, SkillOrigin } from '../skills/skill.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/* A skill in the library ----------------------------------------------------------------------------------------- */

/**
 * `on`; `off` (switched off: Hermes's `skills.disabled`, HSK-05); `removed` (a built-in you removed: Hermes never brings
 * it back, Restore does). What a skill needs is `needs`, not a status (HSK-10).
 */
export const SKILL_STATUSES = ['on', 'off', 'removed'] as const;
export const SkillStatus = z.enum(SKILL_STATUSES);
export type SkillStatus = z.infer<typeof SkillStatus>;

/** What can be done with a skill (CT-1211, CT-1411; since 3.0 without sharing, CT-1572). */
export const SkillCan = z.object({
  /** Edit its text. */
  edit: z.boolean(),
  /** Switch it on or off. */
  switch: z.boolean(),
  /** Remove it. */
  remove: z.boolean(),
  /** Bring back Hermes's version of a changed or removed built-in (Hermes's reset). */
  restore: z.boolean(),
  /** Install the newer version of a hub skill (while `hub.updateAvailable`). */
  update: z.boolean(),
});
export type SkillCan = z.infer<typeof SkillCan>;

/**
 * Where a hub skill came from, as Hermes's hub lock records it (HSK-06, HSK-09): its source and identifier, the trust it
 * was installed with, and whether Hermes's last update check found a newer version (`skills.hubUpdates`).
 */
export const SkillHubInfo = z.object({
  source: SkillHubSource,
  identifier: SkillHubIdentifier,
  trust: SkillTrust,
  updateAvailable: z.boolean(),
});
export type SkillHubInfo = z.infer<typeof SkillHubInfo>;

/** One row of Settings → Skills: one skill (one per name). */
export const SkillLibraryItem = z.object({
  name: SkillName,
  description: z.string().max(2000),
  /** The category Hermes files it under (its first folder, HSK-13), or none (a learned skill at the top). */
  category: SkillCategory.nullable(),
  /** Hermes's built-in, installed from the hub, or learned by the agent (HSK-01, CT-1570). */
  origin: SkillOrigin,
  /** A hub skill's source; null for any other origin. */
  hub: SkillHubInfo.nullable(),
  /** Switched on (Hermes's `skills.disabled` doesn't name it). */
  enabled: z.boolean(),
  /** A built-in you changed (Hermes keeps it at the next sync): Settings marks it “Changed”; Restore. */
  changed: z.boolean(),
  /** A changed built-in whose version in Hermes is newer than the one it was changed from (“The original changed”). */
  originalChanged: z.boolean(),
  status: SkillStatus,
  /** What its front matter says it needs (HSK-10): `skillNeedsText` puts it in words. */
  needs: SkillNeeds,
  /** Its content's version (Hermes's folder hash): `ifVersion` of an edit. */
  version: z.string().max(16),
  /** When its files last changed, as Hermes's folder says; null when unknown. */
  updatedAt: Timestamp.nullable(),
  can: SkillCan,
});
export type SkillLibraryItem = z.infer<typeof SkillLibraryItem>;

/** Most categories one library answer describes. */
export const SKILL_CATEGORIES_MAX = 200;

/** Settings → Skills: every skill and Hermes's categories of the skills in it (title and `DESCRIPTION.md`, HSK-13). */
export const SkillLibraryResponse = z.object({
  agentName: z.string(),
  items: z.array(SkillLibraryItem),
  categories: z.array(SkillCategoryInfo).max(SKILL_CATEGORIES_MAX),
});
export type SkillLibraryResponse = z.infer<typeof SkillLibraryResponse>;

/** A path inside a skill's folder (`skillPathProblem`'s rules). */
export const SkillFilePathText = z
  .string()
  .min(1)
  .max(200)
  .refine((path) => skillPathProblem(path) === null, 'A path inside the skill.');

/** A file of a skill and its size. */
export const SkillFileSize = z.object({ path: z.string().max(200), bytes: Count });
export type SkillFileSize = z.infer<typeof SkillFileSize>;

/** Which skill: its name (one skill per name, CT-1571). */
export const SkillRefQuery = z.object({ name: SkillName });
export type SkillRefQuery = z.infer<typeof SkillRefQuery>;

/**
 * How a file of a changed built-in differs from Hermes's version (Hermes's `diff_bundled_skill`): `modified`, `added`
 * (only in the changed one), `removed` (only in Hermes's) or `binary` (a binary file that differs).
 */
export const SKILL_FILE_CHANGES = ['modified', 'added', 'removed', 'binary'] as const;
export const SkillFileChange = z.object({ path: z.string().max(200), status: z.enum(SKILL_FILE_CHANGES) });
export type SkillFileChange = z.infer<typeof SkillFileChange>;

export const LibrarySkillResponse = z.object({
  item: SkillLibraryItem,
  /** Its `SKILL.md` body, without front matter. */
  text: z.string(),
  files: z.array(SkillFileSize),
  /**
   * What to compare it with (Compare): Hermes's version of a changed or removed built-in (its body, and how each file
   * differs, Hermes's diff). Null otherwise.
   */
  original: z.object({ text: z.string(), changes: z.array(SkillFileChange).max(256).default([]) }).nullable(),
});
export type LibrarySkillResponse = z.infer<typeof LibrarySkillResponse>;

export const SkillFileQuery = SkillRefQuery.extend({ path: SkillFilePathText });
export type SkillFileQuery = z.infer<typeof SkillFileQuery>;

/**
 * Edit (SK-17): its `SKILL.md` body and description, the rest of its front matter kept.
 * Hermes's scan checks it as `agent-created` first: dangerous is refused (`not_allowed`, `skill_blocked`, HSK-07). A
 * built-in is then `changed`. `ifVersion`: the item's `version` the edit started from; changed since, `conflict`.
 */
export const SkillEditBody = z.object({
  name: SkillName,
  description: SkillDescription.optional(),
  body: LibrarySkillBody,
  ifVersion: z.string().max(16).optional(),
});
export type SkillEditBody = z.input<typeof SkillEditBody>;
/** On or off: Hermes's `skills.disabled` in every turn (HSK-05). */
export const SkillSwitchBody = z.object({ name: SkillName, on: z.boolean() });
export type SkillSwitchBody = z.infer<typeof SkillSwitchBody>;
/**
 * Remove (CT-1211): a built-in stays `removed` until restored, never brought back by Hermes's sync; a hub skill is
 * uninstalled the Hermes way; a learned one goes.
 */
export const SkillRemoveBody = SkillRefQuery;
export type SkillRemoveBody = z.infer<typeof SkillRemoveBody>;
/** Restore: a changed or removed built-in back to Hermes's version, on (Hermes's reset). */
export const SkillRestoreBody = z.object({ name: SkillName });
export type SkillRestoreBody = z.infer<typeof SkillRestoreBody>;
/** The row as it is after the change; null when no row remains (a removed skill). */
export const SkillItemResponse = z.object({ item: SkillLibraryItem.nullable() });
export type SkillItemResponse = z.infer<typeof SkillItemResponse>;

/* Hermes's hub (HSK-06…HSK-09) ----------------------------------------------------------------------------------- */

/** Most results one hub search answers (Hermes's dashboard caps its search at 50). */
export const SKILL_HUB_RESULTS_MAX = 50;

/**
 * Browse or search Hermes's hub (HSK-06): `q` absent or empty browses (what each source lists first), else Hermes's
 * search; `source` narrows to one of the three.
 */
export const SkillHubSearchQuery = z.object({
  q: z.string().trim().max(200).optional(),
  source: SkillHubSource.optional(),
});
export type SkillHubSearchQuery = z.infer<typeof SkillHubSearchQuery>;

/**
 * One skill Hermes's hub found (`SkillMeta`): its source and identifier (what `skills.hubPreview` and
 * `skills.hubInstall` take), name and description, Hermes's trust, the repository and path it lives at when known, how
 * many installs skills.sh counts when it says, and whether it is installed here already.
 */
export const SkillHubResult = z.object({
  source: SkillHubSource,
  identifier: SkillHubIdentifier,
  name: z.string().min(1).max(120),
  description: z.string().max(1_024),
  trust: SkillTrust,
  repo: z.string().max(200).nullable(),
  path: z.string().max(300).nullable(),
  installs: Count.nullable(),
  installed: z.boolean(),
});
export type SkillHubResult = z.infer<typeof SkillHubResult>;

export const SkillHubSearchResponse = z.object({
  results: z.array(SkillHubResult).max(SKILL_HUB_RESULTS_MAX),
  /** Sources that didn't answer in time; their results are missing. */
  unreachable: z.array(SkillHubSource).default([]),
});
export type SkillHubSearchResponse = z.infer<typeof SkillHubSearchResponse>;

export const SkillHubIdentifierQuery = z.object({ identifier: SkillHubIdentifier });
export type SkillHubIdentifierQuery = z.infer<typeof SkillHubIdentifierQuery>;

/** Hermes's scan of one skill (HSK-07): its verdict, the findings (the first `SCAN_FINDINGS_MAX`) and how many. */
export const SkillScan = z.object({
  verdict: ScanVerdict,
  findings: z.array(ScanFinding).max(SCAN_FINDINGS_MAX),
  findingsTotal: Count,
});
export type SkillScan = z.infer<typeof SkillScan>;

/**
 * One hub skill as Install would take it (HSK-07; Hermes's own preview and scan): fetched into quarantine and scanned,
 * nothing installed. Its whole `SKILL.md` (front matter included), its files and sizes, what it needs, the platforms
 * its front matter names (empty: any), Hermes's scan and what its policy decides, in plain words. A `block` has no
 * Install and there is no force. `nameTaken`: a skill here already has its name, so Install would be `conflict`
 * (`skill_exists`).
 */
export const SkillHubPreview = z.object({
  result: SkillHubResult,
  text: z.string(),
  files: z.array(SkillFileSize).max(256),
  needs: SkillNeeds,
  platforms: z.array(z.string().max(40)).max(8),
  scan: SkillScan,
  policy: SkillPolicy,
  nameTaken: z.boolean(),
});
export type SkillHubPreview = z.infer<typeof SkillHubPreview>;

/** Install a hub skill (HSK-06): by its identifier, through the same scan and policy. */
export const SkillHubInstallBody = z.object({ identifier: SkillHubIdentifier });
export type SkillHubInstallBody = z.infer<typeof SkillHubInstallBody>;

/** The skill as installed or updated: on, `origin: 'hub'`. */
export const SkillInstalledResponse = z.object({ item: SkillLibraryItem });
export type SkillInstalledResponse = z.infer<typeof SkillInstalledResponse>;

/** Update an installed hub skill to Hermes's newer version (HSK-09): through the same scan and policy. */
export const SkillHubUpdateBody = z.object({ name: SkillName });
export type SkillHubUpdateBody = z.infer<typeof SkillHubUpdateBody>;

/**
 * Hermes's update check of the installed hub skills (HSK-09, `check_for_skill_updates`): when it ran, which have a newer
 * version, and which it couldn't ask (their source didn't answer). A check older than `SKILL_UPDATE_CHECK_MS` runs again
 * first; a newer one is answered as it was.
 */
export const SkillHubUpdatesResponse = z.object({
  checkedAt: Timestamp.nullable(),
  available: z.array(SkillName),
  unreachable: z.array(SkillName).default([]),
});
export type SkillHubUpdatesResponse = z.infer<typeof SkillHubUpdatesResponse>;

/* Endpoints ------------------------------------------------------------------------------------------------------ */

const L = '/burrows/:burrow/skills/library';
const H = '/burrows/:burrow/skills/hub';

export const skillLibraryEndpoints = {
  library: endpoint({
    id: 'skills.library',
    method: 'GET',
    path: L,
    summary:
      'Every skill the agent has (Hermes’s built-ins, hub installs and what it learned), Hermes’s categories, and what can be done with each.',
    params: B,
    response: SkillLibraryResponse,
  }),
  librarySkill: endpoint({
    id: 'skills.librarySkill',
    method: 'GET',
    path: `${L}/skill`,
    summary: 'One skill: its text and files, and Hermes’s version of a changed or removed built-in.',
    params: B,
    query: SkillRefQuery,
    response: LibrarySkillResponse,
  }),
  librarySkillFile: endpoint({
    id: 'skills.librarySkillFile',
    method: 'GET',
    path: `${L}/skill/file`,
    summary: 'One file of a skill, as text.',
    params: B,
    query: SkillFileQuery,
    response: z.object({ path: z.string(), text: z.string() }),
  }),
  libraryEdit: endpoint({
    id: 'skills.libraryEdit',
    method: 'POST',
    path: `${L}/edit`,
    summary: 'Save a skill’s text, checked by Hermes’s scan. A built-in becomes `changed` until restored.',
    params: B,
    body: SkillEditBody,
    response: SkillItemResponse,
  }),
  librarySwitch: endpoint({
    id: 'skills.librarySwitch',
    method: 'POST',
    path: `${L}/switch`,
    summary: 'Switch a skill on or off: off, the agent doesn’t get it.',
    params: B,
    body: SkillSwitchBody,
    response: SkillItemResponse,
  }),
  libraryRemove: endpoint({
    id: 'skills.libraryRemove',
    method: 'POST',
    path: `${L}/remove`,
    summary:
      'Remove a skill: a built-in stays removed until restored, a hub skill is uninstalled, a learned one goes.',
    params: B,
    body: SkillRemoveBody,
    response: SkillItemResponse,
  }),
  libraryRestore: endpoint({
    id: 'skills.libraryRestore',
    method: 'POST',
    path: `${L}/restore`,
    summary: 'Bring back Hermes’s version of a changed or removed built-in, on (Hermes’s reset).',
    params: B,
    body: SkillRestoreBody,
    response: SkillItemResponse,
  }),
  hubSearch: endpoint({
    id: 'skills.hubSearch',
    method: 'GET',
    path: `${H}/search`,
    summary:
      'Browse or search Hermes’s hub: Hermes’s optional skills, its trusted GitHub repositories and skills.sh. `unavailable` when the hub can’t be asked.',
    params: B,
    query: SkillHubSearchQuery,
    response: SkillHubSearchResponse,
  }),
  hubPreview: endpoint({
    id: 'skills.hubPreview',
    method: 'GET',
    path: `${H}/preview`,
    summary:
      'One hub skill before Install: its SKILL.md and files, what it needs, Hermes’s scan and what Hermes’s policy decides. Nothing is installed.',
    params: B,
    query: SkillHubIdentifierQuery,
    response: SkillHubPreview,
  }),
  hubInstall: endpoint({
    id: 'skills.hubInstall',
    method: 'POST',
    path: `${H}/install`,
    summary:
      'Install a hub skill the Hermes way: scanned again, refused when Hermes’s policy blocks it (`skill_blocked`) or its name is taken (`skill_exists`).',
    params: B,
    body: SkillHubInstallBody,
    response: SkillInstalledResponse,
    status: 201,
  }),
  hubUpdates: endpoint({
    id: 'skills.hubUpdates',
    method: 'GET',
    path: `${H}/updates`,
    summary: 'Which installed hub skills have a newer version (Hermes’s update check, at most once an hour).',
    params: B,
    response: SkillHubUpdatesResponse,
  }),
  hubUpdate: endpoint({
    id: 'skills.hubUpdate',
    method: 'POST',
    path: `${H}/update`,
    summary: 'Install the newer version of a hub skill, through the same scan and policy (`skill_blocked`).',
    params: B,
    body: SkillHubUpdateBody,
    response: SkillInstalledResponse,
  }),
};
