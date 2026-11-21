/**
 * A row's copy (work-supervision.md WS-13): core's `describeActivity`, with two rows of the server's own.
 *
 * - A command the runner didn't run because it kept failing the same way
 *   (docs/decisions/health-command-loops.md HC-05) comes from the runner as a `command` row that failed `blocked` with
 *   no key needed; core reads every blocked row as “Blocked”, so the server says what happened: “Command not run” ·
 *   “kept failing the same way”. A blocked row that needed a key keeps core's “Blocked · needs …”.
 * - A command Codex couldn't start because the folder it was to run in isn't there (yet) fails with Codex's own words in
 *   its output (“Failed to create unified exec process: No such file or directory (os error 2)”); core shows the command
 *   line beside “Command failed”, and people read Codex's words in its evidence. Its detail says it plainly: “The folder
 *   it ran in doesn’t exist.” (RN-R4); the evidence keeps Codex's text, and the agent got Codex's own answer.
 *
 * When contracts change next, this can move into core.
 */
import { type ActivityCopyInput, describeActivity } from '@whombat/core';

export const COMMAND_NOT_RUN_TITLE = 'Command not run';
export const COMMAND_NOT_RUN_DETAIL = 'kept failing the same way';
export const MISSING_FOLDER_DETAIL = 'The folder it ran in doesn’t exist.';

/** What Codex says when a command's working directory doesn't exist: its process couldn't be created. */
const CODEX_MISSING_FOLDER = /Failed to create unified exec process: No such file or directory\b/;

/** `output`: the row's evidence output (a command's own), when it may be read. */
export function activityCopy(
  a: ActivityCopyInput,
  output: string | null = null,
): ReturnType<typeof describeActivity> {
  const copy = describeActivity(a);
  if (a.kind === 'command' && a.status === 'failed' && a.failure === 'blocked' && !a.keyNeeded)
    return { ...copy, title: COMMAND_NOT_RUN_TITLE, detail: COMMAND_NOT_RUN_DETAIL };
  if (
    a.kind === 'command' &&
    a.status === 'failed' &&
    a.failure === 'error' &&
    output &&
    CODEX_MISSING_FOLDER.test(output)
  )
    return { ...copy, detail: MISSING_FOLDER_DETAIL };
  return copy;
}
