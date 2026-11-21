/**
 * The release pipeline's records (UP-C1, IN-96, IN-115): each stage of `release/ship` writes one JSON file next to the
 * PROD release (`~/.cache/whombat-releases/<id>/`) and chains it to the record(s) it follows by their sha256. Two
 * branches follow build.json and run in parallel; promote.json joins them:
 *
 *   build.json ─┬─ gates.json → upgrade-gates.json ─┬─ promote.json
 *               └─ dev-soak.json ────────────────────┘
 *
 * Every record carries `chain: {stage, releaseId, twin, after, alsoAfter?, ok, complete, at}`: `after` (and
 * `alsoAfter`, promote.json's second parent) name the records it follows, file and sha256 (null for build.json); `ok`
 * whether what ran passed, `complete` whether nothing was skipped (a PROD promotion needs every record complete; DEV
 * takes an incomplete one, IN-96). A stage refuses to run when a record it follows is missing, names another release,
 * doesn't match the file (another build), or failed. Records of the single line before IN-115 (dev-soak.json after
 * upgrade-gates.json) still verify. Hashed, not signed: the operator's machine is trusted (UP-C1).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const STAGES = ['build', 'gates', 'upgrade-gates', 'dev-soak', 'promote'] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_FILE: Record<Stage, string> = {
  build: 'build.json',
  gates: 'gates.json',
  'upgrade-gates': 'upgrade-gates.json',
  'dev-soak': 'dev-soak.json',
  promote: 'promote.json',
};

/** What each stage's command is called, for messages. */
export const STAGE_COMMAND: Record<Stage, string> = {
  build: 'release/ship build',
  gates: 'release/ship validate',
  'upgrade-gates': 'release/ship validate',
  'dev-soak': 'release/ship publish-dev',
  promote: 'release/ship promote-prod',
};

/** The records each stage follows (IN-115): validate's branch and publish-dev's both start at build.json. */
export const AFTER: Record<Stage, readonly Stage[]> = {
  build: [],
  gates: ['build'],
  'upgrade-gates': ['gates'],
  'dev-soak': ['build'],
  promote: ['dev-soak', 'upgrade-gates'],
};

/** Links the single line before IN-115 wrote, still accepted: dev-soak.json after upgrade-gates.json. */
const LEGACY_AFTER: Partial<Record<Stage, readonly Stage[]>> = { 'dev-soak': ['upgrade-gates'] };

/** Every stage a record of `stage` needs before it, transitively. */
export function requiredBefore(stage: Stage): Set<Stage> {
  const out = new Set<Stage>();
  const walk = (s: Stage) => {
    for (const p of AFTER[s])
      if (!out.has(p)) {
        out.add(p);
        walk(p);
      }
  };
  walk(stage);
  return out;
}

export interface ChainLink {
  stage: Stage;
  file: string;
  sha256: string;
}

export interface Chain {
  stage: Stage;
  releaseId: string;
  /** The DEV twin's release id. */
  twin: string | null;
  after: ChainLink | null;
  /** The other records it follows (promote.json: upgrade-gates.json besides dev-soak.json). */
  alsoAfter?: ChainLink[];
  ok: boolean;
  complete: boolean;
  /** What was skipped or why it isn't ok, one line each. */
  notes: string[];
  at: string;
}

export interface ChainedRecord {
  chain: Chain;
  [k: string]: unknown;
}

export const sha256Hex = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');

export function recordPath(dir: string, stage: Stage): string {
  return join(dir, STAGE_FILE[stage]);
}

export function readRecord(dir: string, stage: Stage): { record: ChainedRecord; sha256: string } | null {
  const file = recordPath(dir, stage);
  if (!existsSync(file)) return null;
  const raw = readFileSync(file);
  return { record: JSON.parse(raw.toString('utf8')) as ChainedRecord, sha256: sha256Hex(raw) };
}

/** Writes a record atomically (the chain hashes the exact bytes). Returns the file's sha256. */
export function writeRecord(dir: string, stage: Stage, record: ChainedRecord): string {
  const file = recordPath(dir, stage);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(`${file}.tmp`, text);
  renameSync(`${file}.tmp`, file);
  return sha256Hex(text);
}

export class ChainError extends Error {
  override name = 'ChainError';
}

export interface Verified {
  stage: Stage;
  record: ChainedRecord;
  sha256: string;
}

/**
 * Checks the records `upTo` names and everything they follow, for `releaseId`: every record present, for this release,
 * ok, each link matching the bytes of the record it names, and every stage a record needs among what it follows.
 * Returns the records verified with their digests, in pipeline order (build.json first).
 */
export function verifyChain(dir: string, releaseId: string, upTo: Stage | readonly Stage[]): Verified[] {
  const memo = new Map<Stage, { v: Verified; has: Set<Stage> }>();
  for (const s of typeof upTo === 'string' ? [upTo] : upTo) verifyOne(dir, releaseId, s, memo);
  return STAGES.filter((s) => memo.has(s)).map((s) => (memo.get(s) as { v: Verified }).v);
}

function verifyOne(
  dir: string,
  releaseId: string,
  stage: Stage,
  memo: Map<Stage, { v: Verified; has: Set<Stage> }>,
): { v: Verified; has: Set<Stage> } {
  const hit = memo.get(stage);
  if (hit) return hit;
  const file = STAGE_FILE[stage];
  const r = readRecord(dir, stage);
  if (!r)
    throw new ChainError(`${file} is missing in ${dir}: run \`${STAGE_COMMAND[stage]} ${releaseId}\` first`);
  const c = r.record.chain;
  if (!c || c.stage !== stage)
    throw new ChainError(`${file} has no release/ship chain (made by hand or an older tool)`);
  if (c.releaseId !== releaseId)
    throw new ChainError(`${file} is the record of ${c.releaseId}, not ${releaseId}`);
  const links = [c.after, ...(c.alsoAfter ?? [])].filter(
    (l): l is ChainLink => l !== null && l !== undefined,
  );
  const has = new Set<Stage>();
  if (stage === 'build') {
    if (links.length) throw new ChainError(`${file} claims a record before it; build.json starts the chain`);
  } else {
    const allowed = [...AFTER[stage], ...(LEGACY_AFTER[stage] ?? [])];
    for (const l of links) {
      if (!allowed.includes(l.stage))
        throw new ChainError(`${file} follows ${STAGE_FILE[l.stage] ?? l.stage}, which no ${file} follows`);
      const p = verifyOne(dir, releaseId, l.stage, memo);
      if (p.v.sha256 !== l.sha256)
        throw new ChainError(
          `${file} follows another ${STAGE_FILE[l.stage]} (${l.sha256.slice(0, 12)}, now ${p.v.sha256.slice(0, 12)}): the release was rebuilt or revalidated since; run \`${STAGE_COMMAND[stage]} ${releaseId}\` again`,
        );
      has.add(l.stage);
      for (const s of p.has) has.add(s);
    }
    for (const need of requiredBefore(stage))
      if (!has.has(need)) {
        verifyOne(dir, releaseId, need, memo); // missing or failed: says so
        throw new ChainError(
          `${file} doesn't follow ${STAGE_FILE[need]}: run \`${STAGE_COMMAND[stage]} ${releaseId}\` again`,
        );
      }
  }
  if (!c.ok)
    throw new ChainError(
      `${file} failed (${c.notes.join('; ') || 'see the record'}): fix it and run \`${STAGE_COMMAND[stage]} ${releaseId}\` again`,
    );
  const out = { v: { stage, record: r.record, sha256: r.sha256 }, has };
  memo.set(stage, out);
  return out;
}

/** The chain head for a new record of `stage` after verifying every record it follows. */
export function nextChain(
  dir: string,
  releaseId: string,
  stage: Stage,
  fields: { twin: string | null; ok: boolean; complete: boolean; notes: string[]; at?: Date },
  /** The records it follows when not AFTER[stage] (a promotion without validation, IN-158). */
  after?: readonly Stage[],
): Chain {
  const parents = after ?? AFTER[stage];
  const chain = parents.length ? verifyChain(dir, releaseId, parents) : [];
  const links = parents.map((p) => {
    const v = chain.find((c) => c.stage === p);
    if (!v) throw new ChainError(`no ${STAGE_FILE[p]}`);
    return { stage: p, file: STAGE_FILE[p], sha256: v.sha256 };
  });
  return {
    stage,
    releaseId,
    twin: fields.twin,
    after: links[0] ?? null,
    ...(links.length > 1 ? { alsoAfter: links.slice(1) } : {}),
    ok: fields.ok,
    complete: fields.complete,
    notes: fields.notes,
    at: (fields.at ?? new Date()).toISOString(),
  };
}

/**
 * The record of `stage` when it and everything it follows verify, else null (with why): what `release/ship all` skips.
 */
export function doneRecord(
  dir: string,
  releaseId: string,
  stage: Stage,
): { chain: Verified[]; why: null } | { chain: null; why: string } {
  try {
    return { chain: verifyChain(dir, releaseId, stage), why: null };
  } catch (err) {
    return { chain: null, why: (err as Error).message };
  }
}

/** Every record up to `upTo` complete (nothing skipped): what a PROD promotion needs. */
export function incomplete(chain: { stage: Stage; record: ChainedRecord }[]): string[] {
  return chain
    .filter((c) => !c.record.chain.complete)
    .map((c) => `${STAGE_FILE[c.stage]}: ${c.record.chain.notes.join('; ') || 'incomplete'}`);
}
