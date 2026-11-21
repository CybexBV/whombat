/**
 * The runner's Hermes-home service, as the server asks it (contracts 0.125, CT-1220; since 2.0 the skills steps on
 * Hermes's own skills, hub and guard, CT-1420…CT-1429; since 2.1 `sessions.list`, CT-1453; since 3.0 one person's
 * profile, CT-1576…CT-1580; Whombat docs/decisions/hermes-engine.md HE-38, HE-S110…HE-S124, hermes-skills.md
 * HSK-02…HSK-10, hermes-native.md HN-K03, one-person.md OP-08, OP-17). The Hermes home is the runner's: the server reads
 * and changes the person's memory files, skills and sessions, and exports and imports them for backups, only through
 * these steps — never the files. As with sign-ins (managed-providers.md PV-12) the server queues each step and the
 * runner takes it over a long poll and answers:
 *
 *   POST /internal/runner/hermes/poll   {waitMs?}                       → {requests: [{id, method, params}]}
 *   POST /internal/runner/hermes/answer {id, ok, result | error, code}  → {ok}
 *
 * on the sign-in socket when one is configured (MR-34), else the loopback runner API, runner token either way. Every
 * method's params and result are below (`HERMES_HOME_METHODS`); the runner checks the params before it touches a home,
 * the server the result before it believes it. Bytes (a home's archive) travel in base64 chunks of at most
 * `HERMES_HOME_CHUNK_BYTES`, so every step is one small JSON request.
 *
 * Written by Whombat's streams M and K (`packages/agent-runtime/src/hermes/home/protocol.ts`) and carried here as is
 * (`runnerApi.hermesPoll` / `hermesAnswer`, `HERMES_HOME_METHODS`).
 */
import { z } from 'zod';
import {
  SCAN_FINDINGS_MAX,
  ScanFinding,
  ScanTrust,
  ScanVerdict,
  SkillHubIdentifier,
  SkillHubSource,
  SkillTrust,
} from '../skills/hub.js';
import { SKILL_CATEGORY_DESCRIPTION_MAX, SKILL_ORIGINS, SkillCategory, SkillNeeds } from '../skills/skill.js';
import { endpoint, RUNNER_PREFIX } from './endpoint.js';
import { SKILL_STATUSES } from './skills-library.js';

/* Common ------------------------------------------------------------------------------------------------------------- */

/**
 * The two Hermes homes on a Whombat (3.0, CT-1576; Whombat one-person.md OP-08, OP-17; the lead with R1), by what each is
 * for, and the profile Hermes knows each by (`hermes -p <name>`; `default` is Hermes's default profile, the Hermes home
 * itself):
 *
 * - `person` (`default`) — the person's: their turns, schedules and automations; their memory, sessions and the one
 *   skills list (Hermes's built-ins, hub installs, what the agent learned).
 * - `outside` (`_feedback`, the profile of feedback assessments before 3.0, now every outside turn's) — the turns that
 *   outsiders' input starts (`DispatchContext.outside`: website feedback assessments, tracker customers' replies,
 *   incoming mail): a stranger's text, so they never reach the person's mail, calendar, files, Vault or memory (FB-21,
 *   OP-17). They keep their Hermes sessions here.
 *
 * The runner picks the home from the dispatch (`outside`). The server names one where it reaches both: the session steps
 * and a profile's archive (`HermesHomeRef`). Memory and skills are the person's only.
 */
export const HERMES_HOMES = ['person', 'outside'] as const;
export const HermesHome = z.enum(HERMES_HOMES);
export type HermesHome = z.infer<typeof HermesHome>;
/** The Hermes profile each home is. */
export const HERMES_HOME_PROFILES: Readonly<Record<HermesHome, string>> = {
  person: 'default',
  outside: '_feedback',
};

/** An account id, as `by` names the person who made a change (null there: Whombat itself). */
export const HermesAccountId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/);

/** A Hermes session id as Whombat stores it after `hermes:` (`HERMES_SESSION_PREFIX`). */
export const HermesSessionId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);

/** Why a step failed, for the server to act on (the message is the runner's, never shown as is). */
export const HermesHomeErrorCode = z.enum([
  /** The agent is working in the profile now (its lock is held): try again after the turn. */
  'busy',
  /** A memory file would be longer than Hermes's limit for it. */
  'too_long',
  /** The file changed since the version the write was based on, or another skill has the name. */
  'conflict',
  /** No such transfer (expired or discarded), session, skill or hub skill. */
  'not_found',
  /** The params or an archive aren't what this service takes. */
  'invalid',
  /**
   * There is no real Hermes here to run the step (development's scripted Hermes), or Hermes's hub didn't answer (2.0,
   * CT-1422; HSK-03): worth trying again later where there is one.
   */
  'unavailable',
  /** Hermes's scan and install policy refused the skill (a hub install or update; HSK-07). */
  'blocked',
  /** Anything else: the home couldn't be read or written. */
  'failed',
]);
export type HermesHomeErrorCode = z.infer<typeof HermesHomeErrorCode>;

/* Memory (HE-39) ----------------------------------------------------------------------------------------------------- */

/**
 * Hermes's two memory files in the person's profile (`memories/MEMORY.md`, what the agent learned working with the
 * person; `memories/USER.md`, about them): entries joined by `HERMES_MEMORY_DELIMITER`, each file within its character
 * limit (`memory.memory_char_limit`, `memory.user_char_limit`).
 */
export const HermesMemoryFile = z.enum(['memory', 'user']);
export type HermesMemoryFile = z.infer<typeof HermesMemoryFile>;

/** Hermes's entry separator (`tools/memory_tool_store.py` `ENTRY_DELIMITER`). */
export const HERMES_MEMORY_DELIMITER = '\n§\n';
/** Hermes's default limits, in characters of the joined entries (its `memory` config's defaults). */
export const HERMES_MEMORY_LIMITS: Readonly<Record<HermesMemoryFile, number>> = {
  memory: 2_200,
  user: 1_375,
};
/** Most entries in one file this service reads or writes (a file of short entries; Hermes has no count limit). */
export const HERMES_MEMORY_ENTRIES_MAX = 200;
/** Longest entry this service takes (Hermes's own limit for the larger file). */
export const HERMES_MEMORY_ENTRY_MAX = 2_200;

export const HermesMemoryState = z.object({
  file: HermesMemoryFile,
  /** The entries, in the file's order (stripped, none empty, as Hermes parses them). */
  entries: z.array(z.string().max(16_384)).max(1_000),
  /** Characters of the entries joined by the delimiter: what Hermes counts against `limit`. */
  chars: z.number().int().min(0),
  limit: z.number().int().min(0),
  /** The file's version: the sha256 of its bytes (hex, first 16), `''` while there is no file. */
  version: z.string().max(16),
  /** When the file last changed; null while there is none. */
  updatedAt: z.iso.datetime().nullable(),
});
export type HermesMemoryState = z.infer<typeof HermesMemoryState>;

export const HermesMemoryBoth = z.object({ memory: HermesMemoryState, user: HermesMemoryState });
export type HermesMemoryBoth = z.infer<typeof HermesMemoryBoth>;

export const MEMORY_METHODS = {
  /** Both files, as Hermes would load them. */
  'memory.read': {
    params: z.object({}),
    result: HermesMemoryBoth,
  },
  /**
   * One file's entries replaced (empty entries dropped, in order), under the profile's lock; refused `too_long` over
   * Hermes's limit, `conflict` when `ifVersion` is given and the file is no longer that version, `busy` while a turn
   * holds the profile.
   */
  'memory.write': {
    params: z.object({
      file: HermesMemoryFile,
      entries: z.array(z.string().max(HERMES_MEMORY_ENTRY_MAX)).max(HERMES_MEMORY_ENTRIES_MAX),
      ifVersion: z.string().max(16).optional(),
    }),
    result: HermesMemoryState,
  },
  /** One file, or both, removed (what the agent knows about the person, forgotten). */
  'memory.clear': {
    params: z.object({ file: HermesMemoryFile.optional() }),
    result: HermesMemoryBoth,
  },
} as const;

/* Sessions (HE-40) --------------------------------------------------------------------------------------------------- */

/**
 * Most conversations one `sessions.list` answers (2.1, CT-1453). Half of `sessions.pending`'s bound because each carries
 * its source and time: at the longest ids the answer stays near 1.2 MB, under the 2 MiB the runner's answer route takes.
 */
export const HERMES_SESSIONS_LIST_MAX = 5_000;

/**
 * One conversation in the person's Hermes session store (2.1, CT-1453; Whombat hermes-native.md HN-K03), as Hermes lists
 * it for an editor: one entry per conversation, however many compression or reset segments and sub-agent sessions it
 * has inside.
 */
export const HermesSessionListing = z.object({
  /**
   * The id an editor holds for it (ACP's, what Whombat stores after `hermes:`): Hermes's logical id, the conversation's
   * first segment, whichever segment is current. `sessions.delete` with it removes the whole conversation.
   */
  id: HermesSessionId,
  /** Where Hermes says it began: `acp` for Whombat's turns; anything else (`cli`, `cron`, …) as Hermes names it. */
  source: z.string().min(1).max(40),
  /** When anything last happened in it (Hermes's `last_active`, the latest over its segments). */
  lastActiveAt: z.iso.datetime(),
});
export type HermesSessionListing = z.infer<typeof HermesSessionListing>;

export const SESSION_METHODS = {
  /**
   * Hermes sessions to delete (a deleted thread's, Clear chats'), the Hermes way (`hermes sessions delete`), each under
   * the profile's lock. The runner keeps them on disk until done, so a busy profile or a restart only delays them;
   * `queued` is how many it took. A session Hermes doesn't know is already gone.
   */
  'sessions.delete': {
    params: z.object({ home: HermesHome, sessions: z.array(HermesSessionId).min(1).max(500) }),
    result: z.object({ queued: z.number().int().min(0) }),
  },
  /** The sessions still waiting to be deleted in a home (tests, and what a restore waits for). */
  'sessions.pending': {
    params: z.object({ home: HermesHome }),
    result: z.object({ sessions: z.array(HermesSessionId).max(10_000) }),
  },
  /**
   * The conversations in a home's Hermes session store (2.1, CT-1453), so the server can prune the ones no thread
   * names any more (a turn that never reported its session, a home restored from another Whombat; HN-K03) with
   * `sessions.delete`. The runner lists them the Hermes way — Hermes's own session store, as its ACP `session/list`
   * reads it — never by reading `state.db` or session files itself. A read: it doesn't take the profile's lock, so a
   * running turn neither waits for it nor makes it `busy`. Least recently active first; `more` when the store has
   * more than `HERMES_SESSIONS_LIST_MAX` (the most recent are then left out, which a prune would keep anyway).
   * `unavailable` without a real Hermes.
   *
   * A safe prune keeps every conversation a thread names (by `id`), anything active lately (a turn starts its session
   * before it reports it), and what isn't `acp`.
   */
  'sessions.list': {
    params: z.object({ home: HermesHome }),
    result: z.object({
      sessions: z.array(HermesSessionListing).max(HERMES_SESSIONS_LIST_MAX),
      more: z.boolean(),
    }),
  },
} as const;

/* A home's archive, for backups --------------------------------------------------------------------------------------- */

/** Most raw bytes in one chunk (base64 in the JSON: about 1.4 MB). */
export const HERMES_HOME_CHUNK_BYTES = 1024 * 1024;
/** Largest archive of the profile or of its skills (gzipped). */
export const HERMES_HOME_ARCHIVE_MAX_BYTES = 1024 * 1024 * 1024;
/** A transfer nobody finished is dropped after this long. */
export const HERMES_HOME_TRANSFER_TTL_MS = 60 * 60 * 1000;

/**
 * What an archive holds (3.0, CT-1578): `profile` — a home's profile without its `skills/` (memory, sessions, Hermes's
 * config of it; `home` which: the person's, or the outside turns'); `skills` — the person's profile's `skills/` folder
 * (built-ins, hub installs and their lock, learned skills).
 */
export const HermesHomeRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('profile'), home: HermesHome }),
  z.object({ kind: z.literal('skills') }),
]);
export type HermesHomeRef = z.infer<typeof HermesHomeRef>;

export const HermesTransferId = z.string().regex(/^hht_[A-Za-z0-9_-]{8,40}$/);
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const ChunkData = z.string().max(Math.ceil(HERMES_HOME_CHUNK_BYTES / 3) * 4);
const Offset = z.number().int().min(0).max(HERMES_HOME_ARCHIVE_MAX_BYTES);

/**
 * How an imported archive meets what is here: `replace` puts the archive's data in place of this home's (what it
 * holds of the home goes, everything else of Hermes's stays); `fill` adds only what is missing here, top-level entry by
 * entry (a profile with a session store keeps it; a skill that is here keeps its version).
 */
export const HermesImportMode = z.enum(['replace', 'fill']);
export type HermesImportMode = z.infer<typeof HermesImportMode>;

export const ARCHIVE_METHODS = {
  /**
   * Packs a home (under its profile's lock) into a gzipped ustar archive the runner keeps for the transfer; then
   * `home.exportChunk` until `bytes`, then `home.discard`. An empty home is an archive with only its manifest.
   */
  'home.exportBegin': {
    params: z.object({ home: HermesHomeRef }),
    result: z.object({
      transfer: HermesTransferId,
      bytes: z.number().int().min(0).max(HERMES_HOME_ARCHIVE_MAX_BYTES),
      sha256: Sha256,
      /** Files in the archive besides its manifest. */
      files: z.number().int().min(0),
    }),
  },
  'home.exportChunk': {
    params: z.object({
      transfer: HermesTransferId,
      offset: Offset,
      length: z.number().int().min(1).max(HERMES_HOME_CHUNK_BYTES),
    }),
    result: z.object({ data: ChunkData }),
  },
  /** An archive of `bytes` and `sha256` is coming for `home`: `home.importChunk` in order, then `home.importCommit`. */
  'home.importBegin': {
    params: z.object({
      home: HermesHomeRef,
      bytes: z.number().int().min(1).max(HERMES_HOME_ARCHIVE_MAX_BYTES),
      sha256: Sha256,
    }),
    result: z.object({ transfer: HermesTransferId }),
  },
  'home.importChunk': {
    params: z.object({ transfer: HermesTransferId, offset: Offset, data: ChunkData }),
    result: z.object({ received: Offset }),
  },
  /**
   * Checks the archive (size, sha256, its manifest is for the same kind of home, safe paths, only what a home holds)
   * and puts it in place under the profile's lock; `invalid` when it isn't one, `busy` while a turn holds the profile.
   */
  'home.importCommit': {
    params: z.object({ transfer: HermesTransferId, mode: HermesImportMode }),
    result: z.object({ files: z.number().int().min(0), kept: z.number().int().min(0) }),
  },
  /** A transfer's staged archive removed (done, or given up). Unknown transfers are fine. */
  'home.discard': {
    params: z.object({ transfer: HermesTransferId }),
    result: z.null(),
  },
} as const;

/* Skills (HE-41, stream K; since 2.0 Hermes's own, CT-1420…CT-1429; since 3.0 one list, CT-1579) ------------------- */

/**
 * The skills of the person's profile, in Hermes's own layout (`$HERMES_HOME/skills`, OP-08): Hermes's built-in skills,
 * kept there by Hermes's own sync (HSK-02), what was installed from Hermes's hub (recorded in Hermes's hub lock,
 * `skills/.hub/lock.json`, HSK-06), and what the agent learned (Hermes's agent-created skills). One list: no shared
 * directory, no `external_dirs`, no copy of a skill in front of another. A skill is a folder (`SKILL.md` and its files)
 * at a path relative to `skills/`, as Hermes lays them out: `<category>/<name>`, `<name>`, or one folder deeper for an
 * optional skill Hermes nests (`mlops/training/axolotl`). No two skills share a name (Hermes refuses an ambiguous one): a
 * change that would make two is `conflict`. The outside home's profile (`_feedback`) has only what Hermes's own sync
 * gives it; nothing installed here or learned with the person reaches it (OP-17).
 *
 * Listing, reading, editing and on/off are the runner's own; the steps that are Hermes's code (sync, reset, diff, the
 * hub, the scan) run through the `whombat` plugin's `hermes` command (HSK-03) and answer `unavailable` where there is no
 * real Hermes (development's scripted Hermes) or the hub didn't answer. A change is made under the profile's lock
 * (`busy` while a turn holds it). `by` is who did it (null: Whombat itself).
 */

/** One part of a skill's path: what Hermes names a category or a skill (and a little more, for what is on disk). */
const SKILL_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,63}';
/** A skill's folder in its directory: `<name>`, `<category>/<name>` or `<category>/<subcategory>/<name>`. */
export const HermesSkillPath = z.string().regex(new RegExp(`^${SKILL_SEGMENT}(/${SKILL_SEGMENT}){0,2}$`));
/** A file inside a skill's folder (`SKILL.md`, `references/api.md`, `scripts/run.py`): at most 4 levels, no `..`. */
export const HermesSkillFilePath = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}(\/[A-Za-z0-9_][A-Za-z0-9._ -]{0,99}){0,3}$/);

/**
 * A skill's origin (HSK-01, CT-1579): `builtin` (Hermes's own, in its sync's `.bundled_manifest`), `hub` (in Hermes's
 * hub lock) or `learned` (anything else in `skills/`: what the agent wrote, Hermes's agent-created).
 */
export const HermesSkillOrigin = z.enum(SKILL_ORIGINS);
export type HermesSkillOrigin = z.infer<typeof HermesSkillOrigin>;
/** A skill is `on`, switched `off` (Hermes's `skills.disabled`), or (only a built-in) `removed`. */
export const HermesSkillState = z.enum(SKILL_STATUSES);
export type HermesSkillState = z.infer<typeof HermesSkillState>;

/** Who did something and when; `by` null is Whombat itself. */
export const HermesSkillChange = z.object({ by: HermesAccountId.nullable(), at: z.iso.datetime() });
export type HermesSkillChange = z.infer<typeof HermesSkillChange>;

/** Most skills one list carries. */
export const HERMES_SKILLS_MAX = 2_000;
/** Most files of one skill this service reads or writes. */
export const HERMES_SKILL_FILES_MAX = 256;
/** Largest `SKILL.md` this service reads or writes (Hermes's own limit is 100,000 characters). */
export const HERMES_SKILL_MD_MAX_BYTES = 256 * 1024;
/** Largest file of a skill this service reads or writes (Hermes's own limit for a supporting file). */
export const HERMES_SKILL_FILE_MAX_BYTES = 1024 * 1024;
/** Largest skill, all its files together. */
export const HERMES_SKILL_MAX_BYTES = 4 * 1024 * 1024;

const SkillFileData = z.string().max(Math.ceil(HERMES_SKILL_FILE_MAX_BYTES / 3) * 4);

/** One file of a skill, its bytes in base64; `exec`: a script that runs (mode 0755). */
export const HermesSkillFile = z.object({
  path: HermesSkillFilePath,
  data: SkillFileData,
  exec: z.boolean().default(false),
});
export type HermesSkillFile = z.infer<typeof HermesSkillFile>;

/**
 * A hub skill's entry in Hermes's hub lock (`HubLockFile.record_install`): its source and identifier, the trust and
 * verdict it was installed with, and when it was installed and last updated.
 */
export const HermesHubEntry = z.object({
  source: SkillHubSource,
  identifier: SkillHubIdentifier,
  trust: SkillTrust,
  verdict: ScanVerdict,
  installedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type HermesHubEntry = z.infer<typeof HermesHubEntry>;

export const HermesSkillSummary = z.object({
  path: HermesSkillPath,
  /** Its front matter's `name`, else its folder's. */
  name: z.string().max(64),
  description: z.string().max(1_024),
  /** The folder's content (sha256 over its files, hex, first 16): `ifVersion` of a change. */
  version: z.string().max(16),
  /** Its newest file's time. */
  updatedAt: z.iso.datetime(),
  files: z.number().int().min(0),
  bytes: z.number().int().min(0),
  /** On, off or (a built-in) removed. */
  state: HermesSkillState,
  origin: HermesSkillOrigin,
  /** A hub skill: who installed it and when; null for a built-in and for a learned skill. */
  added: HermesSkillChange.nullable(),
  /** A hub skill's lock entry; null for any other. */
  hub: HermesHubEntry.nullable(),
  /**
   * A built-in the person changed (Hermes's sync keeps it, `user_modified`), or a hub or learned skill they edited: who
   * and when, as Whombat's bookkeeping says. Null as Hermes ships it, installed or learned. A changed built-in can be
   * restored (`skills.restore`).
   */
  changed: HermesSkillChange.nullable(),
  /** A changed built-in whose version in Hermes is newer than the one it was changed from (Compare). */
  originalChanged: z.boolean(),
  /** What its front matter says it needs, as Hermes reads it (HSK-10). */
  needs: SkillNeeds,
});
export type HermesSkillSummary = z.infer<typeof HermesSkillSummary>;

/** A category of `skills/` and Hermes's words for it (`<category>/DESCRIPTION.md`'s description; HSK-13). */
export const HermesSkillCategory = z.object({
  category: SkillCategory,
  description: z.string().max(SKILL_CATEGORY_DESCRIPTION_MAX).nullable(),
});
export type HermesSkillCategory = z.infer<typeof HermesSkillCategory>;

/** A skill as the service reads it: its summary, its `SKILL.md`, its files and what to compare it with. */
export const HermesSkillRead = z.object({
  skill: HermesSkillSummary,
  /** The whole `SKILL.md`, front matter included. */
  text: z.string().max(HERMES_SKILL_MD_MAX_BYTES),
  files: z
    .array(z.object({ path: HermesSkillFilePath, bytes: z.number().int().min(0) }))
    .max(HERMES_SKILL_FILES_MAX),
  /**
   * What it is compared with: for a changed or removed built-in, Hermes's bundled `SKILL.md` and how each file differs
   * (Hermes's `diff_bundled_skill`). Null otherwise.
   */
  original: z
    .object({
      text: z.string().max(HERMES_SKILL_MD_MAX_BYTES),
      changes: z
        .array(
          z.object({ path: HermesSkillFilePath, status: z.enum(['modified', 'added', 'removed', 'binary']) }),
        )
        .max(HERMES_SKILL_FILES_MAX),
    })
    .nullable(),
});
export type HermesSkillRead = z.infer<typeof HermesSkillRead>;

/**
 * Hermes's guard on one skill (`scan_skill`, then `should_allow_install` without force; HSK-07): the trust it scanned
 * with, its verdict, the first `SCAN_FINDINGS_MAX` findings (each `match` with secrets redacted) and how many there
 * were, and the policy's decision — Hermes's own `allow`, `block` or `ask` (an agent-created skill with a dangerous
 * verdict, which the server refuses like a block).
 */
export const HermesSkillScan = z.object({
  trust: ScanTrust,
  verdict: ScanVerdict,
  findings: z.array(ScanFinding).max(SCAN_FINDINGS_MAX),
  findingsTotal: z.number().int().min(0),
  decision: z.enum(['allow', 'block', 'ask']),
});
export type HermesSkillScan = z.infer<typeof HermesSkillScan>;

/** One skill Hermes's hub found (`SkillMeta`), and whether Hermes's hub lock has it installed here. */
export const HermesHubResult = z.object({
  source: SkillHubSource,
  identifier: SkillHubIdentifier,
  name: z.string().min(1).max(120),
  description: z.string().max(1_024),
  trust: SkillTrust,
  repo: z.string().max(200).nullable(),
  path: z.string().max(300).nullable(),
  /** skills.sh's install count, when it gives one. */
  installs: z.number().int().min(0).nullable(),
  installed: z.boolean(),
});
export type HermesHubResult = z.infer<typeof HermesHubResult>;

/** What Hermes's update check found for one installed hub skill (`check_for_skill_updates`' `status`). */
export const HermesHubUpdateStatus = z.enum([
  'up_to_date',
  'update_available',
  /** Its source didn't answer, or no longer has it. */
  'unavailable',
  /** The lock names a folder that is gone. */
  'orphaned',
  /** The lock entry's path isn't one Hermes accepts. */
  'invalid_install',
]);
export type HermesHubUpdateStatus = z.infer<typeof HermesHubUpdateStatus>;

/** Which skill: its path in `skills/`. */
const SkillRef = z.object({ path: HermesSkillPath });

/** Names one sync step reports per kind. */
const SyncNames = z.array(z.string().max(64)).max(HERMES_SKILLS_MAX);

export const SKILLS_METHODS = {
  /**
   * Every skill (on, off, and the built-ins the person removed) and the categories with Hermes's descriptions. Skills
   * Hermes never offers here (another platform's, one whose toolset is off, `hermes-agent`; HSK-04) aren't listed.
   * Reads only: a turn running in the profile doesn't make it `busy`.
   */
  'skills.list': {
    params: z.object({}),
    result: z.object({
      skills: z.array(HermesSkillSummary).max(HERMES_SKILLS_MAX),
      categories: z.array(HermesSkillCategory).max(HERMES_SKILLS_MAX),
    }),
  },
  /** One skill: `SKILL.md`, its files' sizes, and what to compare it with. `not_found` when it isn't there. */
  'skills.read': { params: SkillRef, result: HermesSkillRead },
  /** One file of a skill, in base64 (`invalid` past `HERMES_SKILL_FILE_MAX_BYTES`). */
  'skills.readFile': {
    params: SkillRef.extend({ file: HermesSkillFilePath }),
    result: z.object({ data: SkillFileData }),
  },
  /** A skill's whole folder (to show it). */
  'skills.export': {
    params: SkillRef,
    result: z.object({ files: z.array(HermesSkillFile).max(HERMES_SKILL_FILES_MAX) }),
  },
  /**
   * Hermes's guard on a skill folder as `agent-created` (HSK-07): before the person's edit, with the `SKILL.md` it would
   * write (`text`, in place of the folder's). Reads only; `unavailable` without a real Hermes.
   */
  'skills.scan': {
    params: SkillRef.extend({ text: z.string().min(1).max(HERMES_SKILL_MD_MAX_BYTES).optional() }),
    result: HermesSkillScan,
  },
  /**
   * A skill's `SKILL.md` replaced (an edit in Settings, scanned first with `skills.scan`): it is then `changed` by `by`.
   * `conflict` when `ifVersion` is given and the skill is no longer that version, or the new name is another skill's.
   */
  'skills.write': {
    params: SkillRef.extend({
      text: z.string().min(1).max(HERMES_SKILL_MD_MAX_BYTES),
      ifVersion: z.string().max(16).optional(),
      by: HermesAccountId.nullable(),
    }),
    result: HermesSkillSummary,
  },
  /**
   * A skill switched off or on again (HSK-05): the profile's `config.yaml` names it in `skills.disabled` (Hermes's own
   * switch). The skill stays where it is.
   */
  'skills.setOff': {
    params: z.object({ path: HermesSkillPath, off: z.boolean(), by: HermesAccountId.nullable() }),
    result: HermesSkillSummary,
  },
  /**
   * A skill removed: a built-in stays `removed` (Hermes's sync never brings it back) until restored, a learned one goes.
   * A hub skill is `invalid` here: `skills.hubUninstall`.
   */
  'skills.remove': {
    params: SkillRef.extend({ by: HermesAccountId.nullable() }),
    result: z.null(),
  },
  /**
   * A changed or removed built-in back as Hermes ships it, on (Hermes's `reset_bundled_skill` with `restore`, then its
   * sync). `not_found` when Hermes no longer ships it.
   */
  'skills.restore': {
    params: z.object({ path: HermesSkillPath, by: HermesAccountId.nullable() }),
    result: HermesSkillSummary,
  },
  /**
   * Hermes's bundled sync into the profile's `skills/` (`sync_skills` with its `.bundled_manifest`, HSK-02; the runner
   * runs it at start, a restored backup asks once more): the built-ins added, updated to this Hermes, kept because the
   * person changed them, and removed because Hermes no longer ships them, by name. A removed one never comes back; the
   * skills HSK-04 starts off are off when first added.
   */
  'skills.sync': {
    params: z.object({}),
    result: z.object({ added: SyncNames, updated: SyncNames, kept: SyncNames, removed: SyncNames }),
  },
  /**
   * Hermes's hub, browsed (`query` empty) or searched, over the three sources Whombat asks (HSK-06), or `source` alone.
   * `unreachable`: sources that didn't answer in time. `unavailable` without a real Hermes.
   */
  'skills.hubSearch': {
    params: z.object({
      query: z.string().max(200),
      source: SkillHubSource.nullable(),
      limit: z.number().int().min(1).max(50),
    }),
    result: z.object({
      results: z.array(HermesHubResult).max(50),
      unreachable: z.array(SkillHubSource),
    }),
  },
  /**
   * One hub skill fetched into quarantine and scanned, nothing installed (Hermes's inspect and scan, HSK-07): what it
   * is, its `SKILL.md`, its files, what it needs, its platforms, the scan, and whether a skill here has its name
   * (`taken`). `not_found` when the hub doesn't have it, `unavailable` when it didn't answer.
   */
  'skills.hubInspect': {
    params: z.object({ identifier: SkillHubIdentifier }),
    result: z.object({
      result: HermesHubResult,
      text: z.string().max(HERMES_SKILL_MD_MAX_BYTES),
      files: z
        .array(z.object({ path: HermesSkillFilePath, bytes: z.number().int().min(0) }))
        .max(HERMES_SKILL_FILES_MAX),
      needs: SkillNeeds,
      platforms: z.array(z.string().max(40)).max(8),
      scan: HermesSkillScan,
      taken: z.boolean(),
    }),
  },
  /**
   * A hub skill installed into the profile's `skills/`, on, the Hermes way (fetched, quarantined, scanned, Hermes's
   * policy, recorded in its hub lock), in the category Hermes installs it into. `blocked` when the policy refuses it,
   * `conflict` when a skill here has its name, `not_found`, `unavailable`.
   */
  'skills.hubInstall': {
    params: z.object({ identifier: SkillHubIdentifier, by: HermesAccountId.nullable() }),
    result: HermesSkillSummary,
  },
  /** A hub skill uninstalled the Hermes way (`uninstall_skill`: its folder and its lock entry). */
  'skills.hubUninstall': {
    params: z.object({ path: HermesSkillPath, by: HermesAccountId.nullable() }),
    result: z.null(),
  },
  /** Hermes's update check of every installed hub skill (`check_for_skill_updates`), by path. */
  'skills.hubCheck': {
    params: z.object({}),
    result: z.object({
      checkedAt: z.iso.datetime(),
      skills: z
        .array(z.object({ path: HermesSkillPath, name: z.string().max(64), status: HermesHubUpdateStatus }))
        .max(HERMES_SKILLS_MAX),
    }),
  },
  /**
   * A hub skill reinstalled at its source's newer version, through the same scan and policy (`blocked`); its on/off
   * choice is kept. `not_found` when it isn't a hub skill, `unavailable` when its source didn't answer.
   */
  'skills.hubUpdate': {
    params: z.object({ path: HermesSkillPath, by: HermesAccountId.nullable() }),
    result: HermesSkillSummary,
  },
} as const;

/* The registry and the two routes ------------------------------------------------------------------------------------- */

export const HERMES_HOME_METHODS = {
  ...MEMORY_METHODS,
  ...SESSION_METHODS,
  ...ARCHIVE_METHODS,
  ...SKILLS_METHODS,
} as const;

export type HermesHomeMethod = keyof typeof HERMES_HOME_METHODS;
/** What the server sends (the params' input). */
export type HermesHomeParams<M extends HermesHomeMethod> = z.input<(typeof HERMES_HOME_METHODS)[M]['params']>;
/** What a step receives once its params are checked (their output). */
export type HermesHomeArgs<M extends HermesHomeMethod> = z.output<(typeof HERMES_HOME_METHODS)[M]['params']>;
export type HermesHomeResult<M extends HermesHomeMethod> = z.output<
  (typeof HERMES_HOME_METHODS)[M]['result']
>;

export const HermesHomeMethodName = z.enum(
  Object.keys(HERMES_HOME_METHODS) as [HermesHomeMethod, ...HermesHomeMethod[]],
);

export const HermesHomeRequest = z.object({
  id: z.string().min(1).max(64),
  method: HermesHomeMethodName,
  /** Validated against `HERMES_HOME_METHODS[method].params`. */
  params: z.unknown(),
});
export type HermesHomeRequest = z.infer<typeof HermesHomeRequest>;

export const HermesHomeAnswer = z.discriminatedUnion('ok', [
  z.object({ id: z.string().max(64), ok: z.literal(true), result: z.unknown() }),
  z.object({
    id: z.string().max(64),
    ok: z.literal(false),
    code: HermesHomeErrorCode,
    error: z.string().max(1_000),
  }),
]);
export type HermesHomeAnswer = z.infer<typeof HermesHomeAnswer>;

export const hermesHomeEndpoints = {
  poll: endpoint({
    id: 'hermes.poll',
    method: 'POST',
    path: '/hermes/poll',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'Long-poll for Hermes-home steps to run (memory, sessions, skills, archives).',
    body: z.object({ waitMs: z.number().int().min(0).max(30_000).optional() }),
    response: z.object({ requests: z.array(HermesHomeRequest).max(64) }),
  }),
  answer: endpoint({
    id: 'hermes.answer',
    method: 'POST',
    path: '/hermes/answer',
    base: RUNNER_PREFIX,
    auth: 'runner',
    summary: 'The result of one Hermes-home step (`HERMES_HOME_METHODS[method].result`), or why it failed.',
    body: HermesHomeAnswer,
    response: z.object({ ok: z.boolean() }),
  }),
};
