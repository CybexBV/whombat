/**
 * A job's result message for the demo worlds (Whombat t3code.md T3-55; app job-result.md): T3 Code's report as the
 * message's text, in the shape it is asked for, and the facts beside it. Made-up work on a made-up repository.
 */
import type { JobResult } from '@whombat/core';

/** The report of a cleanup: every part the apps lay out, with three points left for the person. */
export const JOB_RESULT_REPORT = `The cleanup is done and running on development. Nothing works differently, and all the tests passed.

There was less to remove than the size of the repository suggested. The council settled 4 of the 7 points I wasn’t sure about; 3 are your call.

## What changed
- **Backend:**
  - About 15 functions only passed calls on under a second name. They’re gone; callers use the real one.
  - Four parts each had their own decoder for signed keys. They now share one.
- **Web:**
  - Removed unused helpers, one unused screen part and about 200 lines of unused styling.
  - Merged helpers that were written more than once, such as the time formats.
- **Deploy scripts:** removed functions nothing calls and about 50 unused imports.

## What I decided
- Because the device agent changed, I raised its version. I didn’t make a release, so computers don’t have the changes yet.

## What the council decided
Three reviewers looked at the 7 points I wasn’t sure about. They settled 4, and I did what they decided.
- **Removed: A function kept for a future task.** Only tests called it, and the history still has it.
- **Fixed: A demo script that looked dead.** It was broken, not dead: it passed an option the installer doesn’t accept.
- **Kept: Three long sign-in checks.** They look alike, but each checks something different for security.
- **Kept: An option that is always switched on.** The checks and their tests depend on it.

## Left for you
1. **Keep the unused groundwork for moving boxes?** About 2,000 lines wait for the other side, and nothing has used them since October.
   - Council’s advice: remove it, unless moving boxes is still planned for this year. Only you know that.
   - Choices: Keep | Remove
2. **An unused screen for release details: missing or retired?** Nothing shows this screen. An earlier plan already asked whether it is a screen you meant to add.
   - Council’s advice: it’s a product choice. If you still want release details, keep it; if not, remove it.
   - Choices: Keep it for later | Remove
3. **Is retiring the old desktops finished?** Two systems that move computers share copied code. If retiring is done, the older one can go.
   - Council’s advice: don’t merge them. Remove the older one once you say retiring is finished.
   - Choices: It’s finished | Not yet

## Technical detail
- \`fast-test\` passed on the first run, and all 441 database regressions passed.
- Removed: \`src/keys/decode_b64.rs\`, \`web/src/lib/isObject.ts\` and 14 forwarding functions in \`src/api/\`.
- The device agent is now 1.0.181.
`;

/** The facts of that job, ended at `endedAt` after 54 minutes. */
export function jobResultFixture(endedAt: string, over: Partial<JobResult> = {}): JobResult {
  return {
    handoffId: 'thread:job-result',
    outcome: 'completed',
    endedAt,
    tests: 'passed',
    changes: { files: 198, additions: 1240, deletions: 2400 },
    pullRequest: null,
    durationMs: 54 * 60_000,
    program: 'Claude · claude-opus-5-5',
    url: 'https://t3.example.com/dev/job-result',
    cut: false,
    sends: [],
    ...over,
  };
}
