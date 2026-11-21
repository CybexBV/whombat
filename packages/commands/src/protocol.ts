/**
 * What the agent's commands say to the runner (docs/decisions/one-person.md OP-07, OP-S107, OP-S112): one JSON line per
 * message, both ways.
 *
 * - `commands.sock` (the launcher, before and after a command): `CommandRequest` names the Hermes session, the folder
 *   and the argv; the runner answers `say` lines (a waiting line while a person is asked), then `run` (the wrapper's
 *   bubblewrap arguments, the command's environment and the turn's key files) or `refuse` (a line and an exit status).
 *   After the command the launcher sends `{exit}`, and the runner may `say` a line more (the same failure again, HC-02)
 *   before it closes.
 * - `agent.sock` (the `whombat` helper inside a command, RA-31): `notify` and `status`.
 */
import { z } from 'zod';

export const CommandRequest = z.object({
  v: z.literal(1),
  /** The Hermes session the command belongs to (`WHOMBAT_TURN_SESSION`); null: none was known. */
  session: z.string().min(1).max(200).nullable(),
  /** Where it runs (absolute). */
  cwd: z.string().min(1).max(4096),
  /** What runs inside the wrapper (Hermes's `bash -c <script>`). */
  argv: z
    .array(z.string().max(1024 * 1024))
    .min(1)
    .max(4096),
  /** Whether the launcher's stdin is a terminal. */
  tty: z.boolean(),
});
export type CommandRequest = z.infer<typeof CommandRequest>;

/** A key file of the turn (one-person.md OP-S109): a path under the keys folder, its mode, its bytes. */
export const KeyFile = z.object({
  path: z.string().max(200),
  mode: z.number().int().min(0).max(0o777),
  base64: z.string().max(400_000),
});
export type KeyFile = z.infer<typeof KeyFile>;

export const RunSpec = z.object({
  /** bubblewrap's arguments up to (not with) `--`; `--file <fd>` names the key files as fds from 3 on, in order. */
  bwrap: z.array(z.string()).max(2000),
  /** The command's whole environment. */
  env: z.record(z.string(), z.string()),
  /** The turn's key files, written on a tmpfs inside the wrapper (fd 3 + index). */
  keys: z.array(KeyFile).max(64),
});
export type RunSpec = z.infer<typeof RunSpec>;

/** The launcher's last message: how the command ended (128 + n for a signal). */
export const CommandExit = z.object({ exit: z.number().int().min(0).max(255) });

/** A notify's text at most (RA-31). */
export const NOTIFY_TEXT_MAX = 2000;

export const HelperRequest = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('notify'),
    /** The turn that started the command (`WHOMBAT_TURN`). */
    turn: z.string().min(1).max(100),
    text: z.string().min(1).max(NOTIFY_TEXT_MAX),
    /** The helper's own id for this notify: sent twice, it wakes the agent once. */
    eventId: z.string().min(8).max(64),
  }),
  z.object({ op: z.literal('status') }),
]);
export type HelperRequest = z.infer<typeof HelperRequest>;
