/**
 * Done recently's change of a followed task, written when it ended well (task-feedback.md TF-13): the change the call
 * kept with the task, in the past tense with how it went — “Installed 23 updates on shale” rather than “Installed
 * updates on shale” while they were still installing, “Downloaded … to local on shale” rather than “Started
 * downloading …” — its detail the outcome words before the call's own, in the thread the task was told in. Pure.
 */
import type { HostsChangeInput } from './commands';
import { updatesCount } from './updates';

const firstSentence = (text: string) => (text.split(/(?<=[.!?…])\s/)[0] ?? text).trim();

/** What a call's title said it started, as done (“Started a backup of web” → “Backed up web”). */
const PAST: [RegExp, string][] = [
  [/^Started downloading /, 'Downloaded '],
  [/^Started a backup of /, 'Backed up '],
  [/^Started the backup job /, 'Ran the backup job '],
  [/^Started a parity check with corrections on /, 'Checked parity with corrections on '],
  [/^Started a parity check on /, 'Checked parity on '],
  [/^Started the mover on /, 'Ran the mover on '],
  [/^Started updating the plugins on /, 'Updated the plugins on '],
  [/^Started updating the plugin /, 'Updated the plugin '],
  [/^Started updating /, 'Updated '],
];

export function pastTense(title: string): string {
  for (const [re, words] of PAST) if (re.test(title)) return title.replace(re, words);
  return title;
}

/** The change's title once the task ended: what it did, past tense. */
export function endedTitle(
  change: Pick<HostsChangeInput, 'op' | 'serverId' | 'text'>,
  installed: number | null,
  state: string,
  server: string,
): string {
  let title = change.text;
  if (change.op === 'server_update' && /^Installed updates on /.test(title) && installed !== null)
    title =
      installed > 0 ? `Installed ${updatesCount(installed)} on ${server}` : `Found ${server} up to date`;
  title = pastTense(title);
  return state === 'warning' ? `${title}, with warnings` : title;
}

/** The kept change as Done recently gets it at the task's end, signed then. */
export function endedChange(
  change: HostsChangeInput,
  task: { state: string; result: string | null; threadRootId: string | null; serverName: string },
  installed: number | null,
): HostsChangeInput {
  const title = endedTitle(change, installed, task.state, task.serverName).slice(0, 200);
  const outcome = task.result ? firstSentence(task.result) : '';
  const detail = [outcome, change.change?.detail ?? ''].filter(Boolean).join('\n').slice(0, 1000);
  return {
    ...change,
    text: title.slice(0, 300),
    threadRootId: task.threadRootId,
    ...(change.change ? { change: { ...change.change, title, ...(detail ? { detail } : {}) } } : {}),
  };
}
