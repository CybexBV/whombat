/**
 * What every area of the Hermes-home service shares (hermes-engine.md HE-38, HE-S110…; one-person.md OP-08, OP-17): the
 * person's Hermes home (the root, Hermes's default profile) with its skills folder and the outsiders' beside it
 * (`profiles/_feedback`), the `hermes` executable, the profile lock (HE-S19: never a step while Hermes runs on the
 * profile), and the error a step answers with. The session steps and a profile's archive name the home (contracts 3.0
 * `HermesHome`); memory and skills are the person's.
 */
import { basename, dirname, join } from 'node:path';
import {
  hermesFeedbackProfile,
  hermesPersonProfile,
  hermesPythonBeside,
  LockBusyError,
  lockHermesProfile,
  prepareHermesProfile,
} from '@whombat/agent-runtime';
import type { HermesHome, HermesHomeErrorCode } from '@whombat/core';
import type { HermesSkillsSteps } from './skills-plugin';

/** A step's failure, with the code the server acts on (`HermesHomeErrorCode`). */
export class HermesHomeError extends Error {
  constructor(
    readonly code: HermesHomeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HermesHomeError';
  }
}

export interface HermesHomeOptions {
  /** `WHOMBAT_HERMES_ROOT`: the person's home, with `locks/` and the service's own `transfers/` and `pending/`. */
  root: string;
  /** The `hermes` executable (`hermesBin`), for its own commands (`hermes sessions delete`). */
  bin: string;
  /** Whose `PATH` finds Hermes's interpreter (default `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** How long a step waits for a turn to let go of the profile before it answers `busy` (default 5 s). */
  lockWaitMs?: number;
  /** The person's skills folder (OP-08), default `<root>/skills`; its archive is `home.export` of `{kind: 'skills'}`. */
  skillsDir?: string;
  /**
   * The runner's own state for Hermes's skills steps (hermes-skills.md HSK-S03): the skills home, an empty `gh`
   * config and the steps' `HOME`. Outside the root (the runner passes `<runner state>/hermes-skills`); default
   * `<root>-skills` beside it.
   */
  skillsState?: string;
  /** The Python with Hermes and the plugin; default the one beside `bin` (`hermesPythonBeside`), none for a stand-in. */
  python?: string | null;
  /** The plugin's skills steps; default the plugin through `python`. Tests hand in `fakeHermesSkills`. */
  skillsSteps?: HermesSkillsSteps;
  /**
   * The person's pod (hermes-native.md HN-W11): a step quiesces it first — no new turn, the running ones end, the pod
   * stops and lets go of the profile's lock — and a `polite` one is refused while a turn runs there.
   */
  pods?: ProfilePods;
  log?: (level: 'info' | 'warn', msg: string) => void;
}

/** What a step needs of the pod (`PodManager`). */
export interface ProfilePods {
  quiesce(signal?: AbortSignal): Promise<() => void>;
  busy(): boolean;
}

export class HermesHomeContext {
  readonly root: string;
  readonly bin: string;
  readonly env: NodeJS.ProcessEnv;
  readonly lockWaitMs: number;
  /** The person's Hermes home. */
  readonly profile: string;
  readonly skillsDir: string;
  readonly skillsState: string;
  readonly python: string | null;
  readonly skillsSteps: HermesSkillsSteps | null;
  readonly pods: ProfilePods | null;
  readonly log: (level: 'info' | 'warn', msg: string) => void;

  constructor(options: HermesHomeOptions) {
    this.root = options.root;
    this.bin = options.bin;
    this.env = options.env ?? process.env;
    this.lockWaitMs = options.lockWaitMs ?? 5_000;
    this.profile = hermesPersonProfile(options.root);
    this.skillsDir = options.skillsDir ?? join(this.profile, 'skills');
    this.skillsState = options.skillsState ?? join(dirname(options.root), `${basename(options.root)}-skills`);
    this.python = options.python !== undefined ? options.python : hermesPythonBeside(options.bin, this.env);
    this.skillsSteps = options.skillsSteps ?? null;
    this.pods = options.pods ?? null;
    this.log = options.log ?? (() => {});
  }

  /** The service's own private directories under the root. */
  dir(name: 'transfers' | 'pending'): string {
    return join(this.root, name);
  }

  /** A home's directory: the person's profile, or the outsiders'. */
  profileDir(home: HermesHome = 'person'): string {
    return home === 'person' ? this.profile : hermesFeedbackProfile(this.root);
  }

  /**
   * Runs `fn` on a home (made private if missing; the person's unless `home` says) while holding its lock, so no Hermes
   * runs on it meanwhile; `busy` when a turn holds it longer than `waitMs`, or (`polite`) while a turn waits for it.
   */
  async withProfile<T>(
    fn: (dir: string) => Promise<T>,
    options: { waitMs?: number; holder?: string; polite?: boolean; home?: HermesHome } = {},
  ): Promise<T> {
    const dir = this.profileDir(options.home);
    await prepareHermesProfile(this.root, dir);
    const busy = () => new HermesHomeError('busy', 'The agent is working in this home right now.');
    // The person's pod first (HN-W11): its Hermes holds the profile while it lives. The outsiders' has none.
    const pods = dir === this.profile ? this.pods : null;
    if (options.polite && pods?.busy()) throw busy();
    let lift: (() => void) | null = null;
    if (pods) {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(busy()), options.waitMs ?? this.lockWaitMs);
      timer.unref?.();
      try {
        lift = await pods.quiesce(stop.signal);
      } catch (err) {
        throw err instanceof HermesHomeError ? err : busy();
      } finally {
        clearTimeout(timer);
      }
    }
    try {
      let lock: Awaited<ReturnType<typeof lockHermesProfile>>;
      try {
        lock = await lockHermesProfile(this.root, dir, {
          holder: options.holder ?? 'hermes-home',
          waitMs: options.waitMs ?? this.lockWaitMs,
          ...(options.polite ? { polite: true } : {}),
        });
      } catch (err) {
        if (err instanceof LockBusyError) throw busy();
        throw err;
      }
      try {
        return await fn(dir);
      } finally {
        await lock.release();
      }
    } finally {
      lift?.();
    }
  }

  /** The environment of Hermes's own commands: its interpreter on `PATH`, the home, nothing of the runner's. */
  hermesEnv(home: string): NodeJS.ProcessEnv {
    return {
      PATH: this.env.PATH ?? '/usr/bin:/bin',
      HOME: join(this.root, 'check'),
      HERMES_HOME: home,
      LANG: 'C.UTF-8',
    };
  }
}
