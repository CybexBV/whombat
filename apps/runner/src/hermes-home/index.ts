/**
 * The runner's Hermes-home service (hermes-engine.md HE-38, HE-S110…HE-S124; one-person.md OP-08): the only code that
 * reads or changes the person's Hermes home for the server — its memory files, sessions, skills, and archives for
 * backups. One module
 * per area (`memory.ts`, `sessions.ts`, `archive.ts`, `skills.ts`); the steps and their schemas are the protocol's
 * (contracts 0.125 `HERMES_HOME_METHODS`). `HermesHomeWorker` (`worker.ts`) takes the server's
 * requests over the long poll; tests may call `HermesHomeService.handle` directly.
 */
import {
  HERMES_HOME_METHODS,
  type HermesHomeAnswer,
  type HermesHomeMethod,
  type HermesHomeRequest,
} from '@whombat/core';
import { archiveHandlers, sweepTransfers } from './archive';
import { HermesHomeContext, HermesHomeError, type HermesHomeOptions } from './context';
import type { HermesHomeHandler } from './handlers';
import { memoryHandlers } from './memory';
import { sessionDeleter, sessionHandlers } from './sessions';
import { skillsHandlers } from './skills';

export { HermesHomeContext, HermesHomeError, type HermesHomeOptions } from './context';
export { syncSkills, withSkills } from './skills';
export { type FakeBuiltin, type FakeHermesSkills, type FakeHubSkill, fakeHermesSkills } from './skills-fake';
export type { HermesSkillsStep, HermesSkillsSteps } from './skills-plugin';
export { HermesHomeWorker, type HermesHomeWorkerOptions } from './worker';

/** Every step, by method: what the protocol lists and nothing else. */
const HANDLERS: { [M in HermesHomeMethod]: HermesHomeHandler<M> } = {
  ...memoryHandlers,
  ...sessionHandlers,
  ...archiveHandlers,
  ...skillsHandlers,
};

export class HermesHomeService {
  readonly ctx: HermesHomeContext;

  constructor(options: HermesHomeOptions) {
    this.ctx = new HermesHomeContext(options);
  }

  /** Runs one step: its params checked against the protocol first; a failure answers with its code. */
  async handle(req: Pick<HermesHomeRequest, 'id' | 'method' | 'params'>): Promise<HermesHomeAnswer> {
    const schema = HERMES_HOME_METHODS[req.method];
    if (!schema)
      return { id: req.id, ok: false, code: 'invalid', error: `unknown step ${String(req.method)}` };
    const parsed = schema.params.safeParse(req.params);
    if (!parsed.success)
      return { id: req.id, ok: false, code: 'invalid', error: `bad params for ${req.method}` };
    try {
      const handler = HANDLERS[req.method] as HermesHomeHandler<HermesHomeMethod>;
      const result = await handler(this.ctx, parsed.data as never);
      return { id: req.id, ok: true, result };
    } catch (err) {
      if (err instanceof HermesHomeError)
        return { id: req.id, ok: false, code: err.code, error: err.message.slice(0, 1_000) };
      this.ctx.log('warn', `hermes-home · ${req.method} failed: ${(err as Error).message}`);
      return { id: req.id, ok: false, code: 'failed', error: (err as Error).message.slice(0, 1_000) };
    }
  }

  /** What waits in the background: sessions still to delete, transfers nobody finished (the worker's minute). */
  async sweep(): Promise<void> {
    await sessionDeleter(this.ctx).sweep();
    await sweepTransfers(this.ctx);
  }

  /** Waits for background deletions running now (tests, shutdown). */
  idle(): Promise<void> {
    return sessionDeleter(this.ctx).idle();
  }
}
