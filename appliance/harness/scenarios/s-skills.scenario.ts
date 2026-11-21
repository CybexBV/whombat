/**
 * (s) Skills and memory from Hermes, and spend, of the Whombat's one agent on the managed stack (contracts ≥ 0.125.0,
 * CT-1200…CT-1205, CT-1210…CT-1216, 3.0.0 CT-1570…CT-1581; Whombat hermes-engine.md HE-19, HE-38, HE-39, HE-S111,
 * HE-S125, HE-S126, HE-S131, HE-S134, one-person.md OP-08, one-agent.md OA-18, spend.md SP-01…SP-03; appliance IN-91,
 * IN-391, IN-409). A Whombat is one person's: its Hermes has one profile in Hermes's own layout, the default profile at
 * `WHOMBAT_HERMES_ROOT`, with one skills list in its `skills/` (Hermes's built-ins, hub installs and what the agent
 * learned) and the person's memory in its `memories/`. Settings → Skills and memory read Hermes's files through the
 * runner's Hermes-home service, so the environment's runner runs for steps 1–2; the harness writes a learned skill into
 * the profile as Hermes's `skill_manage` would. Hermes's built-ins, the switch in its config and its scan of an edit
 * need Hermes's own code, which the scripted Hermes doesn't have: they are scenario k's skills steps, in the live-agent
 * environment (`k-live-skills.scenario.ts`).
 *
 * 1. A skill the agent learned is in the one list (`learned`, on) and `skills.librarySkill` reads its text; removed
 *    (`skills.libraryRemove`), it is gone from the list and the folder.
 * 2. Memory and notes are the person's: what they write about themselves (`memory.write user`) is in `memory.mine` and
 *    the profile's `USER.md`; the agent's notes (`memory.setNotes`) read back (`memory.notes`). Both are put back.
 * 3. Spend (SP-01): a turn the harness reports (as the runner, IN-64) is in the totals of every window, and there are
 *    no by-agent rows (there is one agent).
 *
 * It writes into Hermes's profile and stops the runner for step 3, so never on a public instance.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/dev/env.ts';
import { startService, stopService } from '../src/dev/restart.ts';
import { persistLayout } from '../src/dev/services.ts';
import { publicUrls } from '../src/lib/paths.ts';
import { contractsAtLeast } from '../src/manifest/version.ts';
import { type ClaimedTurn, harnessRunner } from '../src/scenario-kit/agent-turn.ts';
import type { ApplianceSession, OperationResponse } from '../src/scenario-kit/app-client.ts';
import { blocked, note } from '../src/scenario-kit/report.ts';
import { ensureSlice, ownerSession } from '../src/scenario-kit/slice.ts';
import { type Agent, ensureWorkspace, type Workspace } from '../src/scenario-kit/work.ts';

/** Skills from Hermes (contracts 0.125, CT-1210): Settings → Skills on Hermes's skills and learned skills. */
const enabled = contractsAtLeast('0.125.0');
const GAP = 'whombat-appliance/s-skills-environment';
const SKILLS = 'whombat-runtime/skills';
const MEMORY = 'whombat-runtime/memory';
const SPEND = 'whombat-runtime/spend';
/** The category the harness files its learned skills under, as the agent would choose one. */
const CATEGORY = 'harness';

const suffix = randomBytes(3).toString('hex');
const LEARNED = `release-check-${suffix}`;

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
interface Input {
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
}
/** A row of Settings → Skills (`SkillLibraryItem`, CT-1210, CT-1571), the fields read here. */
interface Item {
  name: string;
  category: string | null;
  /** Hermes's built-in, installed from the hub, or learned (CT-1570). */
  origin: string;
  enabled: boolean;
  status: string;
  version: string;
}
/** One memory file's view (`MemoryFileView`), the fields read here. */
interface MemoryFile {
  text: string;
  used: number;
  limit: number;
  version: string;
}
/** `memory.mine` (`PersonMemory`): what the agent remembers about working with the person and about them. */
interface Memory {
  memory: MemoryFile;
  user: MemoryFile;
}
/** `memory.notes` (`AgentNotes`), the fields read here. */
interface Notes {
  text: string;
}
const WINDOWS = ['today', 'week', 'month'] as const;
type Window = (typeof WINDOWS)[number];
interface Totals {
  turns: number;
  inputTokens: number;
  outputTokens: number;
}
/** `spend.overview` (`SpendOverview`), the fields read here: the totals of each window. */
interface Spend {
  totals: Record<Window, Totals>;
}

let skip: string | null = null;
let runtimeUrl = '';
let owner: ApplianceSession;
let w: Workspace;
let agent: Agent;
let runnerStopped = false;
const open: ClaimedTurn[] = [];
/** Learned skills this run wrote, removed again at the end. */
const learnedHere = new Set<string>();

const inBurrow = (extra: Record<string, unknown> = {}) => ({ burrow: w.slug, ...extra });
/** Hermes's default profile, the person's (CT-1576). */
const hermes = () => persistLayout().hermes;
/** The profile's one skills list (CT-1570). */
const skillsDir = () => join(hermes(), 'skills');

async function call(s: ApplianceSession, id: string, method: Method, input: Input = {}) {
  return s.call({ id, method }, { params: input.params ?? {}, query: input.query ?? {}, body: input.body });
}

async function ok<T>(s: ApplianceSession, id: string, method: Method, input: Input = {}): Promise<T> {
  const r = await call(s, id, method, input);
  if (r.status !== 200 && r.status !== 201)
    throw new Error(`${id}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body as T;
}

const errorOf = (r: OperationResponse) =>
  (r.body as { error?: { code?: string; message?: string; details?: { code?: string } } } | null)?.error;

/** The op doesn't exist on this runtime, or the runner doesn't serve the Hermes home (`unavailable`, HE-S133). */
function needsOp(ctx: Parameters<typeof blocked>[0], gap: string, id: string, r: OperationResponse): void {
  const code = errorOf(r)?.code;
  if (r.status === 404 || r.status === 405 || code === 'unknown_op' || code === 'unavailable')
    blocked(ctx, gap, `${id} answered ${r.status} ${code ?? ''}`);
}

function guard(ctx: Parameters<typeof blocked>[0]): void {
  if (skip) blocked(ctx, GAP, skip);
}

async function library(s: ApplianceSession): Promise<Item[]> {
  return (await ok<{ items: Item[] }>(s, 'skills.library', 'GET', { params: inBurrow() })).items;
}

/**
 * Where a skill's folder (with its `SKILL.md`) is under `root`, relative to it: `<category>/<name>` or `<name>`. Empty
 * when it isn't there.
 */
function foldersOf(root: string, name: string): string[] {
  const out: string[] = [];
  const look = (rel: string, depth: number) => {
    const dir = join(root, rel);
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const path = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === name && existsSync(join(root, path, 'SKILL.md'))) out.push(path);
      else if (depth > 0) look(path, depth - 1);
    }
  };
  look('', 2);
  return out.sort();
}

/** A learned skill's `SKILL.md`, as the harness wrote it. */
const skillFile = (name: string) => join(skillsDir(), CATEGORY, name, 'SKILL.md');

/** A skill as Hermes's `skill_manage` writes one into the profile (`skills/<category>/<name>/SKILL.md`). */
function learnSkill(name: string, description: string, body: string[]): void {
  mkdirSync(join(skillsDir(), CATEGORY, name), { recursive: true, mode: 0o700 });
  writeFileSync(
    skillFile(name),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.join('\n')}\n`,
    {
      mode: 0o600,
    },
  );
  learnedHere.add(name);
}

const row = (items: Item[], name: string) => items.find((x) => x.name === name);

beforeAll(async () => {
  if (!enabled) return;
  const state = loadEnv();
  if (!state?.runtime) throw new Error('no environment (dev/up)');
  runtimeUrl = state.runtime.url;
  if (publicUrls) {
    skip = `this environment is public (${publicUrls.web}); scenario s writes into Hermes's profile and stops the runner`;
    return;
  }
  const slice = await ensureSlice();
  owner = (await ownerSession(slice)).session;
  w = await ensureWorkspace(owner, `Skills ${suffix}`);
  agent = w.agent;
}, 300_000);

afterAll(async () => {
  if (!enabled || skip) return;
  for (const t of [...open]) await t.complete('failed', 'scenario s: stopped early').catch(() => {});
  if (runnerStopped) await startService('runner').catch(() => {});
  // What this run learned goes again.
  for (const name of learnedHere)
    await call(owner, 'skills.libraryRemove', 'POST', { params: inBurrow(), body: { name } }).catch(() => {});
  try {
    owner?.close('closed');
  } catch {
    // already closed
  }
}, 120_000);

describe.skipIf(!enabled)('s skills and spend', () => {
  it('1 a skill the agent learned is in the one list and reads back; removed, it is gone', async (ctx) => {
    guard(ctx);
    learnSkill(LEARNED, 'Check a release candidate against the release checklist before it ships.', [
      '# Release check',
      '',
      '1. Read the checklist in the plan or the chat.',
      '2. Run the test suite and note failures.',
      '3. Report each checklist item as done, missing or failing.',
    ]);
    const item = row(await library(owner), LEARNED);
    const read = await call(owner, 'skills.librarySkill', 'GET', {
      params: inBurrow(),
      query: { name: LEARNED },
    });
    needsOp(ctx, SKILLS, 'skills.librarySkill', read);
    const text = (read.body as { text?: string } | null)?.text ?? '';
    const removed = await call(owner, 'skills.libraryRemove', 'POST', {
      params: inBurrow(),
      body: { name: LEARNED },
    });
    if (removed.status === 200) learnedHere.delete(LEARNED);
    const afterRemove = await library(owner);
    note(ctx, 'learned skill', {
      item: item ?? null,
      read: { status: read.status, mentionsChecklist: text.includes('checklist') },
      removed: `${removed.status} ${errorOf(removed)?.code ?? ''}`,
      folders: foldersOf(skillsDir(), LEARNED),
    });
    expect(item).toMatchObject({ name: LEARNED, origin: 'learned', category: CATEGORY, enabled: true });
    expect(read.status).toBe(200);
    expect(text).toContain('checklist');
    expect(removed.status).toBe(200);
    expect(row(afterRemove, LEARNED)).toBeUndefined();
    expect(foldersOf(skillsDir(), LEARNED)).toEqual([]);
  });

  it('2 memory and notes are the person’s: written, read back, and put back as they were', async (ctx) => {
    guard(ctx);
    const entry = `Prefers short answers (harness ${suffix}).`;
    const before = await call(owner, 'memory.mine', 'GET', { params: inBurrow() });
    needsOp(ctx, MEMORY, 'memory.mine', before);
    const was = (before.body as Memory).user;
    // Hermes's own format: entries joined by `\n§\n` (CT-1200).
    const wrote = await call(owner, 'memory.write', 'PUT', {
      params: inBurrow({ file: 'user' }),
      body: { text: was.text ? `${was.text}\n§\n${entry}` : entry, ifVersion: was.version },
    });
    const mine = (wrote.body as Memory | null)?.user;
    const onDisk = join(hermes(), 'memories', 'USER.md');
    const file = existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : null;
    const read = await ok<Memory>(owner, 'memory.mine', 'GET', { params: inBurrow() });
    const notesBefore = await ok<Notes>(owner, 'memory.notes', 'GET', { params: inBurrow() });
    const notes = `The office is closed on Fridays (harness ${suffix}).`;
    const set = await ok<Notes>(owner, 'memory.setNotes', 'PUT', {
      params: inBurrow(),
      body: { text: notes },
    });
    const notesRead = await ok<Notes>(owner, 'memory.notes', 'GET', { params: inBurrow() });
    // As they were.
    await ok(owner, 'memory.setNotes', 'PUT', { params: inBurrow(), body: { text: notesBefore.text } });
    const back = await ok<Memory>(owner, 'memory.write', 'PUT', {
      params: inBurrow({ file: 'user' }),
      body: { text: was.text },
    });
    note(ctx, 'memory and notes', {
      wrote: { status: wrote.status, code: errorOf(wrote)?.code, used: mine?.used, limit: mine?.limit },
      inUserMd: file?.includes(entry) ?? null,
      readBack: read.user.text.includes(entry),
      notes: { set: set.text === notes, readBack: notesRead.text === notes },
      putBack: back.user.text === was.text,
    });
    expect(wrote.status).toBe(200);
    expect(mine?.text).toContain(entry);
    expect(file).toContain(entry);
    expect(read.user.text).toContain(entry);
    expect(set.text).toBe(notes);
    expect(notesRead.text).toBe(notes);
    expect(back.user.text).toBe(was.text);
  });

  it('3 spend: a reported turn is in the totals of every window', async (ctx) => {
    guard(ctx);
    const overview = async (): Promise<Spend> => {
      const r = await call(owner, 'spend.overview', 'GET', { params: inBurrow() });
      needsOp(ctx, SPEND, 'spend.overview', r);
      if (r.status !== 200)
        blocked(ctx, SPEND, `spend.overview answered ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
      return r.body as Spend;
    };
    const tokens = (t: Totals) => t.inputTokens + t.outputTokens;
    const before = await overview();
    // The harness takes the runner's place for one turn and reports what it used, as a provider does (SP-01).
    await stopService('runner');
    runnerStopped = true;
    const runner = harnessRunner(runtimeUrl);
    const sent = await ok<{ message: { id: string } }>(owner, 'messages.send', 'POST', {
      params: inBurrow({ conversationId: w.conversationId }),
      body: { text: 'is the release ready?' },
    });
    const turn = await runner.claim(
      (c) =>
        c.dispatch.agentId === agent.id &&
        (c.dispatch.messageId === sent.message.id || c.dispatch.threadRootId === sent.message.id),
      'the agent’s turn',
      90_000,
    );
    open.push(turn);
    const reported = 4_000;
    await turn.complete('done', undefined, {
      inputTokens: 3_000,
      outputTokens: 1_000,
      costUsd: reported / 1e6,
    });
    open.splice(open.indexOf(turn), 1);
    await startService('runner');
    runnerStopped = false;
    const after = await overview();
    const sums = (o: Spend) =>
      Object.fromEntries(WINDOWS.map((x) => [x, { turns: o.totals[x].turns, tokens: tokens(o.totals[x]) }]));
    note(ctx, 'spend', { before: sums(before), after: sums(after), reported, byAgent: 'byAgent' in after });
    expect('byAgent' in after).toBe(false);
    for (const win of WINDOWS) {
      expect(after.totals[win].turns, `turns, ${win}`).toBeGreaterThanOrEqual(before.totals[win].turns + 1);
      expect(tokens(after.totals[win]), `tokens, ${win}`).toBeGreaterThanOrEqual(
        tokens(before.totals[win]) + reported,
      );
    }
    expect(tokens(after.totals.today)).toBeLessThanOrEqual(tokens(after.totals.month));
  });
});
