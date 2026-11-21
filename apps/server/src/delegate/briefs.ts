/**
 * What a delegation's T3 Code threads are told (docs/decisions/delegate.md): a task's brief, a follow-up, their titles
 * and branches. Pure. These words go to the coding agents, never into the Chat; the agent's own words (the task's brief)
 * are fenced in as the task.
 */

const fence = (label: string, text: string) => [`${label}:`, '<<<', text.trim(), '>>>'];

/** Where a task keeps its screenshots (left out of git), which a council's check round reads too. */
export const SHOTS_DIR = '.whombat/shots';
/** The screenshots' size unless the project says otherwise. */
export const SHOT_SIZE = '1440×900';

/** One item of the job as the lead thread gets it: its number on the person's checklist, and what it builds on. */
export interface BriefItem {
  n: number;
  title: string;
  brief: string;
  /** The number of the item it builds on, when that one is in this thread too. */
  after?: number | null;
}

export interface TaskBriefInput {
  lead: string;
  /** What all the tasks are for. */
  goal: string;
  /** The items this thread does, in the order they build on each other. */
  items: readonly BriefItem[];
  /** The branch it works on; null: a scratch folder. */
  branch: string | null;
  /** The branch it starts from (the task it comes after), or null. */
  base: string | null;
  pullRequest: boolean;
  /** Whombat checks the finished work and merges it. */
  merge?: boolean;
  batch?: boolean;
  /** What every task of the list keeps to alike (DLG-24). */
  rules?: string | null;
  /** The task's picture link: the box's addresses, best first, and its token (DLG-27); null: none. */
  upload?: { bases: readonly string[]; token: string } | null;
  /** How many subagents may work at once (the card's “at once”). */
  atOnce?: number;
  /** Other items of the list run in threads of their own at the same time (another AI was chosen for them). */
  others?: boolean;
}

/** The words that say a thread may start subagents: a message that has them gets no second copy. */
export const SUBAGENT_MARK = 'You may start subagents.';

/**
 * When a lead thread starts subagents: only for sizeable, independent parts, a few at a time, with the shared
 * files kept to itself. Said outright, because a thread another agent started reads itself as a child that starts none
 * unless its task says so, and Codex starts subagents only when asked; and kept narrow, because Claude would otherwise
 * delegate small work too. Last, a command it leaves running when its turn ends: T3 Code counts one the thread doesn't
 * wait for as finished work, so the thread's end is told before the command's and only Whombat's wait keeps it running.
 */
export function subagentRules(atOnce: number): string[] {
  return [
    'How to work:',
    '- You lead this and own the result. Read the code and plan the whole job first: what touches the same files, and what can be done side by side.',
    `- ${SUBAGENT_MARK} Give one a part only when it is sizeable and independent of the others: another screen, package or app, or wide reading across the code. At most ${atOnce} at a time, each with its goal, the files it may change and what done means.`,
    '- Code-writing subagents get a worktree of their own or files nobody else touches; you bring their work onto your branch yourself.',
    '- Do small, sequential or same-file work yourself. Keep shared files (translations, help pages, migrations) to yourself: subagents tell you what they need there.',
    '- Don’t use subagents to re-check your own work. A review by another model you were asked for is different: run it as asked.',
    '- When you end a turn while a command you started still runs in the background (tests, a build, a deploy), first call `t3_background_wait` with its task id when you have that tool, so T3 Code wakes you when it ends.',
  ];
}

/**
 * The repository's own list of checks to run before a push, which can ask for more than the quick checks (a lint with
 * every feature on, the database tests of a shared test helper). Whombat names no commands: each repository says its own.
 */
const PRE_PUSH =
  'the checks the repository’s own agent instructions say to run before a push (a “Before you push” section in AGENTS.md, CLAUDE.md or CONTRIBUTING) for what you changed';

/**
 * How a repository is tested (docs/decisions/fast-testing.md): `fast-test` when it has a recipe for it, which tests only
 * what changed and sends heavy tests to the build server by itself; otherwise the quick checks its own instructions name.
 * Never the whole suite: that runs at night and when someone asks.
 */
export const FAST_TESTS =
  'run `fast-test` in the repository’s folder when it has a `.fast-test.json` (exit 0 passed, 1 failed, 2 couldn’t run: then say so and don’t run the full suite here instead); without one, the quick checks its AGENTS.md or CLAUDE.md names for what changed (the linter, the type check and the tests of the parts you touched). Never the full test suite';

/**
 * The merge step's last line: once merged, the work goes to DEV the way the repository's own instructions say, never
 * to production (docs/decisions/fast-testing.md). The checklist's own rules may say not to.
 */
export const DEPLOY_AFTER_MERGE =
  '- Once it is merged, put it on the development environment (DEV) the way the repository’s AGENTS.md or CLAUDE.md says, unless the checklist’s rules say not to. When they say nothing about DEV, skip it and say so in your summary. Never deploy to production, and don’t wait for CI or other checks that aren’t needed for it. Say in your summary how it went.';

/**
 * A fix for failing checks also runs what the failed run never got to, so one push fixes everything: CI stops at the
 * first failing stage, and each stage it skipped can fail the next round.
 */
export const FIX_ROUND =
  'Before you push a fix, run here, with the fix, the checks for what you changed that the failed run never reached (stages skipped, blocked or cancelled because an earlier one failed), within the repository’s own rules for checks before a push, so one push fixes everything.';

/** The line a lead thread's answer gives each item, numbered as on the person's checklist. */
const itemLine = (n: number) =>
  `Item ${n}: <one short sentence for the person about what changed for it; or “not done:” and why>`;

/** How a task sends its before and after pictures of a change people see (DLG-27, as CNL-30…CNL-32). */
export function pictureLines(upload: { bases: readonly string[]; token: string } | null): string[] {
  const head = [
    'Pictures, only when your change is something people see:',
    `1. Before you change anything, take a screenshot of each screen you will change: ${SHOT_SIZE} unless the project says otherwise, in light and dark where the app has both. Save them as PNG in ${SHOTS_DIR}/ and add \`.whombat/\` to .git/info/exclude. Name each screen in a few plain words (“Settings · light”).`,
    '2. When you are done, take the same screenshots again: same size, same state.',
  ];
  if (!upload) return [...head, '3. Say in your answer which screens you took.'];
  const [base] = upload.bases;
  const shot = (when: string) =>
    `curl -sS --fail -X POST -H 'content-type: image/png' --data-binary @<file> '<address>/shots/${upload.token}/shot?when=${when}&view=<screen name, URL-encoded>'`;
  return [
    ...head,
    `3. Send each picture to Whombat, trying these addresses in order until one answers: ${upload.bases.join(', ')}`,
    `   before: ${shot('before')}`,
    `   after:  ${shot('after')}`,
    '   The answer to an after picture lists the numbered areas that changed and where they are.',
    '4. Then send one short note per number, in plain words for someone who isn’t a developer (“The buttons are taller, so they are easier to tap.”):',
    `   curl -sS --fail -X POST -H 'content-type: application/json' --data '{"view":"<screen name>","notes":{"1":"…","2":"…"}}' '${base ?? '<address>'}/shots/${upload.token}/notes'`,
    '5. When no address answers, say so in your answer and go on.',
  ];
}

/**
 * What a delegation's thread is told: it leads the items handed to it, on one branch and in one pull request,
 * with subagents where the work splits, and ends with a line per item for the card.
 */
export function taskBrief(input: TaskBriefInput): string {
  const merge = !!input.merge && input.pullRequest;
  const items = input.items;
  const one = items.length === 1;
  const git = input.branch
    ? [
        `- Work in this worktree, on branch ${input.branch}${input.base ? ` (it starts from ${input.base}, the work before it)` : ''}${one ? ', and commit in small commits' : ', and commit each item on its own'}.`,
        // It may start from what the computer last fetched, and tasks before it may have been merged since.
        ...(!input.base
          ? [
              '- First bring the branch up to date: fetch origin and merge its default branch, so you build on what is there now.',
            ]
          : []),
        `- ${input.others ? 'Other threads change this project at the same time: change only what your items need, f' : 'F'}ollow the project’s own conventions (see how recent changes did it), and don’t rename, renumber or rewrite what you didn’t add.`,
        // The whole suite runs at night and when someone asks; running it here too only made the wait longer.
        input.pullRequest
          ? `- Before you push, test what you changed, once, on the combined work: ${FAST_TESTS}. Also ${PRE_PUSH}.`
          : `- Before you finish, test what you changed: ${FAST_TESTS}. Also ${PRE_PUSH}.`,
        ...(input.pullRequest
          ? [
              `- When it is done, push the branch and open one pull request${one ? '' : ' for all the items'}. Don’t merge it.`,
              ...(input.batch
                ? [
                    '- Then push and open the pull request. Leave the check of everything together to the combined candidate; don’t wait for CI on this branch.',
                  ]
                : [
                    `- Then get the pull request’s checks to pass: watch it in T3 Code and end your turn while they run. Fix failures, at most three rounds. ${FIX_ROUND} Never weaken or skip tests or safety rules.`,
                  ]),
              '- When you are asked to have another model review your change, open the pull request first and let the review run while its checks run.',
              ...(merge
                ? [
                    `- ${input.lead} combines the finished work, checks that candidate and merges it together. Leave your pull request open; do not merge or wait for a merge turn.`,
                  ]
                : []),
            ]
          : ['- Don’t push and don’t open a pull request.']),
      ]
    : ['- Work in this folder; change nothing outside it.'];
  const where = input.branch ? `, on one branch and in one pull request${one ? '' : ' for all of them'}` : '';
  return [
    `${input.lead}, the person’s assistant, handed you ${one ? 'this job' : `this job of ${items.length} items`} (“${input.goal.trim()}”)${one ? '' : ', numbered as on the person’s checklist'}${where}.${input.others ? ' Other items of the list run in other threads, each on a branch of its own: stay within yours.' : ''}`,
    '',
    ...items.flatMap((t, i) => [
      ...(i ? [''] : []),
      ...fence(
        `Item ${t.n}${t.after ? ` (builds on item ${t.after})` : ''}`,
        `${t.title.trim()}\n\n${t.brief.trim()}`,
      ),
    ]),
    ...(input.rules?.trim() ? ['', ...fence('What every item keeps to', input.rules)] : []),
    '',
    ...subagentRules(Math.max(1, input.atOnce ?? 3)),
    '',
    'Rules:',
    ...git,
    ...(one
      ? []
      : [
          // The person's card ticks each item as it is said and shows the thread's latest words.
          '- Each time you finish an item, say so in a line of its own: “Item N done: <what changed, in a short sentence for the person>”. Your progress messages show on the person’s card: keep them short and plain.',
        ]),
    `- Decide small things yourself and say what you assumed. Ask ${input.lead} only what you truly can’t decide; it answers.`,
    '- Don’t start a council.',
    ...(input.branch ? ['', ...pictureLines(input.upload ?? null)] : []),
    '',
    `End with a short summary for ${input.lead}: what you changed${input.branch ? ', the branch' : ''}${input.pullRequest && input.branch ? ', the pull request' : ''}, the checks you ran and what you couldn’t do. Then these lines, exactly as written:`,
    ...(one ? [] : items.map((t) => itemLine(t.n))),
    'Note: <one short sentence for the person, who may not be a developer, about what changed: no file names, ids or commands>',
    ...(input.pullRequest && input.branch
      ? [
          input.batch
            ? 'Checks: passing   (the fast tests passed; or Checks: failing, and why)'
            : 'Checks: passing   (or: Checks: none, when the repository runs no checks on pull requests; or: Checks: failing, and why)',
        ]
      : []),
  ].join('\n');
}

/**
 * More work for a task's own thread. A thread that does several items ends with a line for each, by the numbers it was
 * given, and one with a pull request with its checks, as its first brief asked: its end is read the same way.
 */
export function sendMessage(input: {
  lead: string;
  message: string;
  /** The items its thread does, by the numbers it was given (more than one: a lead thread). */
  items?: readonly number[];
  /** It has a pull request whose checks its end reports. */
  checks?: boolean;
}): string {
  const items = input.items && input.items.length > 1 ? input.items : [];
  const lines = [
    ...items.map((n) => itemLine(n)),
    ...(items.length ? ['Note: <one short sentence for the person about what changed>'] : []),
    ...(input.checks ? ['Checks: passing   (focused checks passed; or Checks: failing, and why)'] : []),
  ];
  return [
    `${input.lead} asks you to do this too:`,
    '<<<',
    input.message.trim(),
    '>>>',
    '',
    lines.length
      ? 'Then end with a short summary of what you changed and these lines, exactly as written (an item this didn’t touch keeps how it went):'
      : 'Then end with a short summary of what you changed.',
    ...lines,
  ].join('\n');
}

/** The line a task's work ends with: `Checks: passing`, `none` or `failing` (DLG-20). */
const CHECKS_LINE = /^[\s>*_`-]*checks[*_`]*\s*:[\s*_`]*(passing|none|failing)\b/gim;

/** What a task's answer says of its pull request's checks (its last `Checks:` line); null when it says nothing. */
export function saysChecks(answer: string | null): 'passing' | 'none' | 'failing' | null {
  if (!answer) return null;
  const said = [...answer.matchAll(CHECKS_LINE)].at(-1)?.[1]?.toLowerCase();
  return said === 'passing' || said === 'none' || said === 'failing' ? said : null;
}

/** The line for the person a task's answer ends with (`Note: …`, DLG-26); null when there is none. */
const NOTE_LINE = /^[\s>*_`-]*note[*_`]*\s*:[\s*_`]*(.+)$/gim;

export function noteOf(answer: string | null, max: number): string | null {
  if (!answer) return null;
  const said = [...answer.matchAll(NOTE_LINE)]
    .at(-1)?.[1]
    ?.replace(/[*_`]+$/g, '')
    .trim();
  if (!said || said.startsWith('<')) return null;
  return said.length > max ? `${said.slice(0, max - 1).trimEnd()}…` : said;
}

/** A lead thread's line about one item (`Item 3: …`). */
const ITEM_LINE = /^[\s>*_`-]*item\s+(\d{1,2})[*_`]*\s*:[\s*_`]*(.+)$/gim;
const NOT_DONE = /^not\s+done\b[\s:;,.–—-]*/i;

/**
 * What a lead thread's answer says of each item, by its number on the card (its last line about it): the sentence for
 * the person, and whether it was done. Placeholders left as written are skipped.
 */
export function itemsOf(answer: string | null, max: number): Map<number, { note: string; done: boolean }> {
  const out = new Map<number, { note: string; done: boolean }>();
  if (!answer) return out;
  for (const [, n, said] of answer.matchAll(ITEM_LINE)) {
    const text = said?.replace(/[*_`]+$/g, '').trim() ?? '';
    if (!text || text.startsWith('<')) continue;
    const done = !NOT_DONE.test(text);
    const rest = done ? text : text.replace(NOT_DONE, '').trim();
    const note = rest ? `${rest.charAt(0).toUpperCase()}${rest.slice(1)}` : 'Not done.';
    out.set(Number(n), { note: note.length > max ? `${note.slice(0, max - 1).trimEnd()}…` : note, done });
  }
  return out;
}

/** The line a merge's last answer ends with: `Merged: yes`, or `Merged: no` and why. */
const MERGED_LINE = /^[\s>*_`-]*merged[*_`]*\s*:[\s*_`]*(yes|no)\b/gim;

/** Whether a merge's answer says it merged (its last `Merged:` line); null when it says neither. */
export function saysMerged(answer: string | null): boolean | null {
  if (!answer) return null;
  const said = [...answer.matchAll(MERGED_LINE)].at(-1)?.[1]?.toLowerCase();
  return said === 'yes' ? true : said === 'no' ? false : null;
}

/**
 * A task's thread is told it is its pull request's turn to be merged (DLG-40): its checks passed, so it merges at once
 * when GitHub says it merges cleanly, without bringing it up to date or waiting for new checks; a conflict is resolved
 * here, checked quickly and merged. The default branch is checked once, after the list's last merge (DLG-41). Left open,
 * with why, when it needs a person.
 */
export function mergeBrief(input: {
  lead: string;
  pr: string;
  branch: string | null;
  /** A step once it is merged (putting it on DEV, `DEPLOY_AFTER_MERGE`). */
  after?: string | null;
}): string {
  const branch = input.branch ? `branch ${input.branch}` : 'your branch';
  return [
    `${input.lead} asks you to merge your pull request now: it is its turn (${input.pr}). Its checks passed. Other tasks of the same list may have been merged since you started.`,
    '',
    'Steps:',
    '- When GitHub says it merges without conflicts, merge it now, the way this repository merges its pull requests (see how its recent ones were merged). Don’t bring it up to date or wait for new checks first: once the whole list is merged, the default branch is checked as a whole.',
    `- Only when it conflicts: fetch origin and merge its default branch into ${branch}. Resolve the conflicts so your change and what was merged both keep working (a migration or number another change took gets the next free one), run the quick checks for the parts the conflict touched and ${PRE_PUSH}, push, and merge once GitHub says it merges cleanly.`,
    `- When GitHub refuses the merge until required checks pass again, watch the pull request in T3 Code (this thread opened it, so it watches it itself) and end your turn: T3 Code wakes you as they end. Fix what fails and push, at most three rounds, never weakening tests, checks or safety rules. ${FIX_ROUND} Checks still running are never a reason to end with “Merged: no”.`,
    '- Don’t merge when it needs a person: a review someone has to give, or a decision only they can make. Leave it open then.',
    '',
    ...(input.after ? [input.after] : []),
    `End with a short summary for ${input.lead}: what you changed to get it merged, and as the last line “Merged: yes”, or “Merged: no” and why.`,
  ].join('\n');
}

/** The final check's title and line on the card (DLG-41). */
export const FINAL_TASK = {
  title: 'Check everything together',
  why: 'Combines the finished work and checks it before it is merged.',
  brief:
    'Prepare one combined candidate from the finished task branches, check the exact revision, and leave it open for Whombat to authorize its merge.',
} as const;

/**
 * Prepare and check the combined candidate. Merge authorization is a separate run. When all the work is in one pull
 * request (`single`), that pull request is the candidate: it is brought up to date and checked as it is, so no second
 * thread's copy of it needs its own checks. Tried again on the same work, it carries on with the candidate it left
 * open (`again`).
 */
export function finalBrief(input: {
  lead: string;
  goal: string;
  branch: string;
  merged: readonly string[];
  candidates?: readonly { title: string; pr: string; branch: string | null }[];
  single?: { title: string; pr: string; branch: string | null } | null;
  /** The candidate an earlier run of this check left open, when it is tried again on the same work. */
  again?: { pr: string; branch: string } | null;
  inputs?: string;
  generation?: number;
  rules?: string | null;
  /** `local`: the default branch requires no checks on GitHub, so the repository's fast tests here are the check. */
  gate?: 'ci' | 'local';
}): string {
  const candidates = input.candidates ?? [];
  const single = input.single ?? null;
  const head = single?.branch ?? '<its head branch>';
  const prepare = single
    ? [
        `${input.lead} asks you to check the finished work for “${input.goal.trim()}” before it is merged. All of it is in one pull request: check that pull request itself and don’t open another. Do not merge into the default branch in this run.`,
        ...fence('The pull request', `${single.title}: ${single.pr} (branch ${head})`),
        ...(input.merged.length ? fence('Already on the default branch', input.merged.join('\n')) : []),
        ...(input.rules?.trim() ? fence('Project rules', input.rules) : []),
        `- Fetch origin and put your branch on the pull request’s head (\`git reset --hard origin/${head}\`). Record the default branch’s full commit as base.`,
        `- When its branch doesn’t contain the latest default branch, merge the default branch in, resolve conflicts so both keep working, run the quick checks for what the conflict touched and ${PRE_PUSH}, and push to the pull request’s branch (\`git push origin HEAD:${head}\`). Otherwise change nothing: its checks may already be running.`,
      ]
    : [
        `${input.lead} asks you to combine and check the finished work for “${input.goal.trim()}”. Do not merge into the default branch in this run.`,
        ...fence(
          'Include only this work, in this order',
          candidates.map((t) => `- ${t.title}: ${t.pr} (${t.branch ?? 'read its head branch'})`).join('\n') ||
            '- No unmerged work; check the default branch as it is now.',
        ),
        ...(input.merged.length ? fence('Already on the default branch', input.merged.join('\n')) : []),
        ...(input.rules?.trim() ? fence('Project rules', input.rules) : []),
        ...(input.again
          ? [
              ...fence(
                'The combined candidate an earlier run left open',
                `${input.again.pr} (branch ${input.again.branch})`,
              ),
              `- Carry on with that candidate and don’t open another. Fetch origin and put your branch on its head (\`git reset --hard origin/${input.again.branch}\`); record the default branch’s full commit as base. Merge in any listed PR head or the latest default branch it lacks, retaining their ancestry, and push only then (\`git push origin HEAD:${input.again.branch}\`). Otherwise change nothing: its checks may already have run on this revision. Keep the source pull requests open.`,
            ]
          : [
              `- Fetch origin. Start ${input.branch} from the latest default branch; record its full commit as base. Merge the listed PR heads in dependency order, retaining their ancestry. Include no kept-open PR or unlisted branch. Resolve conflicts so both changes keep working; when you had to, run the quick checks for what the conflicts touched and ${PRE_PUSH} before you push.`,
              '- Push one combined candidate and open one integration pull request when it changes the default branch. Keep the source pull requests open. If there is no diff, check the exact default-branch commit without making an empty PR.',
            ]),
      ];
  const pr = single ? 'the pull request' : 'the integration pull request';
  const local = input.gate === 'local';
  return [
    ...prepare,
    ...(local
      ? [
          `- The default branch requires no checks on GitHub, so your run is the check: on this exact ${single ? '' : 'combined '}revision, test what the work changed since the default branch: ${FAST_TESTS}. Don’t watch or wait for CI on GitHub. Fix genuine failures without weakening checks, at most three rounds. Do not count a failing baseline as a passing result.`,
        ]
      : [
          `- Identify expected checks from the repository’s required checks and active CI configuration, including checks queued but not yet reported. Run the required checks on this ${single ? '' : 'combined '}revision once. Results on exactly that revision count, and so do passes on a commit with exactly the same files (the same \`git rev-parse <commit>^{tree}\`, such as a source head the candidate only adds a merge commit to): report those as passing on this revision without waiting for them to run again. Keep critical database, browser or VM boundary tests when the change needs them; leave unrelated release and nightly matrices out. Focused checks during coding still apply.`,
          `- Watch ${pr} in T3 Code and end your turn while checks run. Otherwise missing or queued results mean waiting, never success. Fix genuine failures without weakening checks, at most three rounds. ${FIX_ROUND} Do not count a failing baseline as a passing result.`,
        ]),
    `- Fetch again before finishing. If the default branch moved, merge it into ${single ? 'the pull request’s branch' : 'the candidate'} and check the resulting revision. Do not merge yet; Whombat verifies the evidence before authorizing a separate merge.`,
    '- If the repository has no checks, report that explicitly; if a result cannot be confirmed, say why. Ask only for decisions you cannot make.',
    'End with a short summary and these lines:',
    `Note: <one short sentence about how the ${single ? '' : 'combined '}check went>`,
    'Checks: passing (or Checks: failing, and why)',
    `Verification: {"revision":"<full checked commit>","base":"<full default-branch commit>","inputs":"${input.inputs ?? ''}","generation":${input.generation ?? 0},"expected":["<check name>"],"results":[{"name":"<check name>","revision":"<same checked commit>","state":"passing"}]}`,
    local
      ? 'Name each command you ran “local: <command>” (“local: fast-test”). The Verification value must be one JSON line. Never report a check you did not see pass.'
      : 'Use exact GitHub context names. Repositories with no checks use expected:[], results:[], noChecks:true. The Verification value must be one JSON line. Never report a check you did not observe passing.',
  ].join('\n');
}

/**
 * The candidate Whombat merged on GitHub is to be put on DEV by its thread (`DEPLOY_AFTER_MERGE`): that step only,
 * nothing merged, pushed or changed.
 */
export function deployBrief(input: { lead: string; pr: string; revision: string; after: string }): string {
  return [
    `${input.lead} merged ${input.pr} on GitHub at ${input.revision}, the combined work you checked. Don’t merge, push or change anything.`,
    input.after,
    'End with a short summary of how it went, then this line:',
    'Note: <one short sentence for the person, who may not be a developer, about whether it is live>',
  ].join('\n');
}

/** A task's thread title (before T3 Code's “<agent> - ” in front). */
export function taskTitle(title: string): string {
  return title.trim().slice(0, 150);
}

/** A branch for a task: `delegate/<words of its title>-<a few letters of its id>`, `-2` on its second try. */
export function taskBranch(title: string, id: string, attempt: number): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .slice(0, 6)
    .join('-')
    .slice(0, 40)
    .replace(/-+$/, '');
  const tail = id
    .replace(/^[a-z]+_/, '')
    .slice(-5)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x');
  return `delegate/${slug || 'task'}-${tail}${attempt > 1 ? `-${attempt}` : ''}`;
}
