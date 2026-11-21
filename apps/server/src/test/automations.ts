/**
 * Test kit for automations: the seeded burrow on a throwaway database, services with a clock the test moves, a
 * "restart" (a brand-new service container and engine on the same database, as after a crash), and a
 * deterministic FAKE AGENT that answers an automation's dispatch the way a real one does (a reply in the thread
 * through the commit pipeline, then the dispatch completes) — no provider, no model.
 */
import { createHash } from 'node:crypto';
import {
  type AutomationDefinitionInput,
  type AutomationGrant,
  type AutomationRun,
  buildTemplate,
  definitionHash,
  type TemplateParams,
  validateDefinition,
} from '@whombat/core';
import { and, asc, eq, or } from 'drizzle-orm';
import { afterAll, beforeAll } from 'vitest';
import type { z } from 'zod';
import { createAutomation, publishAutomationDraft, setAutomationKeys } from '../automations/commands';
import { loadAutomationRow, loadRunRow, toRun } from '../automations/store';
import { sendMessage } from '../commands/messages';
import type { CommandDef, CommitOptions, CommitResult } from '../commit/types';
import { loadConfig } from '../config';
import { automationRuns, dispatches, messages } from '../db/schema/index';
import { MemoryMailer } from '../mail/mailer';
import { loadSeedWorld } from '../seed/load';
import { TEST_BURROW_ID, testWorld } from '../seed/test-world';
import { createServices, type Services } from '../services';
import { useTestDb } from './db';
import { testLogger } from './log';
import { agentTokenFor, type TestDispatchOptions } from './tokens';

export { IDS } from '../seed/test-world';

export interface AutomationWorld {
  readonly services: Services;
  burrowId: string;
  /** Now, as the services see it. */
  now(): Date;
  /** Moves the clock. */
  advance(ms: number): void;
  setNow(at: Date | string): void;
  commit<S extends z.ZodType, R>(
    actorId: string,
    command: CommandDef<S, R>,
    input: z.input<S>,
    options?: Partial<CommitOptions>,
  ): Promise<CommitResult<R>>;
  ok<S extends z.ZodType, R>(actorId: string, command: CommandDef<S, R>, input: z.input<S>): Promise<R>;
  /** A new service container and engine on the same database (a restart after a crash). */
  restart(): Promise<void>;
  /** Imports a definition as a draft and publishes it (by `by`, default Mara). Returns the automation id. */
  publish(
    definition: AutomationDefinitionInput | ReturnType<typeof buildTemplate>['definition'],
    options?: { by?: string; name?: string; grants?: AutomationGrant[]; enable?: boolean },
  ): Promise<string>;
  publishTemplate(
    params: TemplateParams,
    options?: { by?: string; grants?: AutomationGrant[] },
  ): Promise<string>;
  /** `definitionHash` of an automation's saved draft as it is now (what a person reviewing it would publish). */
  draftHash(automationId: string): Promise<string>;
  /** A turn of `agentId` in `conversationId` (for the person, unless `options` say otherwise): its dispatch id. */
  turn(agentId: string, conversationId: string, options?: TestDispatchOptions): Promise<string>;
  /** Runs the engine until nothing moves (bounded). */
  settle(times?: number): Promise<void>;
  runs(automationId: string): Promise<AutomationRun[]>;
  run(runId: string): Promise<AutomationRun>;
  /** FAKE AGENT: answers a queued automation dispatch with `text` in the prompt's thread, then completes it. */
  /** FAKE AGENT answers in its turn: one message, or several in order (a first line, then the answer). */
  fakeAgentReply(dispatchId: string, text: string | readonly string[]): Promise<void>;
  /**
   * FAKE AGENT at work: commits on `branch` land on (fake, in-memory) GitHub, as the runner pushes them after a coding
   * turn.
   */
  fakePush(repo: string, branch: string, message?: string): Promise<void>;
  /** Dispatches of a trigger kind in the burrow, oldest first. */
  dispatchesOf(trigger: 'automation' | 'mention'): Promise<(typeof dispatches.$inferSelect)[]>;
  messagesBy(authorId: string): Promise<(typeof messages.$inferSelect)[]>;
  /**
   * The messages of a run's own thread, its root first, oldest first: a run posts in its publisher's Chat or Feedback
   * room (automations/rooms.ts), so its thread is there, not under the message that triggered it. `authorId` keeps one
   * author's.
   */
  runThread(runId: string, authorId?: string): Promise<(typeof messages.$inferSelect)[]>;
}

export const START = '2026-09-24T08:00:00.000Z';

export function useAutomationWorld(options: { env?: Record<string, string> } = {}): AutomationWorld {
  const testDb = useTestDb();
  let services: Services | undefined;
  let now = Date.parse(START);
  const make = () => {
    const config = loadConfig({
      DATABASE_URL: testDb.url,
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      WHOMBAT_OUTBOUND_ALLOW_PRIVATE: '1',
      ...options.env,
    });
    return createServices({
      config,
      sql: testDb.sql,
      mailer: new MemoryMailer(),
      log: testLogger(),
      clock: () => new Date(now),
    });
  };
  beforeAll(async () => {
    services = make();
    await loadSeedWorld(services, testWorld());
  });
  afterAll(async () => {
    await services?.mailTriggers.stop();
    await services?.automations.close();
    await services?.background.settle();
    services?.runtime.close();
    services?.typing.close();
    await services?.github.close();
  });
  const get = () => {
    if (!services) throw new Error('not ready');
    return services;
  };
  const world: AutomationWorld = {
    get services() {
      return get();
    },
    burrowId: TEST_BURROW_ID,
    now: () => new Date(now),
    advance(ms) {
      now += ms;
    },
    setNow(at) {
      now = typeof at === 'string' ? Date.parse(at) : at.getTime();
    },
    async commit(actorId, command, input, extra = {}) {
      const result = await get().pipeline.commit(command, input, {
        burrowId: TEST_BURROW_ID,
        actorId,
        ...extra,
      });
      // Its badges, notifications and pushes are done when it returns, as when they held the commit (SV-02).
      await get().background.settle();
      return result;
    },
    async ok(actorId, command, input) {
      const res = await world.commit(actorId, command, input);
      if (res.status !== 'ok')
        throw new Error(`${command.name}: ${res.status} ${'message' in res ? res.message : ''}`);
      return res.result;
    },
    async restart() {
      const old = get();
      await old.mailTriggers.stop();
      await old.automations.close();
      old.runtime.close();
      old.typing.close();
      await old.github.close();
      services = make();
    },
    async publish(definition, options = {}) {
      const by = options.by ?? 'prn_mara';
      const { automationId } = await world.ok(by, createAutomation, {
        name: options.name ?? 'Test automation',
        source: {
          kind: 'import',
          file: {
            whombat: 'automation',
            name: options.name ?? 'Test automation',
            description: '',
            definition: JSON.parse(JSON.stringify(definition)),
          },
        },
      });
      if (options.grants) await world.ok(by, setAutomationKeys, { automationId, grants: options.grants });
      await world.ok(by, publishAutomationDraft, {
        automationId,
        enable: options.enable ?? true,
        definitionHash: await world.draftHash(automationId),
      });
      return automationId;
    },
    async publishTemplate(params, options = {}) {
      const file = buildTemplate(params);
      return world.publish(file.definition, { ...options, name: file.name });
    },
    async draftHash(automationId) {
      const row = await loadAutomationRow(get().db, TEST_BURROW_ID, automationId);
      const check = validateDefinition(row.draftJson);
      if (!check.ok)
        throw new Error(`the draft of ${automationId} is not valid: ${check.problems.join(' ')}`);
      return definitionHash(check.definition);
    },
    async turn(agentId, conversationId, options = {}) {
      return (await agentTokenFor(get(), TEST_BURROW_ID, agentId, conversationId, options)).dispatchId;
    },
    async settle(times = 6) {
      for (let i = 0; i < times; i++) await get().automations.tick();
    },
    async runs(automationId) {
      const rows = await get()
        .db.select()
        .from(automationRuns)
        .where(eq(automationRuns.automationId, automationId))
        .orderBy(asc(automationRuns.createdAt), asc(automationRuns.number));
      return Promise.all(rows.map((r) => toRun(get().db, r)));
    },
    async run(runId) {
      return toRun(get().db, await loadRunRow(get().db, runId));
    },
    async fakeAgentReply(dispatchId, text) {
      const s = get();
      const [d] = await s.db.select().from(dispatches).where(eq(dispatches.id, dispatchId));
      if (!d) throw new Error(`no dispatch ${dispatchId}`);
      for (const one of typeof text === 'string' ? [text] : text) {
        const res = await s.pipeline.commit(
          sendMessage,
          {
            conversationId: d.conversationId,
            text: one,
            ...(d.threadRootId ? { threadRootId: d.threadRootId } : {}),
          },
          { burrowId: d.burrowId, actorId: d.agentId },
        );
        if (res.status !== 'ok') throw new Error(`fake agent could not reply: ${res.status}`);
      }
      await s.runtime.finalize(dispatchId, { outcome: 'done' });
    },
    async fakePush(repo, branch, message = 'Fix it') {
      const fake = get().github.fake;
      if (!fake) throw new Error('no FakeGitHub');
      const sha = createHash('sha1').update(`${repo}:${branch}:${message}:${now}`).digest('hex');
      await fake.simulatePush({ repo, branch, commits: [{ sha, message }] });
    },
    async dispatchesOf(trigger) {
      return get()
        .db.select()
        .from(dispatches)
        .where(and(eq(dispatches.burrowId, TEST_BURROW_ID), eq(dispatches.trigger, trigger)))
        .orderBy(asc(dispatches.createdAt));
    },
    async messagesBy(authorId) {
      return get()
        .db.select()
        .from(messages)
        .where(eq(messages.authorId, authorId))
        .orderBy(asc(messages.ord));
    },
    async runThread(runId, authorId) {
      const run = await loadRunRow(get().db, runId);
      const root = run.threadRootId;
      if (!root) return [];
      const inThread = or(eq(messages.id, root), eq(messages.threadRootId, root));
      return get()
        .db.select()
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, run.conversationId),
            inThread,
            authorId ? eq(messages.authorId, authorId) : undefined,
          ),
        )
        .orderBy(asc(messages.ord));
    },
  };
  return world;
}
