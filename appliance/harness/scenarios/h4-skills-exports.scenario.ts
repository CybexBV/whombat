/**
 * (h4) Large reads over the session, and no skill archives (contracts 0.125.0 CT-1210…CT-1212, 2.0 CT-1417, CT-1418;
 * 0.5.4 CT-55, CT-56; parity G-03, G-04, G-05; Whombat hermes-skills.md HSK-08, hermes-engine.md HE-S133, HE-S134):
 * - Add skills from an archive is gone (HSK-08): `skills.stage` and the pack ops' `packs.stage` answer `unknown_op`. A
 *   person's own skill comes in Hermes's way, learned by the agent: the harness writes one into Hermes's profile as
 *   `skill_manage` would (`skills/<category>/<name>/SKILL.md` and about 200 KiB of reference files), and Settings →
 *   Skills (`skills.library`, read through an export stream as the client does, CT-1418) lists it;
 * - a read larger than one 64 KiB message: one of that skill's reference files (`skills.librarySkillFile`) answers
 *   `too_large` (`use_export_stream`) when asked in one message; the client reads it through an export stream, and its
 *   own call does so by itself, with the file's text intact;
 * - the audit CSV (`audit.export`, a `text/csv` operation) is only ever read through an export stream.
 *
 * Until contracts 2.0 the large skill came in as a staged .tar.gz archive (`importSkillArchive`, `skills.importPreview`,
 * `skills.importCommit`); the replacement is docs/decisions/integration.md IN-750. The runner serves Hermes's skills,
 * so it must be running.
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { persistLayout } from '../src/dev/services.ts';
import { contractsAtLeast } from '../src/manifest/version.ts';
import { type ApplianceSession, type OperationResponse, readExport } from '../src/scenario-kit/app-client.ts';
import { note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession, type SliceState } from '../src/scenario-kit/slice.ts';
import { api, ensureWorkspace, type Workspace } from '../src/scenario-kit/work.ts';

/** Settings → Skills on Hermes's skills, its large reads through an export stream (contracts 2.0, CT-1418). */
const enabled = contractsAtLeast('2.0.0');
const suffix = randomBytes(3).toString('hex');
/** The learned skill with the reference tables. */
const TABLES = `harness-tables-${suffix}`;
/** The category the harness files it under, as the agent would choose one. */
const CATEGORY = 'harness';
const TABLE_PATH = 'references/table-0.md';

/** A row of Settings → Skills (`SkillLibraryItem`, CT-1210, CT-1571), the fields read here. */
interface LibraryItem {
  name: string;
  category: string | null;
  origin: string;
  status: string;
}

let slice: SliceState;
let owner: ApplianceSession;
let w: Workspace;
let learned = false;
/** The text of `TABLES`' first reference file, as the harness wrote it. */
let table = '';

/** The learned skill's folder in Hermes's profile (`skills/<category>/<name>`, CT-1570). */
const skillDir = () => join(persistLayout().hermes, 'skills', CATEGORY, TABLES);

beforeAll(async () => {
  if (!enabled) return;
  slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
  w = await ensureWorkspace(owner, `Skills ${suffix}`);
});

afterAll(async () => {
  if (!enabled || !learned) return;
  // The skill is in every turn's Hermes: this run's goes again.
  await owner
    .call(
      { id: 'skills.libraryRemove', method: 'POST' },
      { params: { burrow: w.slug }, query: {}, body: { name: TABLES } },
    )
    .catch(() => {});
  rmSync(skillDir(), { recursive: true, force: true });
});

/**
 * A skill as Hermes's `skill_manage` writes one, with two reference files of about 200 KiB of hex text each (no
 * secret shapes, each under Hermes's file limit).
 */
function learnTables(): void {
  const dir = skillDir();
  mkdirSync(join(dir, 'references'), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${TABLES}\ndescription: Reference tables for the integration harness.\n---\n\nUse the reference tables in references/.\n`,
    { mode: 0o600 },
  );
  for (let i = 0; i < 2; i++) {
    const lines: string[] = [];
    for (let n = 0; n < (200 * 1024) / 65; n++) lines.push(randomBytes(32).toString('hex'));
    const text = `${lines.join('\n')}\n`;
    if (i === 0) table = text;
    writeFileSync(join(dir, 'references', `table-${i}.md`), text, { mode: 0o600 });
  }
}

const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const errorCode = (r: OperationResponse) =>
  (r.body as { error?: { code?: string } } | null)?.error?.code ?? null;

describe.skipIf(!enabled)('h4 large reads, and no skill archives', () => {
  it('no archive import (skills.stage, packs.stage unknown); a learned skill with 400 KiB of references is in the library', async (ctx) => {
    // Add skills from an archive is gone (Whombat hermes-skills.md HSK-08), and packs with it (SST-09).
    const input = { burrow: w.slug, fileName: 'harness-skills.tar.gz', size: 1024, sha256: sha('x') };
    const skillStage = await owner.invoke(
      'skills.stage',
      { ...input, purpose: 'skill-archive' },
      { mutating: true },
    );
    const packStage = await owner.invoke('packs.stage', { ...input, purpose: 'pack' }, { mutating: true });
    learnTables();
    learned = true;
    const library = await api<{ items: LibraryItem[] }>(owner, 'skills.library', 'GET', {
      params: { burrow: w.slug },
    });
    const listed = library.items.find((x) => x.name === TABLES);
    note(ctx, 'skills', {
      skillStage: { status: skillStage.status, code: errorCode(skillStage) },
      packStage: { status: packStage.status, code: errorCode(packStage) },
      listed,
      libraryItems: library.items.length,
    });
    expect(errorCode(skillStage)).toBe('unknown_op');
    expect(errorCode(packStage)).toBe('unknown_op');
    expect(listed).toMatchObject({ name: TABLES, origin: 'learned' });
  });

  it('a read over 64 KiB (a learned skill’s reference file) comes through an export stream; the audit CSV too', async (ctx) => {
    if (!learned) throw new Error('needs the learned skill of the first step');
    const input = {
      params: { burrow: w.slug },
      query: { name: TABLES, path: TABLE_PATH },
    };
    // One message can't carry it: the appliance says so…
    const direct = await owner.invoke('skills.librarySkillFile', input, { mutating: false });
    // …the export stream carries the answer (JSON)…
    const raw = await readExport(owner, 'skills.librarySkillFile', input);
    const streamed = JSON.parse(new TextDecoder().decode(raw.bytes)) as { path?: string; text?: string };
    // …and the client's call reads it through an export stream by itself, as the endpoint's answer (parity G-03).
    const viaCall = await owner.call(
      { id: 'skills.librarySkillFile', method: 'GET' },
      { ...input, body: undefined },
    );
    const called = (typeof viaCall.body === 'object' && viaCall.body ? viaCall.body : {}) as {
      path?: string;
      text?: string;
    };
    const csv = await owner.call(
      { id: 'audit.export', method: 'GET' },
      { params: { burrow: w.slug }, query: {}, body: undefined },
    );
    const text = String(csv.body ?? '');
    note(ctx, 'large reads', {
      direct: { status: direct.status, error: (direct.body as { error?: unknown })?.error },
      stream: {
        meta: raw.meta,
        bytes: raw.bytes.byteLength,
        path: streamed.path,
        textBytes: streamed.text?.length,
        sha256: sha(streamed.text ?? ''),
      },
      clientCall: { status: viaCall.status, path: called.path, textBytes: called.text?.length },
      original: { bytes: table.length, sha256: sha(table) },
      csv: {
        status: csv.status,
        bytes: text.length,
        header: text.split('\n')[0],
        rows: text.split('\n').length - 1,
      },
    });
    expect(direct.status).toBe(413);
    expect(JSON.stringify(direct.body)).toContain('use_export_stream');
    expect(raw.bytes.byteLength).toBeGreaterThan(64 * 1024);
    expect(streamed.path).toBe(TABLE_PATH);
    expect(sha(streamed.text ?? '')).toBe(sha(table));
    expect(viaCall.status).toBe(200);
    expect(called.path).toBe(TABLE_PATH);
    expect(sha(called.text ?? '')).toBe(sha(table));
    expect(csv.status).toBe(200);
    expect(text.split('\n')[0]).toMatch(/,/);
    expect(text.split('\n').length).toBeGreaterThan(2);
  });
});
