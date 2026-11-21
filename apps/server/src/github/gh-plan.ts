/**
 * What an agent's `gh` command may do (docs/decisions/agent-gh.md AGH-04, AGH-05, AGH-07, AGH-08): a table, not a
 * guess. Pure — the route (`github/agent-gh.ts`) hands it the turn's repositories, checkout and the files the stand-in
 * sent, and acts on the plan:
 *
 * - `read`: run gh with `args` (no key: any repository or account the GitHub connection sees, AGH-06, AGH-23);
 * - `write`: the agent's `keyId` decides (`github.gh` through the commit pipeline), then gh runs `args`;
 * - `whombat`: `gh pr create`, `pr merge` and `pr review` become Whombat's own `open_pr`, `merge_pr`, `review_pr`;
 * - `create_repo`: `gh repo create`, which Whombat does itself as the GitHub connection, the plan's key deciding (AGH-19);
 * - `refuse`: one sentence, exit 1.
 *
 * The words are read the way gh's flag parser (pflag) reads them: a flag that takes a value takes the next word
 * whatever it looks like, `--flag=value` and `-Fvalue` are the same as two words, short booleans may be clustered
 * (`-iR acme/web`). A word is only ever read as *more* than gh would read it (an unknown flag of a read is a boolean,
 * so the word after it is still looked at as a flag), never less. `-R`/`--repo` is taken out of the words (the repo
 * goes back as `GH_REPO`); a file the command reads is replaced by `@whombat-file:N` (N: its index in the files the
 * stand-in sent, matched by the path as written), `key=@path` by `key=@@whombat-file:N`; `-` (stdin) stays.
 */
import { branchWriteKey, type KeyId, type MergeMethod } from '@whombat/core';
import type { GhRepoSpec } from './adapter';

/** What the planner knows about the turn. */
export interface GhPlanContext {
  /** The burrow's switched-on GitHub repositories (canonical full names, AGH-12). */
  repos: readonly string[];
  /** The repo a command that names none uses (`DispatchContext.gh.defaultRepo`). */
  defaultRepo: string | null;
  /** The turn's checkout: its branch stands in for a pull request a `pr` command doesn't name. */
  checkout: { repo: string; branch: string } | null;
  /** The files the stand-in read (paths as the command wrote them) and their text. */
  files: readonly { path: string; text: string }[];
  /** stdin's text when the command reads `-`; null otherwise. */
  stdin: string | null;
  /** The host's deploy workflow files for a repo (`GITHUB_DEPLOY_WORKFLOW`, AGH-05). */
  deployWorkflows: (repo: string) => readonly string[];
  /** The line comments and issues get (“— Dusty via Whombat”, AGH-13); null: none. */
  signature: string | null;
}

/** A pull request a `pr` command names: by number, or by its head branch. */
export type GhPrRef = { number: number } | { branch: string };

export type GhWhombatOp =
  | { op: 'pr_create'; title: string; body: string; base: string | null; head: string }
  | { op: 'pr_merge'; pr: GhPrRef; method: MergeMethod | null }
  | { op: 'pr_review'; pr: GhPrRef; decision: 'approve' | 'request_changes' | 'comment'; body: string };

export type GhPlan =
  | { kind: 'read'; args: string[]; repo: string | null }
  | {
      kind: 'write';
      args: string[];
      /** null: the GitHub account or an organization, not one repository (AGH-23). */
      repo: string | null;
      /** The branch it changes, when it changes one (the branch keys' scope). */
      branch?: string;
      keyId: KeyId;
      /** What it does, for the key's Blocked and Asks texts: “comment on issue #12”. */
      action: string;
      /** The command words up to the first flag, at most four (AGH-13's “Ran gh issue comment on acme/web”). */
      words: string[];
      /** The words an approval's hash covers: as decided, before the turn's branch and the signature were added. */
      hashArgs: string[];
    }
  | { kind: 'whombat'; repo: string; op: GhWhombatOp }
  | {
      kind: 'create_repo';
      /** The owner it names (null: the GitHub connection's own account) and what to make (AGH-19). */
      repo: GhRepoSpec & { owner: string | null };
      /** `code.write` for a private or internal repository, `deploy` for a public one (AGH-20). */
      keyId: KeyId;
      /** “create the public repository”: the server adds the full name. */
      action: string;
      words: string[];
      hashArgs: string[];
    }
  | { kind: 'refuse'; message: string; exitCode: number; repo?: string };

/** The placeholder for the Nth file the stand-in sent (AGH-08). */
export const ghFilePlaceholder = (n: number) => `@whombat-file:${n}`;

/** The longest word gh gets (`GH_ARG_MAX`): a file body longer than this stays a file, unsigned. */
const WORD_MAX = 65_536;

/* Copy ---------------------------------------------------------------------------------------------- */

export const GH_COPY = {
  web: 'There is no browser here: drop --web.',
  hostname: 'Only github.com works here.',
  checkout: 'Your checkout is already here: use git.',
  editor: 'There is no editor here: pass the text with -b or -F.',
  review: 'Review with gh pr review.',
  merge: 'Merge with gh pr merge or merge_pull_request.',
  apiPath: 'Give gh api one path on api.github.com: gh api repos/{owner}/{repo}/issues.',
  apiHeader: 'gh api -H can’t set Authorization or Host here.',
  oneRepo: 'One repository per command.',
  placeholder: 'gh words can’t contain @whombat-file: here.',
  flagsFirst: 'Put flags after the command: gh issue list --state open.',
  workflowFile: 'Name the workflow by its file: gh workflow list shows them.',
  workflowJson: 'Pass the workflow’s inputs with -f key=value.',
  workflowFieldFile: 'gh workflow run -F can’t read files here: pass the value with -f.',
  workflowMissing: 'Say which workflow: gh workflow run deploy.yml.',
  fork: 'Pull requests from forks aren’t supported here.',
  reviewDecision: 'Say --approve, --request-changes or --comment.',
  reviewBody: 'Add the review’s text with -b or -F.',
  title: 'Give the pull request a title with -t.',
  mergeMethod: 'Say one of --merge, --squash or --rebase.',
  noRepos: 'Say which repository with -R owner/name.',
  repoName: 'Name the repository: gh repo create my-repo --private.',
  repoVisibility: 'Say --public or --private.',
  repoNamed: 'gh repo create names its repository itself: drop -R.',
  repoSource:
    'gh repo create --source isn’t supported here: create it, then start a run on it (from a template, or with --add-readme).',
  repoClone: 'Your checkout comes with a run: gh repo create --clone isn’t supported here.',
  releaseTag: 'Say which tag: gh release create v1.0.0.',
  releaseFiles:
    'gh release can’t attach files here: let the repository’s release workflow build and upload them.',
  auth: 'gh is already signed in through Whombat as this Whombat’s GitHub connection; its token stays with Whombat.',
  runnerCode: 'would run code on Whombat’s side, outside your commands, so it isn’t available here.',
  config: 'gh’s settings here aren’t kept between commands: pass what you need with each command.',
  terminal: 'needs a terminal of its own, which gh here doesn’t have.',
  download: 'would save files on Whombat’s side, not where your commands are: read them with gh api instead.',
  secretValue: 'Pass the value with -b: gh here gets no stdin for it.',
  setDefault: 'Name the repository with -R on each command instead.',
  noBrowser: 'There is no browser here: add --no-browser to print the address.',
  unknown: 'isn’t known to Whombat’s gh yet: do it with gh api.',
} as const;

const notAvailable = (what: string) => `gh ${what} isn’t available here.`;
/** A refusal that names the command (“gh extension install would run code on Whombat’s side …”). */
const ghSays = (command: string, what: string) => `gh ${command} ${what}`;
/** A file of the agent's commands named by its path: Whombat's side would read its own instead (AGH-23). */
const noLocalPath = (command: string, hint: string) =>
  `gh ${command} can’t read files of your commands by their path here: ${hint}`;
const unsupported = (command: string, flag: string) =>
  `gh ${command} ${flag} isn’t supported here: leave it out.`;
const noFile = (path: string) => `Whombat didn’t get the file ${path}.`;
const needsValue = (flag: string) => `${flag} needs a value.`;
const sayRepo = (repos: readonly string[]) => `Say which repository with -R: ${repos.join(', ')}.`;
const notSwitchedOn = (repo: string) =>
  `${repo} isn’t one this Whombat’s GitHub sign-in works on. A public repository still clones with git.`;

export { notSwitchedOn as ghNotSwitchedOn };

const localRepo = (repo: string) =>
  `${repo} is kept on this Whombat, not on GitHub: use git and open_pull_request.`;
const sayBranch = (repo: string) => `Say which branch with -H: this turn has no checkout of ${repo}.`;
const sayPr = (command: string) => `Say which pull request: gh pr ${command} 12.`;
const notMethod = (method: string) => `${method} isn’t an HTTP method.`;
const notRepo = (value: string) => `${value} isn’t owner/name.`;
const badRepoName = (value: string) =>
  `${value} can’t be a repository’s name: use letters, digits, -, _ and . (like my-repo).`;
const templateWith = (flag: string) => `gh repo create --template can’t be combined with ${flag}.`;

/* Flags --------------------------------------------------------------------------------------------- */

interface FlagSpec {
  long: string;
  short?: string;
  /** Takes a value (the next word, `=value`, or the rest of a short cluster). */
  value?: boolean;
  /** The value is a file the stand-in read (`-` is stdin). */
  file?: boolean;
  /** The value is text a person reads on GitHub: it gets the signature line. */
  body?: boolean;
  /** Free text (a title, a description): not looked at for a repository's URL. */
  text?: boolean;
  /** `api`'s `-F key=@file`: the part after `=@` is a file. */
  field?: boolean;
  /** Refused with this sentence. */
  refuse?: string;
  /** A body file's text goes inline under this flag (`--body`; `--notes` for a release). */
  inline?: string;
  /** The command's own `--repo` (a search's filter, a codespace's): kept in the words, naming nothing here. */
  own?: boolean;
}

const v = (long: string, short?: string, more: Partial<FlagSpec> = {}): FlagSpec => ({
  long,
  ...(short ? { short } : {}),
  value: true,
  ...more,
});
const b = (long: string, short?: string, more: Partial<FlagSpec> = {}): FlagSpec => ({
  long,
  ...(short ? { short } : {}),
  ...more,
});
/** `'author:A'` → a value flag `--author`/`-A`. */
const vs = (...specs: string[]) =>
  specs.map((s) => {
    const [long, short] = s.split(':') as [string, string | undefined];
    return v(long, short);
  });

/** On every command: the repo (taken out), the host (github.com only) and help. */
const GLOBAL: FlagSpec[] = [v('repo', 'R'), v('hostname'), b('help', 'h')];
const OUTPUT: FlagSpec[] = [v('json'), v('jq', 'q'), v('template', 't')];
const WEB = b('web', 'w', { refuse: GH_COPY.web });
const EDITOR = b('editor', 'e', { refuse: GH_COPY.editor });
const BODY = [v('body', 'b', { body: true, text: true }), v('body-file', 'F', { file: true, body: true })];
const TITLE = v('title', 't', { text: true });
const COMMENT = v('comment', 'c', { body: true, text: true });
const RULESET_ORG = v('org', 'o');
/** What `release create` and `release edit` share; `--latest=false` is a boolean's. */
const RELEASE: FlagSpec[] = [
  TITLE,
  v('notes', 'n', { body: true, text: true }),
  v('notes-file', 'F', { file: true, body: true, inline: '--notes' }),
  b('draft', 'd'),
  b('prerelease', 'p'),
  b('latest'),
  b('verify-tag'),
  v('target'),
  v('discussion-category'),
];

type Kind = 'read' | 'write' | 'pr_create' | 'pr_merge' | 'pr_review' | 'repo_create' | 'api' | 'refused';
/**
 * Whombat's own commands read their flags, so an unknown one is refused rather than passed on; and `gh api`, whose
 * `--verbose` would print the token's header.
 */
const STRICT: ReadonlySet<Kind> = new Set(['pr_create', 'pr_merge', 'pr_review', 'repo_create', 'api']);
/** What the positional words of a command are (a pull request, for the turn's branch; a write's action phrase). */
type Target = 'issue' | 'issues' | 'pr' | 'label' | 'run' | 'workflow' | 'release' | 'none';

interface CommandSpec {
  kind: Kind;
  /**
   * Known flags. Unknown ones pass as booleans (AGH-23); Whombat's own commands (`pr create|merge|review`, `repo
   * create`) refuse them. A flag that reads a file must be listed: its path would be read on Whombat's side.
   */
  flags: FlagSpec[];
  key?: KeyId;
  /** The key from the words (`repo edit --visibility public` is a deploy). */
  keyOf?: (tokens: Token[], positionals: string[]) => KeyId;
  target?: Target;
  /** The action phrase from what the target words name (“comment on” + “issue #12”). */
  phrase?: (noun: string) => string;
  /** Not about one repository: the account, its organizations, gists, keys, codespaces (repo null, AGH-23). */
  account?: boolean;
  /** These flags make it the account's or an organization's instead of a repository's (`secret set --org`). */
  accountWith?: string[];
  /** Its first word names the repository (`repo edit acme/web`), else the turn's. */
  repoArg?: boolean;
  /** A refusal from the words, or null (`release upload`'s files, `secret set` without a value). */
  check?: (tokens: Token[], positionals: string[]) => string | null;
  /** `refused`: why (a download, a terminal). */
  refuse?: string;
}

const COMMANDS: Record<string, CommandSpec> = {
  // Reads (AGH-05). The value flags listed are the ones whose value must not be read as a flag or a pull request.
  'pr list': {
    kind: 'read',
    flags: [
      ...vs('author:A', 'assignee:a', 'base:B', 'head:H', 'label:l', 'limit:L', 'search:S', 'state:s', 'app'),
      b('draft', 'd'),
      WEB,
      ...OUTPUT,
    ],
  },
  'pr view': { kind: 'read', target: 'pr', flags: [b('comments', 'c'), WEB, ...OUTPUT] },
  'pr diff': { kind: 'read', target: 'pr', flags: [v('color'), b('name-only'), b('patch'), WEB] },
  'pr checks': {
    kind: 'read',
    target: 'pr',
    flags: [v('interval', 'i'), b('watch'), b('required'), b('fail-fast'), WEB, ...OUTPUT],
  },
  'pr status': { kind: 'read', flags: [b('conflict-status', 'c'), ...OUTPUT] },
  'issue list': {
    kind: 'read',
    flags: [
      ...vs(
        'author:A',
        'assignee:a',
        'label:l',
        'limit:L',
        'search:S',
        'state:s',
        'milestone:m',
        'mention',
        'app',
      ),
      WEB,
      ...OUTPUT,
    ],
  },
  'issue view': { kind: 'read', flags: [b('comments', 'c'), WEB, ...OUTPUT] },
  'issue status': { kind: 'read', flags: [...OUTPUT] },
  'run list': {
    kind: 'read',
    flags: [
      ...vs('branch:b', 'commit:c', 'event:e', 'limit:L', 'status:s', 'user:u', 'workflow:w', 'created'),
      b('all', 'a'),
      ...OUTPUT,
    ],
  },
  'run view': {
    kind: 'read',
    flags: [
      ...vs('job:j', 'attempt:a'),
      b('log'),
      b('log-failed'),
      b('exit-status'),
      b('verbose', 'v'),
      WEB,
      ...OUTPUT,
    ],
  },
  'workflow list': { kind: 'read', flags: [v('limit', 'L'), b('all', 'a'), ...OUTPUT] },
  'workflow view': { kind: 'read', flags: [v('ref', 'r'), b('yaml', 'y'), WEB] },
  'release list': {
    kind: 'read',
    flags: [...vs('limit:L', 'order:O'), b('exclude-drafts'), b('exclude-pre-releases'), ...OUTPUT],
  },
  'release view': { kind: 'read', flags: [WEB, ...OUTPUT] },
  'label list': { kind: 'read', flags: [...vs('limit:L', 'search:S', 'sort', 'order'), WEB, ...OUTPUT] },
  'cache list': { kind: 'read', flags: [...vs('limit:L', 'key:k', 'ref:r', 'sort:S', 'order:O'), ...OUTPUT] },
  'repo view': { kind: 'read', repoArg: true, flags: [v('branch', 'b'), WEB, ...OUTPUT] },
  'ruleset list': { kind: 'read', flags: [v('limit', 'L'), RULESET_ORG, b('parents', 'p'), WEB] },
  'ruleset view': { kind: 'read', flags: [RULESET_ORG, b('parents', 'p'), WEB] },
  'ruleset check': { kind: 'read', flags: [RULESET_ORG, b('default'), WEB] },
  ...Object.fromEntries(
    ['issues', 'prs', 'commits', 'code', 'repos'].map((what) => [
      `search ${what}`,
      {
        kind: 'read' as const,
        account: true,
        flags: [
          v('repo', 'R', { own: true }),
          v('owner'),
          ...vs('limit:L', 'sort', 'order', 'language', 'author', 'assignee', 'label', 'state'),
          WEB,
          ...OUTPUT,
        ],
      },
    ]),
  ),

  // Writes and their keys (AGH-05).
  'issue create': {
    kind: 'write',
    key: 'pr.comment',
    target: 'none',
    phrase: () => 'open an issue',
    flags: [
      TITLE,
      ...BODY,
      ...vs('assignee:a', 'label:l', 'milestone:m', 'project:p', 'template:T'),
      v('recover', undefined, { refuse: unsupported('issue create', '--recover') }),
      EDITOR,
      WEB,
    ],
  },
  'issue comment': {
    kind: 'write',
    key: 'pr.comment',
    target: 'issue',
    phrase: (n) => `comment on ${n}`,
    flags: [
      ...BODY,
      b('edit-last'),
      b('create-if-none'),
      b('yes'),
      b('delete-last', undefined, { refuse: notAvailable('issue comment --delete-last') }),
      EDITOR,
      WEB,
    ],
  },
  'issue edit': {
    kind: 'write',
    key: 'pr.comment',
    target: 'issues',
    phrase: (n) => `edit ${n}`,
    flags: [
      TITLE,
      ...BODY,
      ...vs('add-assignee', 'remove-assignee', 'add-label', 'remove-label', 'add-project', 'remove-project'),
      v('milestone', 'm'),
      b('remove-milestone'),
    ],
  },
  'issue close': {
    kind: 'write',
    key: 'pr.comment',
    target: 'issue',
    phrase: (n) => `close ${n}`,
    flags: [COMMENT, ...vs('reason:r', 'duplicate-of')],
  },
  'issue reopen': {
    kind: 'write',
    key: 'pr.comment',
    target: 'issue',
    phrase: (n) => `reopen ${n}`,
    flags: [COMMENT],
  },
  'pr comment': {
    kind: 'write',
    key: 'pr.comment',
    target: 'pr',
    phrase: (n) => `comment on ${n}`,
    flags: [
      ...BODY,
      b('edit-last'),
      b('create-if-none'),
      b('yes'),
      b('delete-last', undefined, { refuse: notAvailable('pr comment --delete-last') }),
      EDITOR,
      WEB,
    ],
  },
  'pr edit': {
    kind: 'write',
    key: 'pr.comment',
    target: 'pr',
    phrase: (n) => `edit ${n}`,
    flags: [
      TITLE,
      ...BODY,
      v('base', 'B'),
      ...vs(
        'add-assignee',
        'remove-assignee',
        'add-reviewer',
        'remove-reviewer',
        'add-label',
        'remove-label',
      ),
      ...vs('add-project', 'remove-project', 'milestone:m'),
      b('remove-milestone'),
    ],
  },
  'pr close': {
    kind: 'write',
    key: 'pr.comment',
    target: 'pr',
    phrase: (n) => `close ${n}`,
    flags: [
      COMMENT,
      b('delete-branch', 'd', { refuse: 'Delete the branch with git: gh pr close -d isn’t available here.' }),
    ],
  },
  'pr reopen': {
    kind: 'write',
    key: 'pr.comment',
    target: 'pr',
    phrase: (n) => `reopen ${n}`,
    flags: [COMMENT],
  },
  'pr ready': {
    kind: 'write',
    key: 'pr.comment',
    target: 'pr',
    phrase: (n) => `mark ${n} ready for review`,
    flags: [b('undo')],
  },
  'label create': {
    kind: 'write',
    key: 'pr.comment',
    target: 'label',
    phrase: (n) => `create ${n}`,
    flags: [v('color', 'c'), v('description', 'd', { text: true }), b('force', 'f')],
  },
  'label edit': {
    kind: 'write',
    key: 'pr.comment',
    target: 'label',
    phrase: (n) => `edit ${n}`,
    flags: [v('color', 'c'), v('description', 'd', { text: true }), v('name', 'n', { text: true })],
  },
  'run rerun': {
    kind: 'write',
    key: 'pipelines.retry',
    target: 'run',
    phrase: (n) => `re-run ${n}`,
    flags: [v('job', 'j'), b('failed'), b('debug', 'd')],
  },
  'run cancel': {
    kind: 'write',
    key: 'ci.run',
    target: 'run',
    phrase: (n) => `cancel ${n}`,
    flags: [b('force')],
  },
  'workflow run': {
    kind: 'write',
    key: 'ci.run',
    target: 'workflow',
    phrase: (n) => `run ${n}`,
    flags: [...vs('ref:r', 'raw-field:f', 'field:F'), b('json', undefined, { refuse: GH_COPY.workflowJson })],
  },
  // A release is published: the Deploy key (AGH-21). Its files come from the repository's release workflow.
  'release create': {
    kind: 'write',
    key: 'deploy',
    target: 'release',
    phrase: (n) => `create ${n}`,
    flags: [
      ...RELEASE,
      b('generate-notes'),
      b('fail-on-no-commits'),
      ...vs('notes-start-tag', 'notes-from-tag'),
    ],
  },
  'release edit': {
    kind: 'write',
    key: 'deploy',
    target: 'release',
    phrase: (n) => `edit ${n}`,
    flags: [...RELEASE, v('tag')],
  },

  // Everything else gh does, by the agent's keys (AGH-23): changes by Write code; publishing by Deploy; deleting and
  // archiving by Destructive commands; giving lasting access (keys, collaborators) and branch updates by Push to main.
  status: { kind: 'read', account: true, flags: [...vs('org:o', 'exclude:e')] },
  'repo list': {
    kind: 'read',
    account: true,
    flags: [...vs('limit:L', 'language:l', 'topic', 'visibility'), ...OUTPUT],
  },
  'repo edit': {
    kind: 'write',
    repoArg: true,
    keyOf: (tokens) =>
      flagValue(tokens, 'visibility')?.toLowerCase() === 'public' ? 'deploy' : 'code.write',
    phrase: () => 'change the repository’s settings',
    flags: [
      ...vs('visibility', 'default-branch', 'description:d', 'homepage:h', 'add-topic', 'remove-topic'),
      ...vs(
        'template',
        'enable-auto-merge',
        'enable-squash-merge',
        'enable-merge-commit',
        'enable-rebase-merge',
      ),
      b('accept-visibility-change-consequences'),
    ],
  },
  'repo rename': {
    kind: 'write',
    key: 'code.write',
    phrase: () => 'rename the repository',
    flags: [b('yes', 'y')],
  },
  'repo archive': {
    kind: 'write',
    repoArg: true,
    key: 'commands.destructive',
    phrase: () => 'archive the repository',
    flags: [b('yes', 'y')],
  },
  'repo unarchive': {
    kind: 'write',
    repoArg: true,
    key: 'code.write',
    phrase: () => 'unarchive the repository',
    flags: [b('yes', 'y')],
  },
  'repo delete': {
    kind: 'write',
    repoArg: true,
    key: 'commands.destructive',
    phrase: () => 'delete the repository',
    flags: [b('yes', 'y')],
  },
  'repo fork': {
    kind: 'write',
    repoArg: true,
    key: 'code.write',
    phrase: () => 'fork the repository',
    flags: [
      ...vs('org', 'fork-name'),
      b('default-branch-only'),
      b('clone', undefined, { refuse: GH_COPY.repoClone.replace('repo create', 'repo fork') }),
      b('remote', undefined, {
        refuse: GH_COPY.repoClone.replace('repo create --clone', 'repo fork --remote'),
      }),
      v('remote-name', undefined, {
        refuse: GH_COPY.repoClone.replace('repo create --clone', 'repo fork --remote'),
      }),
    ],
  },
  'repo sync': {
    kind: 'write',
    repoArg: true,
    keyOf: (tokens) => branchWriteKey(flagValue(tokens, 'branch') ?? 'main', 'main'),
    phrase: () => 'sync the repository from its source',
    flags: [v('branch', 'b'), v('source', 's'), b('force')],
  },
  'repo deploy-key list': { kind: 'read', flags: [...OUTPUT] },
  'repo deploy-key add': {
    kind: 'write',
    key: 'branch.main.push',
    phrase: () => 'add a deploy key',
    check: () =>
      noLocalPath(
        'repo deploy-key add',
        'add it with gh api repos/{owner}/{repo}/keys -f title=… -f key=… instead.',
      ),
    flags: [v('title', 't'), b('allow-write', 'w')],
  },
  'repo deploy-key delete': {
    kind: 'write',
    key: 'commands.destructive',
    phrase: (n) => `delete deploy key ${n}`,
    target: 'none',
    flags: [],
  },
  'repo autolink list': { kind: 'read', flags: [WEB, ...OUTPUT] },
  'repo autolink view': { kind: 'read', flags: [...OUTPUT] },
  'repo autolink create': {
    kind: 'write',
    key: 'code.write',
    phrase: () => 'add an autolink',
    flags: [b('numeric', 'n')],
  },
  'repo autolink delete': {
    kind: 'write',
    key: 'commands.destructive',
    phrase: () => 'delete an autolink',
    flags: [b('yes')],
  },
  'repo gitignore list': { kind: 'read', account: true, flags: [] },
  'repo gitignore view': { kind: 'read', account: true, flags: [] },
  'repo license list': { kind: 'read', account: true, flags: [] },
  'repo license view': { kind: 'read', account: true, flags: [WEB] },
  'issue delete': {
    kind: 'write',
    key: 'commands.destructive',
    target: 'issue',
    phrase: (n) => `delete ${n}`,
    flags: [b('yes')],
  },
  'issue transfer': {
    kind: 'write',
    key: 'code.write',
    target: 'issue',
    phrase: (n) => `transfer ${n}`,
    flags: [],
  },
  'issue pin': { kind: 'write', key: 'pr.comment', target: 'issue', phrase: (n) => `pin ${n}`, flags: [] },
  'issue unpin': {
    kind: 'write',
    key: 'pr.comment',
    target: 'issue',
    phrase: (n) => `unpin ${n}`,
    flags: [],
  },
  'issue lock': {
    kind: 'write',
    key: 'pr.comment',
    target: 'issue',
    phrase: (n) => `lock ${n}`,
    flags: [v('reason', 'r')],
  },
  'issue unlock': {
    kind: 'write',
    key: 'pr.comment',
    target: 'issue',
    phrase: (n) => `unlock ${n}`,
    flags: [],
  },
  'issue develop': {
    kind: 'write',
    key: 'code.write',
    target: 'issue',
    phrase: (n) => `start a branch for ${n}`,
    flags: [
      ...vs('base:b', 'branch-repo', 'name:n'),
      b('list', 'l'),
      b('checkout', 'c', { refuse: GH_COPY.checkout }),
    ],
  },
  'pr lock': {
    kind: 'write',
    key: 'pr.comment',
    target: 'pr',
    phrase: (n) => `lock ${n}`,
    flags: [v('reason', 'r')],
  },
  'pr unlock': { kind: 'write', key: 'pr.comment', target: 'pr', phrase: (n) => `unlock ${n}`, flags: [] },
  'pr update-branch': {
    kind: 'write',
    key: 'code.write',
    target: 'pr',
    phrase: (n) => `update ${n} from its base`,
    flags: [b('rebase')],
  },
  'pr revert': {
    kind: 'write',
    key: 'code.write',
    target: 'pr',
    phrase: (n) => `revert ${n}`,
    flags: [TITLE, ...BODY, b('draft', 'd')],
  },
  'run delete': {
    kind: 'write',
    key: 'commands.destructive',
    target: 'run',
    phrase: (n) => `delete ${n}`,
    flags: [],
  },
  'run watch': { kind: 'read', flags: [v('interval', 'i'), b('exit-status'), b('compact')] },
  'run download': { kind: 'refused', refuse: ghSays('run download', GH_COPY.download), flags: [] },
  'workflow enable': {
    kind: 'write',
    key: 'ci.run',
    target: 'workflow',
    phrase: (n) => `enable ${n}`,
    flags: [],
  },
  'workflow disable': {
    kind: 'write',
    key: 'ci.run',
    target: 'workflow',
    phrase: (n) => `disable ${n}`,
    flags: [],
  },
  'release delete': {
    kind: 'write',
    key: 'commands.destructive',
    target: 'release',
    phrase: (n) => `delete ${n}`,
    flags: [b('yes', 'y'), b('cleanup-tag')],
  },
  'release delete-asset': {
    kind: 'write',
    key: 'commands.destructive',
    target: 'release',
    phrase: (n) => `delete an asset of ${n}`,
    flags: [b('yes', 'y')],
  },
  'release upload': {
    kind: 'write',
    key: 'deploy',
    target: 'release',
    phrase: (n) => `upload to ${n}`,
    check: () => GH_COPY.releaseFiles,
    flags: [b('clobber')],
  },
  'release download': { kind: 'refused', refuse: ghSays('release download', GH_COPY.download), flags: [] },
  'release verify': { kind: 'read', flags: [...OUTPUT] },
  'release verify-asset': {
    kind: 'read',
    check: () =>
      noLocalPath('release verify-asset', 'compare the digest gh release view --json assets gives instead.'),
    flags: [],
  },
  'label delete': {
    kind: 'write',
    key: 'commands.destructive',
    target: 'label',
    phrase: (n) => `delete ${n}`,
    flags: [b('yes')],
  },
  'label clone': {
    kind: 'write',
    key: 'pr.comment',
    phrase: () => 'copy labels from another repository',
    flags: [b('force', 'f')],
  },
  'cache delete': {
    kind: 'write',
    key: 'ci.run',
    phrase: () => 'delete a cache',
    flags: [b('all', 'a'), v('ref', 'r'), b('succeed-on-no-caches')],
  },
  'secret list': {
    kind: 'read',
    accountWith: ['org', 'user'],
    flags: [...vs('org:o', 'env:e', 'app:a'), b('user', 'u'), ...OUTPUT],
  },
  'secret set': {
    kind: 'write',
    key: 'code.write',
    accountWith: ['org', 'user'],
    phrase: () => 'set a secret',
    check: (tokens) => (flagValue(tokens, 'body') === null ? GH_COPY.secretValue : null),
    flags: [
      v('body', 'b'),
      ...vs('org:o', 'env:e', 'app:a', 'visibility:v', 'repos:r'),
      b('user', 'u'),
      b('no-store'),
      b('no-repos-selected'),
      v('env-file', 'f', { refuse: noLocalPath('secret set', 'pass each value with -b.') }),
    ],
  },
  'secret delete': {
    kind: 'write',
    key: 'commands.destructive',
    accountWith: ['org', 'user'],
    phrase: () => 'delete a secret',
    flags: [...vs('org:o', 'env:e', 'app:a'), b('user', 'u')],
  },
  'variable list': { kind: 'read', accountWith: ['org'], flags: [...vs('org:o', 'env:e'), ...OUTPUT] },
  'variable get': { kind: 'read', accountWith: ['org'], flags: [...vs('org:o', 'env:e'), ...OUTPUT] },
  'variable set': {
    kind: 'write',
    key: 'code.write',
    accountWith: ['org'],
    phrase: () => 'set a variable',
    check: (tokens) => (flagValue(tokens, 'body') === null ? GH_COPY.secretValue : null),
    flags: [
      v('body', 'b'),
      ...vs('org:o', 'env:e', 'visibility:v', 'repos:r'),
      v('env-file', 'f', { refuse: noLocalPath('variable set', 'pass each value with -b.') }),
    ],
  },
  'variable delete': {
    kind: 'write',
    key: 'commands.destructive',
    accountWith: ['org'],
    phrase: () => 'delete a variable',
    flags: [...vs('org:o', 'env:e')],
  },
  'ssh-key list': { kind: 'read', account: true, flags: [] },
  'ssh-key add': {
    kind: 'write',
    account: true,
    key: 'branch.main.push',
    phrase: () => 'add an SSH key to the GitHub account',
    check: () => noLocalPath('ssh-key add', 'add it with gh api user/keys -f title=… -f key=… instead.'),
    flags: [v('title', 't'), v('type')],
  },
  'ssh-key delete': {
    kind: 'write',
    account: true,
    key: 'commands.destructive',
    phrase: () => 'delete an SSH key of the GitHub account',
    flags: [b('yes', 'y')],
  },
  'gpg-key list': { kind: 'read', account: true, flags: [] },
  'gpg-key add': {
    kind: 'write',
    account: true,
    key: 'branch.main.push',
    phrase: () => 'add a GPG key to the GitHub account',
    check: () =>
      noLocalPath('gpg-key add', 'add it with gh api user/gpg_keys -f armored_public_key=… instead.'),
    flags: [v('title', 't')],
  },
  'gpg-key delete': {
    kind: 'write',
    account: true,
    key: 'commands.destructive',
    phrase: () => 'delete a GPG key of the GitHub account',
    flags: [b('yes', 'y')],
  },
  'gist list': {
    kind: 'read',
    account: true,
    flags: [...vs('limit:L', 'filter'), b('public'), b('secret'), b('include-content')],
  },
  'gist view': { kind: 'read', account: true, flags: [v('filename', 'f'), b('files'), b('raw', 'r'), WEB] },
  'gist create': {
    kind: 'write',
    account: true,
    keyOf: (tokens) => (hasFlag(tokens, 'public') ? 'deploy' : 'code.write'),
    phrase: () => 'create a gist',
    check: () =>
      noLocalPath(
        'gist create',
        'create it with gh api gists -F "files[name.txt][content]=@name.txt" -F public=false instead.',
      ),
    flags: [v('desc', 'd', { text: true }), v('filename', 'f'), b('public', 'p'), WEB],
  },
  'gist edit': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'edit a gist',
    check: (tokens) =>
      flagValue(tokens, 'desc') === null
        ? noLocalPath(
            'gist edit',
            'change its files with gh api -X PATCH gists/ID -F "files[name.txt][content]=@name.txt".',
          )
        : null,
    flags: [
      v('desc', 'd', { text: true }),
      v('filename', 'f'),
      v('add', 'a', {
        refuse: noLocalPath(
          'gist edit',
          'add files with gh api -X PATCH gists/ID -F "files[name.txt][content]=@name.txt".',
        ),
      }),
      v('remove', 'r'),
    ],
  },
  'gist rename': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'rename a gist file',
    flags: [],
  },
  'gist delete': {
    kind: 'write',
    account: true,
    key: 'commands.destructive',
    phrase: () => 'delete a gist',
    flags: [b('yes')],
  },
  'gist clone': {
    kind: 'refused',
    refuse: 'Clone a gist with git: git clone https://gist.github.com/ID.git.',
    flags: [],
  },
  'org list': { kind: 'read', account: true, flags: [v('limit', 'L')] },
  'auth status': {
    kind: 'read',
    account: true,
    flags: [b('show-token', 't', { refuse: GH_COPY.auth }), b('active', 'a'), v('hostname', 'h'), ...OUTPUT],
  },
  'config get': { kind: 'read', account: true, flags: [v('host', 'h')] },
  'config list': { kind: 'read', account: true, flags: [v('host', 'h')] },
  'alias list': { kind: 'read', account: true, flags: [] },
  'extension list': { kind: 'read', account: true, flags: [] },
  'extension search': {
    kind: 'read',
    account: true,
    flags: [...vs('limit:L', 'license', 'order', 'owner', 'sort'), WEB, ...OUTPUT],
  },
  completion: { kind: 'read', account: true, flags: [v('shell', 's')] },
  browse: {
    kind: 'read',
    check: (tokens) => (hasFlag(tokens, 'no-browser') ? null : GH_COPY.noBrowser),
    flags: [
      b('no-browser', 'n'),
      ...vs('branch:b', 'commit:c'),
      b('projects', 'p'),
      b('releases', 'r'),
      b('settings', 's'),
      b('wiki', 'w'),
      b('actions', 'a'),
    ],
  },
  'attestation trusted-root': { kind: 'read', account: true, flags: [] },
  'attestation verify': {
    kind: 'read',
    account: true,
    check: () =>
      noLocalPath('attestation verify', 'it checks a file of your commands, which gh here can’t read.'),
    flags: [],
  },
  'attestation download': {
    kind: 'refused',
    refuse: ghSays('attestation download', GH_COPY.download),
    flags: [],
  },
  'agent-task list': { kind: 'read', account: true, flags: [v('limit', 'L'), WEB, ...OUTPUT] },
  'agent-task view': { kind: 'read', account: true, flags: [WEB, ...OUTPUT] },
  'agent-task create': {
    kind: 'write',
    key: 'code.write',
    phrase: () => 'start a Copilot coding agent task',
    flags: [
      v('base', 'b'),
      v('custom-agent', 'a'),
      b('follow'),
      v('from-file', 'F', { refuse: noLocalPath('agent-task create', 'pass the task as words.') }),
    ],
  },
  'project list': { kind: 'read', account: true, flags: [v('owner'), v('limit', 'L'), WEB, ...OUTPUT] },
  'project view': { kind: 'read', account: true, flags: [v('owner'), v('limit', 'L'), WEB, ...OUTPUT] },
  'project field-list': { kind: 'read', account: true, flags: [v('owner'), v('limit', 'L'), WEB, ...OUTPUT] },
  'project item-list': { kind: 'read', account: true, flags: [v('owner'), v('limit', 'L'), WEB, ...OUTPUT] },
  'project close': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project copy': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project create': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project edit': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project field-create': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project item-add': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project item-archive': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project item-create': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project item-edit': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project link': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project mark-template': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project unlink': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'change a project',
    flags: [
      v('owner'),
      v('title', undefined, { text: true }),
      v('body', undefined, { text: true }),
      ...OUTPUT,
    ],
  },
  'project delete': {
    kind: 'write',
    account: true,
    key: 'commands.destructive',
    phrase: () => 'delete a project',
    flags: [v('owner'), ...OUTPUT],
  },
  'project field-delete': {
    kind: 'write',
    account: true,
    key: 'commands.destructive',
    phrase: () => 'delete a project field',
    flags: [v('owner'), ...OUTPUT],
  },
  'project item-delete': {
    kind: 'write',
    account: true,
    key: 'commands.destructive',
    phrase: () => 'delete a project item',
    flags: [v('owner'), ...OUTPUT],
  },
  'codespace list': {
    kind: 'read',
    account: true,
    flags: [
      v('repo', 'R', { own: true }),
      ...vs('codespace:c', 'repo-owner', 'limit:L', 'org:o', 'user:u'),
      b('web', 'w', { refuse: GH_COPY.web }),
      ...OUTPUT,
    ],
  },
  'codespace view': {
    kind: 'read',
    account: true,
    flags: [
      v('repo', 'R', { own: true }),
      ...vs('codespace:c', 'repo-owner', 'limit:L', 'org:o', 'user:u'),
      b('web', 'w', { refuse: GH_COPY.web }),
      ...OUTPUT,
    ],
  },
  'codespace logs': {
    kind: 'read',
    account: true,
    flags: [
      v('repo', 'R', { own: true }),
      ...vs('codespace:c', 'repo-owner', 'limit:L', 'org:o', 'user:u'),
      b('web', 'w', { refuse: GH_COPY.web }),
      ...OUTPUT,
    ],
  },
  'codespace create': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'create a codespace',
    flags: [
      v('repo', 'R', { own: true }),
      ...vs(
        'codespace:c',
        'repo-owner',
        'branch:b',
        'machine:m',
        'location:l',
        'display-name:d',
        'idle-timeout',
        'retention-period',
        'devcontainer-path',
        'org:o',
        'user:u',
      ),
      b('default-permissions'),
      b('status', 's'),
      b('web', 'w', { refuse: GH_COPY.web }),
      b('full'),
    ],
  },
  'codespace edit': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'edit a codespace',
    flags: [
      v('repo', 'R', { own: true }),
      ...vs(
        'codespace:c',
        'repo-owner',
        'branch:b',
        'machine:m',
        'location:l',
        'display-name:d',
        'idle-timeout',
        'retention-period',
        'devcontainer-path',
        'org:o',
        'user:u',
      ),
      b('default-permissions'),
      b('status', 's'),
      b('web', 'w', { refuse: GH_COPY.web }),
      b('full'),
    ],
  },
  'codespace stop': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'stop a codespace',
    flags: [
      v('repo', 'R', { own: true }),
      ...vs(
        'codespace:c',
        'repo-owner',
        'branch:b',
        'machine:m',
        'location:l',
        'display-name:d',
        'idle-timeout',
        'retention-period',
        'devcontainer-path',
        'org:o',
        'user:u',
      ),
      b('default-permissions'),
      b('status', 's'),
      b('web', 'w', { refuse: GH_COPY.web }),
      b('full'),
    ],
  },
  'codespace rebuild': {
    kind: 'write',
    account: true,
    key: 'code.write',
    phrase: () => 'rebuild a codespace',
    flags: [
      v('repo', 'R', { own: true }),
      ...vs(
        'codespace:c',
        'repo-owner',
        'branch:b',
        'machine:m',
        'location:l',
        'display-name:d',
        'idle-timeout',
        'retention-period',
        'devcontainer-path',
        'org:o',
        'user:u',
      ),
      b('default-permissions'),
      b('status', 's'),
      b('web', 'w', { refuse: GH_COPY.web }),
      b('full'),
    ],
  },
  'codespace delete': {
    kind: 'write',
    account: true,
    key: 'commands.destructive',
    phrase: () => 'delete a codespace',
    flags: [
      v('repo', 'R', { own: true }),
      ...vs('codespace:c', 'repo-owner', 'days', 'org:o', 'user:u'),
      b('all'),
      b('force', 'f'),
    ],
  },
  'codespace ssh': { kind: 'refused', refuse: ghSays('codespace ssh', GH_COPY.terminal), flags: [] },
  'codespace code': { kind: 'refused', refuse: ghSays('codespace code', GH_COPY.terminal), flags: [] },
  'codespace jupyter': { kind: 'refused', refuse: ghSays('codespace jupyter', GH_COPY.terminal), flags: [] },
  'codespace cp': { kind: 'refused', refuse: ghSays('codespace cp', GH_COPY.terminal), flags: [] },
  'codespace ports': { kind: 'refused', refuse: ghSays('codespace ports', GH_COPY.terminal), flags: [] },

  // Made by Whombat as the GitHub connection (AGH-19).
  'repo create': {
    kind: 'repo_create',
    flags: [
      b('public'),
      b('private'),
      b('internal'),
      v('description', 'd', { text: true }),
      v('homepage', 'h', { text: true }),
      v('template', 'p'),
      b('include-all-branches'),
      b('add-readme'),
      v('gitignore', 'g'),
      v('license', 'l'),
      b('disable-issues'),
      b('disable-wiki'),
      b('confirm', 'y'),
      v('source', 's', { refuse: GH_COPY.repoSource }),
      b('push', undefined, { refuse: GH_COPY.repoSource }),
      v('remote', 'r', { refuse: GH_COPY.repoSource }),
      b('clone', 'c', { refuse: GH_COPY.repoClone }),
      v('team', 't', { refuse: unsupported('repo create', '--team') }),
    ],
  },

  // Whombat's own commands (AGH-05).
  'pr create': {
    kind: 'pr_create',
    flags: [
      TITLE,
      ...BODY,
      v('base', 'B'),
      v('head', 'H'),
      ...['draft:d', 'fill:f', 'fill-first', 'fill-verbose', 'dry-run', 'no-maintainer-edit'].map((s) => {
        const [long, short] = s.split(':') as [string, string | undefined];
        return b(long, short, { refuse: unsupported('pr create', `--${long}`) });
      }),
      ...['reviewer:r', 'label:l', 'assignee:a', 'milestone:m', 'project:p', 'template:T', 'recover'].map(
        (s) => {
          const [long, short] = s.split(':') as [string, string | undefined];
          return v(long, short, { refuse: unsupported('pr create', `--${long}`) });
        },
      ),
      EDITOR,
      WEB,
    ],
  },
  'pr merge': {
    kind: 'pr_merge',
    target: 'pr',
    flags: [
      // The method is the agent's (AGH-22; none: a squash, like merge_pull_request); the message and branch Whombat's.
      b('squash', 's'),
      b('merge', 'm'),
      b('rebase', 'r'),
      b('delete-branch', 'd'),
      v('body', 'b', { text: true }),
      v('body-file', 'F', { file: true }),
      v('subject', 't', { text: true }),
      ...vs('match-head-commit', 'author-email:A'),
      ...['auto', 'disable-auto', 'admin'].map((long) =>
        b(long, undefined, {
          refuse: `gh pr merge --${long} isn’t supported here: Whombat merges by its own rules.`,
        }),
      ),
    ],
  },
  'pr review': {
    kind: 'pr_review',
    target: 'pr',
    flags: [b('approve', 'a'), b('request-changes', 'r'), b('comment', 'c'), ...BODY, EDITOR],
  },

  api: {
    kind: 'api',
    flags: [
      ...vs('method:X', 'raw-field:f', 'header:H', 'jq:q', 'template:t', 'cache'),
      v('field', 'F', { field: true }),
      v('input', undefined, { file: true }),
      b('paginate'),
      b('slurp'),
      b('include', 'i'),
      b('silent'),
    ],
  },
};

/** gh's other names for a group. */
const ALIASES: Readonly<Record<string, string>> = {
  cs: 'codespace',
  ext: 'extension',
  extensions: 'extension',
};

/** Why a command gh has isn't run here (AGH-23): what it would need that isn't there, or Whombat's own boundary. */
function refusalOf(name: string, group: string): string {
  if (name === 'repo clone' || name === 'pr checkout') return GH_COPY.checkout;
  if (name === 'repo set-default') return GH_COPY.setDefault;
  if (group === 'auth') return GH_COPY.auth;
  if (group === 'config') return GH_COPY.config;
  if (group === 'alias' || group === 'extension' || group === 'copilot')
    return ghSays(name, GH_COPY.runnerCode);
  if (group === 'codespace' || group === 'preview') return ghSays(name, GH_COPY.terminal);
  return ghSays(name, GH_COPY.unknown);
}

/** Groups with subcommands: the second word is part of the command. */
const GROUPS = new Set([
  'pr',
  'issue',
  'run',
  'workflow',
  'release',
  'label',
  'cache',
  'repo',
  'ruleset',
  'search',
  'secret',
  'variable',
  'ssh-key',
  'gpg-key',
  'gist',
  'org',
  'project',
  'codespace',
  'attestation',
  'auth',
  'config',
  'alias',
  'extension',
  'agent-task',
  'preview',
]);
/** Groups inside a group: the third word is part of the command too. */
const SUBGROUPS = new Set(['repo deploy-key', 'repo autolink', 'repo gitignore', 'repo license']);
/** A word that names a file of the agent's commands (`/etc/x`, `~/x`, `./x`, `../x`): Whombat's side would read its own. */
const LOCAL_PATH = /^(?:\/|~|\.\.?\/)|\/\.\.\//;

/* Words --------------------------------------------------------------------------------------------- */

type FlagToken = {
  kind: 'flag';
  spec: FlagSpec | null;
  /** As written, without its value (`-F`, `--body-file`; a boolean's `--draft=false` whole). */
  name: string;
  value: string | null;
};
type Token = FlagToken | { kind: 'pos'; value: string } | { kind: 'end' };

class Refusal extends Error {
  /** A GitHub repository the command names that isn't switched on (yet): Whombat may add it (agent-repos.md AGR-01). */
  repo?: string;
}
const refuse = (message: string, repo?: string): never => {
  const r = new Refusal(message);
  if (repo) r.repo = repo;
  throw r;
};

/** The words as gh's flag parser reads them, the command's flags (and the global ones) known. */
function tokenize(words: readonly string[], flags: readonly FlagSpec[]): Token[] {
  const all = [...GLOBAL, ...flags];
  const byLong = new Map(all.map((f) => [f.long, f]));
  const byShort = new Map(all.flatMap((f) => (f.short ? [[f.short, f] as const] : [])));
  const out: Token[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    const next = (flag: string) => {
      if (i + 1 >= words.length) refuse(needsValue(flag));
      i += 1;
      return words[i] as string;
    };
    if (w === '--') {
      out.push({ kind: 'end' });
      for (const rest of words.slice(i + 1)) out.push({ kind: 'pos', value: rest });
      break;
    }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=');
      const long = eq < 0 ? w.slice(2) : w.slice(2, eq);
      const spec = byLong.get(long) ?? null;
      if (spec?.value)
        out.push({ kind: 'flag', spec, name: `--${long}`, value: eq < 0 ? next(w) : w.slice(eq + 1) });
      else out.push({ kind: 'flag', spec, name: w, value: null });
      continue;
    }
    if (w.startsWith('-') && w.length > 1) {
      // One short flag, or a cluster: the first one that takes a value takes the rest (or the next word).
      for (let j = 1; j < w.length; j++) {
        const letter = w[j] as string;
        const spec = byShort.get(letter) ?? null;
        if (spec?.value) {
          const rest = w.slice(j + 1);
          out.push({
            kind: 'flag',
            spec,
            name: `-${letter}`,
            value: rest.length ? rest : next(`-${letter}`),
          });
          break;
        }
        out.push({ kind: 'flag', spec, name: `-${letter}`, value: null });
      }
      continue;
    }
    out.push({ kind: 'pos', value: w });
  }
  return out;
}

const GITHUB_URL =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:[/?#].*)?$/i;
const OTHER_URL = /^[a-z][a-z0-9+.-]*:\/\//i;
const NAME = /^[A-Za-z0-9_.-]+$/;
const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;
const PR_URL = /\/pull\/(\d+)(?:[/?#].*)?$/;
const ISSUE_URL = /\/(?:issues|pull)\/(\d+)(?:[/?#].*)?$/;

/** `owner/name`, `github.com/owner/name` or a github.com URL (`-R`, AGH-04). */
function repoRef(value: string): string {
  const url = GITHUB_URL.exec(value);
  if (url) return `${url[1]}/${url[2]}`;
  if (OTHER_URL.test(value)) refuse(GH_COPY.hostname);
  const parts = value.split('/');
  if (parts.length === 3) {
    if (parts[0]?.toLowerCase() !== 'github.com') refuse(GH_COPY.hostname);
    parts.shift();
  }
  if (parts.length !== 2 || !parts.every((p) => NAME.test(p))) refuse(notRepo(value));
  return parts.join('/');
}

/** The repo a command names, each way it can: they must all agree (AGH-04). */
class Named {
  private readonly seen: string[] = [];
  add(repo: string): void {
    if (this.seen.some((s) => s.toLowerCase() !== repo.toLowerCase())) refuse(GH_COPY.oneRepo);
    this.seen.push(repo);
  }
  get repo(): string | null {
    return this.seen[0] ?? null;
  }
}

/** The repo (AGH-04): named, else the turn's, else the only one; switched on, canonical. */
function resolveRepo(named: string | null, ctx: GhPlanContext): string {
  const wanted = named ?? ctx.defaultRepo ?? (ctx.repos.length === 1 ? (ctx.repos[0] as string) : null);
  if (!wanted) return refuse(ctx.repos.length ? sayRepo(ctx.repos) : GH_COPY.noRepos);
  const found = ctx.repos.find((r) => r.toLowerCase() === wanted.toLowerCase());
  if (found) return found;
  if (wanted.toLowerCase().startsWith('local/')) refuse(localRepo(wanted));
  return refuse(notSwitchedOn(wanted), wanted);
}

function hostname(value: string): void {
  if (value.toLowerCase() !== 'github.com') refuse(GH_COPY.hostname);
}

/** The index of a file the stand-in sent, by the path as written. */
function fileIndex(ctx: GhPlanContext, path: string): number {
  const n = ctx.files.findIndex((f) => f.path === path);
  if (n < 0) refuse(noFile(path));
  return n;
}

/** A body's text from a file, or stdin (`-`). */
function fileText(ctx: GhPlanContext, path: string): string {
  if (path === '-') return ctx.stdin ?? '';
  return (ctx.files[fileIndex(ctx, path)] as { text: string }).text;
}

/** “— Dusty via Whombat” under a body, once (AGH-13). */
function signed(text: string, signature: string | null): string {
  if (!signature || !text.trim() || text.trimEnd().endsWith(signature)) return text;
  return `${text.trimEnd()}\n\n${signature}`;
}

/** A pull request a `pr` command names: `12`, `#12`, its URL, or a branch (`owner:branch` for this owner). */
function prRef(value: string, repo: string): GhPrRef {
  const n = /^#?(\d+)$/.exec(value) ?? PR_URL.exec(value);
  if (n) return { number: Number(n[1]) };
  return { branch: headBranch(value, repo) };
}

function headBranch(value: string, repo: string): string {
  const colon = value.indexOf(':');
  if (colon < 0) return value;
  if (value.slice(0, colon).toLowerCase() !== (repo.split('/')[0] as string).toLowerCase())
    refuse(GH_COPY.fork);
  return value.slice(colon + 1);
}

/** `#12` for `12`, `#12` or an issue's or pull request's URL; else the word. */
function numbered(word: string): string {
  const m = /^#?(\d+)$/.exec(word) ?? ISSUE_URL.exec(word);
  return m ? `#${m[1]}` : word;
}

/** What a write's target words name, for its action phrase (“issue #12”, “the pull request for feat/x”). */
function noun(target: Target, positionals: readonly string[], insertedBranch: string | null): string {
  const first = positionals[0];
  switch (target) {
    case 'none':
      return '';
    case 'issue':
      return first ? `issue ${numbered(first)}` : 'an issue';
    case 'issues':
      if (positionals.length > 1) return `issues ${positionals.map(numbered).join(', ')}`;
      return first ? `issue ${numbered(first)}` : 'an issue';
    case 'pr': {
      const branch = insertedBranch ?? (first && !numbered(first).startsWith('#') ? first : null);
      if (branch) return `the pull request for ${branch}`;
      return first ? `PR ${numbered(first)}` : 'a pull request';
    }
    case 'label':
      return first ? `the label “${first}”` : 'a label';
    case 'run':
      return first ? `workflow run ${first}` : 'a workflow run';
    case 'workflow':
      return `the workflow “${first ?? ''}”`;
    case 'release':
      return `release ${first ?? ''}`;
  }
}

/** The command words up to the first flag, at most four, each cut short (AGH-13). */
function commandWords(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of args) {
    if (w.startsWith('-') || out.length === 4) break;
    out.push(w.length > 100 ? `${w.slice(0, 99)}…` : w);
  }
  return out;
}

/** The tokens back as words: -R and --hostname out, a value always its own word (or as `rewrite` says). */
function wordsOf(
  tokens: readonly Token[],
  rewrite: (t: FlagToken) => string[] | null = () => null,
): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'end') out.push('--');
    else if (t.kind === 'pos') out.push(t.value);
    else if ((t.spec?.long === 'repo' && !t.spec.own) || t.spec?.long === 'hostname') continue;
    else {
      const replaced = rewrite(t);
      if (replaced) out.push(...replaced);
      else if (t.value === null) out.push(t.name);
      else out.push(t.name, t.value);
    }
  }
  return out;
}

function flagValue(tokens: readonly Token[], long: string): string | null {
  let found: string | null = null;
  for (const t of tokens) if (t.kind === 'flag' && t.spec?.long === long && t.value !== null) found = t.value;
  return found;
}

function hasFlag(tokens: readonly Token[], long: string): boolean {
  return tokens.some((t) => t.kind === 'flag' && t.spec?.long === long && !/=(false|0)$/i.test(t.name));
}

/** `-b` or `-F` (a file, or `-` for stdin): the last one given. */
function bodyOf(tokens: readonly Token[], ctx: GhPlanContext): string | null {
  let body: string | null = null;
  for (const t of tokens) {
    if (t.kind !== 'flag' || t.value === null) continue;
    if (t.spec?.long === 'body') body = t.value;
    if (t.spec?.long === 'body-file') body = fileText(ctx, t.value);
  }
  return body;
}

/** The checkout's branch, for a `pr` command that names no pull request (gh would ask git, and there is none). */
function branchFor(repo: string, ctx: GhPlanContext): string | null {
  return ctx.checkout && ctx.checkout.repo.toLowerCase() === repo.toLowerCase() ? ctx.checkout.branch : null;
}

/* The planner --------------------------------------------------------------------------------------- */

/**
 * Plans one `gh` command (the words after `gh`) for the turn (AGH-04, AGH-05, AGH-07, AGH-08). Never throws for what
 * the agent wrote: anything it can't run is a `refuse`.
 */
export function planGh(args: readonly string[], ctx: GhPlanContext): GhPlan {
  try {
    return plan(args, ctx);
  } catch (err) {
    if (err instanceof Refusal)
      return { kind: 'refuse', message: err.message, exitCode: 1, ...(err.repo ? { repo: err.repo } : {}) };
    throw err;
  }
}

/**
 * The command (its group and, for a group, the subcommand) past the global flags before it, which are only `-R`,
 * `--repo`, `--hostname`, help and `--version` (cobra would guess at any other flag's value there).
 */
function splitCommand(args: readonly string[]): { pre: string[]; path: string[]; rest: string[] } {
  const pre: string[] = [];
  const path: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const w = args[i] as string;
    if (w.startsWith('-') && w !== '-') {
      if (path.length) break;
      const takesValue = w === '-R' || w === '--repo' || w === '--hostname';
      const attached = /^-R./.test(w) || w.startsWith('--repo=') || w.startsWith('--hostname=');
      if (!takesValue && !attached && !['--help', '-h', '--version'].includes(w)) refuse(GH_COPY.flagsFirst);
      pre.push(w);
      if (takesValue) {
        if (i + 1 >= args.length) refuse(needsValue(w));
        pre.push(args[++i] as string);
      }
      continue;
    }
    const depth = GROUPS.has(path[0] ?? '') ? (SUBGROUPS.has(path.slice(0, 2).join(' ')) ? 3 : 2) : 1;
    if (!COMMAND_NAME.test(w) || path.length === depth) break;
    path.push(path.length === 0 ? (ALIASES[w] ?? w) : w);
  }
  return { pre, path, rest: args.slice(i) };
}

/** The leading command names of some words (for `gh help …`), at most three. */
function helpWords(args: readonly string[]): string[] {
  const out: string[] = [];
  for (const w of args) {
    if (!COMMAND_NAME.test(w) || out.length === 3) break;
    out.push(w);
  }
  return out;
}

function plan(args: readonly string[], ctx: GhPlanContext): GhPlan {
  if (args.some((a) => a.includes('@whombat-file:'))) refuse(GH_COPY.placeholder);
  const { pre, path, rest } = splitCommand(args);
  const group = path[0] ?? '';
  const name = path.join(' ');
  const spec = COMMANDS[name];

  // The version and help run with no repo; help always as `gh help <command>`, which only prints (AGH-05).
  if (pre.includes('--version') || group === 'version')
    return { kind: 'read', args: ['--version'], repo: null };
  const asksHelp =
    path.length === 0 ||
    group === 'help' ||
    (GROUPS.has(group) && path.length === 1) ||
    SUBGROUPS.has(name) ||
    pre.includes('--help') ||
    pre.includes('-h') ||
    (spec
      ? tokenize(rest, spec.flags).some((t) => t.kind === 'flag' && t.spec?.long === 'help')
      : rest.some((w) => w === '--help' || w === '-h'));
  if (asksHelp) {
    const words = group === 'help' ? helpWords(rest) : helpWords([...path, ...rest]);
    return { kind: 'read', args: ['help', ...words], repo: null };
  }

  if (!spec) return refuse(refusalOf(name, group));
  if (spec.kind === 'refused') return refuse(spec.refuse ?? refusalOf(name, group));

  const named = new Named();
  for (let i = 0; i < pre.length; i++) {
    const w = pre[i] as string;
    if (w === '-R' || w === '--repo') named.add(repoRef(pre[++i] as string));
    else if (w === '--hostname') hostname(pre[++i] as string);
    else if (w.startsWith('--repo=')) named.add(repoRef(w.slice('--repo='.length)));
    else if (w.startsWith('--hostname=')) hostname(w.slice('--hostname='.length));
    else if (w.startsWith('-R')) named.add(repoRef(w.slice(2)));
  }

  const tokens = tokenize(rest, spec.flags);
  const positionals: string[] = [];
  for (const t of tokens) {
    if (t.kind === 'pos') positionals.push(t.value);
    if (t.kind !== 'flag') continue;
    if (t.spec?.refuse) refuse(t.spec.refuse);
    if (t.spec?.long === 'repo' && t.value !== null && !t.spec.own) named.add(repoRef(t.value));
    if (t.spec?.long === 'hostname') hostname(t.value as string);
    // --web on a command that doesn't list it (gh would open a browser, or fail).
    if (/^--web(=|$)/.test(t.name) && !/=(false|0)$/i.test(t.name)) refuse(GH_COPY.web);
    if (!t.spec && STRICT.has(spec.kind)) refuse(unsupported(name, t.name.split('=')[0] as string));
  }
  if (spec.kind === 'repo_create') return planRepoCreate(tokens, positionals, named);
  // gh runs on Whombat's side: a path of the agent's commands would be read there (AGH-08, AGH-23). Files reach gh only
  // as -F/--body-file and gh api's --input and -F key=@file, which the stand-in sends.
  if (spec.kind !== 'api') {
    const words = [
      ...positionals,
      ...tokens.flatMap((t) =>
        t.kind === 'flag' && t.value && !t.spec?.text && !t.spec?.body && !t.spec?.file ? [t.value] : [],
      ),
    ];
    const local = words.find((w) => LOCAL_PATH.test(w));
    if (local)
      refuse(
        noLocalPath(name, `give its contents with -F/--body-file, or use gh api with -F key=@${local}.`),
      );
  }
  const checked = spec.check?.(tokens, positionals);
  if (checked) refuse(checked);
  const account =
    spec.account === true ||
    (spec.accountWith ?? []).some((f) => hasFlag(tokens, f) || flagValue(tokens, f) !== null);
  if (spec.kind === 'api') return planApi(tokens, positionals, named, ctx);
  if (account) {
    if (spec.kind === 'read') return { kind: 'read', args: [...path, ...wordsOf(tokens)], repo: null };
    return planWrite(path, tokens, positionals, null, spec, ctx);
  }
  // A github.com URL among the words names the repo as surely as -R does (gh follows it); other hosts are refused.
  const scanned = [
    ...positionals,
    ...tokens.flatMap((t) =>
      t.kind === 'flag' && t.value && !t.spec?.text && !t.spec?.body ? [t.value] : [],
    ),
  ];
  for (const w of scanned) {
    const url = GITHUB_URL.exec(w);
    if (url && /^(?:https?:\/\/)?(?:www\.)?github\.com\//i.test(w)) named.add(`${url[1]}/${url[2]}`);
    // A word naming an issue, a pull request, a run or a repository on another host (a URL as data passes).
    else if (
      OTHER_URL.test(w) &&
      positionals[0] === w &&
      ((spec.target && spec.target !== 'none') || spec.repoArg)
    )
      refuse(GH_COPY.hostname);
  }
  if (spec.repoArg && positionals[0] && !GITHUB_URL.test(positionals[0])) named.add(repoRef(positionals[0]));

  const repo = resolveRepo(named.repo, ctx);
  // A command whose first word is the repository gets the canonical one there (gh's own lookup would need a checkout).
  const resolved = spec.repoArg ? withRepoArg(tokens, repo) : tokens;
  switch (spec.kind) {
    case 'read':
      return planRead(path, resolved, positionals, repo, spec, ctx);
    case 'write':
      return planWrite(path, resolved, positionals, repo, spec, ctx);
    case 'pr_create':
      return planPrCreate(tokens, repo, ctx);
    case 'pr_merge':
      return planPrPick('merge', tokens, positionals, repo, ctx);
    case 'pr_review':
      return planPrPick('review', tokens, positionals, repo, ctx);
  }
}

/** The tokens with the repository as their first word: in place of the one named, or before the rest. */
function withRepoArg(tokens: Token[], repo: string): Token[] {
  const first = tokens.findIndex((t) => t.kind === 'pos');
  const word = { kind: 'pos' as const, value: repo };
  if (first < 0) return [word, ...tokens];
  return tokens.map((t, i) => (i === first ? word : t));
}

function planRead(
  path: string[],
  tokens: Token[],
  positionals: string[],
  repo: string,
  spec: CommandSpec,
  ctx: GhPlanContext,
): GhPlan {
  const branch = spec.target === 'pr' && positionals.length === 0 ? branchFor(repo, ctx) : null;
  return { kind: 'read', args: [...path, ...(branch ? [branch] : []), ...wordsOf(tokens)], repo };
}

function planWrite(
  path: string[],
  tokens: Token[],
  positionals: string[],
  repo: string | null,
  spec: CommandSpec,
  ctx: GhPlanContext,
): GhPlan {
  let keyId = spec.keyOf ? spec.keyOf(tokens, positionals) : (spec.key as KeyId);
  if (path[0] === 'release') {
    if (!positionals[0]) refuse(GH_COPY.releaseTag);
    // `gh release create v1 app.apk`: the stand-in sends no such files (AGH-21).
    if (path[1] === 'create' && positionals.length > 1) refuse(GH_COPY.releaseFiles);
  }
  if (path.join(' ') === 'workflow run' && repo) {
    const workflow = positionals[0];
    if (!workflow) return refuse(GH_COPY.workflowMissing);
    keyId = workflowKey(workflow, repo, ctx);
    if (tokens.some((t) => t.kind === 'flag' && t.spec?.long === 'field' && /^[^=]*=@/.test(t.value ?? '')))
      refuse(GH_COPY.workflowFieldFile);
  }
  // A file's word becomes its placeholder (AGH-08); that is what an approval's hash covers.
  const placed = (t: FlagToken) =>
    t.spec?.file && t.value !== null && t.value !== '-'
      ? [t.name, ghFilePlaceholder(fileIndex(ctx, t.value))]
      : null;
  const hashArgs = [...path, ...wordsOf(tokens, placed)];
  // What runs: bodies signed — inline ones, and a file or stdin turned into --body when it fits in a word (AGH-13).
  const run = wordsOf(tokens, (t) => {
    if (!t.spec?.body || t.value === null) return placed(t);
    const text = t.spec.file ? fileText(ctx, t.value) : t.value;
    const body = signed(text, ctx.signature);
    if (t.spec.file && body.length > WORD_MAX) return placed(t);
    return [t.spec.file ? (t.spec.inline ?? '--body') : t.name, body];
  });
  const branch = repo && spec.target === 'pr' && positionals.length === 0 ? branchFor(repo, ctx) : null;
  const args = [...path, ...(branch ? [branch] : []), ...run];
  const phrase = spec.phrase as (n: string) => string;
  return {
    kind: 'write',
    args,
    repo,
    keyId,
    action: phrase(noun(spec.target ?? 'none', positionals, branch)),
    words: commandWords(args),
    hashArgs,
  };
}

/** `ci.run`, or `deploy` for the host's deploy workflow or one whose file or name says so (AGH-05). */
function workflowKey(workflow: string, repo: string, ctx: GhPlanContext): KeyId {
  if (/^\d+$/.test(workflow)) refuse(GH_COPY.workflowFile);
  const configured = ctx.deployWorkflows(repo).map((f) => f.toLowerCase());
  const w = workflow.toLowerCase();
  if (configured.some((f) => f === w || f.replace(/\.ya?ml$/, '') === w)) return 'deploy';
  if (/deploy|release|publish/i.test(workflow)) return 'deploy';
  // A deploy workflow configured by its id could be any file: every workflow run of the repo counts as a deploy.
  if (configured.some((f) => /^\d+$/.test(f))) return 'deploy';
  // With a deploy workflow configured, a workflow's name could be it under another file name: the file says for sure.
  if (configured.length && !/\.ya?ml$/.test(w)) refuse(GH_COPY.workflowFile);
  return 'ci.run';
}

function planPrCreate(tokens: Token[], repo: string, ctx: GhPlanContext): GhPlan {
  const title = flagValue(tokens, 'title')?.trim();
  if (!title) return refuse(GH_COPY.title);
  const headWord = flagValue(tokens, 'head');
  const head = headWord ? headBranch(headWord, repo) : branchFor(repo, ctx);
  if (!head) return refuse(sayBranch(repo));
  return {
    kind: 'whombat',
    repo,
    op: { op: 'pr_create', title, body: bodyOf(tokens, ctx) ?? '', base: flagValue(tokens, 'base'), head },
  };
}

function planPrPick(
  which: 'merge' | 'review',
  tokens: Token[],
  positionals: string[],
  repo: string,
  ctx: GhPlanContext,
): GhPlan {
  const word = positionals[0];
  const branch = branchFor(repo, ctx);
  const pr: GhPrRef | null = word ? prRef(word, repo) : branch ? { branch } : null;
  if (!pr) return refuse(sayPr(which));
  if (which === 'merge') {
    const methods = (['merge', 'squash', 'rebase'] as const).filter((m) => hasFlag(tokens, m));
    if (methods.length > 1) refuse(GH_COPY.mergeMethod);
    return { kind: 'whombat', repo, op: { op: 'pr_merge', pr, method: methods[0] ?? null } };
  }
  const decisions = (['approve', 'request-changes', 'comment'] as const).filter((d) => hasFlag(tokens, d));
  if (decisions.length !== 1) refuse(GH_COPY.reviewDecision);
  const decision =
    decisions[0] === 'request-changes' ? 'request_changes' : (decisions[0] as 'approve' | 'comment');
  const body = bodyOf(tokens, ctx) ?? '';
  if (decision !== 'approve' && !body.trim()) refuse(GH_COPY.reviewBody);
  return { kind: 'whombat', repo, op: { op: 'pr_review', pr, decision, body } };
}

/** `gh repo create [owner/]name --public|--private|--internal …` (AGH-19, AGH-20). */
function planRepoCreate(tokens: Token[], positionals: string[], named: Named): GhPlan {
  if (named.repo) refuse(GH_COPY.repoNamed);
  if (positionals.length !== 1) refuse(GH_COPY.repoName);
  const word = positionals[0] as string;
  const parts = word.split('/');
  const nameOk = (p: string | undefined) => !!p && NAME.test(p) && p.length <= 100 && p !== '.' && p !== '..';
  if (parts.length > 2 || !parts.every(nameOk)) refuse(badRepoName(word));
  const [owner, name] = parts.length === 2 ? [parts[0] as string, parts[1] as string] : [null, word];
  const visibilities = (['public', 'private', 'internal'] as const).filter((f) => hasFlag(tokens, f));
  if (visibilities.length !== 1) refuse(GH_COPY.repoVisibility);
  const visibility = visibilities[0] as 'public' | 'private' | 'internal';
  const templateWord = flagValue(tokens, 'template');
  const template = templateWord ? repoRef(templateWord) : null;
  if (template) {
    // GitHub makes a repository from a template with its files and a visibility of public or private, nothing else.
    for (const flag of ['add-readme', 'gitignore', 'license', 'homepage', 'disable-issues', 'disable-wiki'])
      if (hasFlag(tokens, flag)) refuse(templateWith(`--${flag}`));
    if (visibility === 'internal') refuse(templateWith('--internal'));
  } else if (hasFlag(tokens, 'include-all-branches')) refuse('--include-all-branches needs --template.');
  return {
    kind: 'create_repo',
    repo: {
      owner,
      name,
      visibility,
      description: flagValue(tokens, 'description'),
      homepage: flagValue(tokens, 'homepage'),
      template,
      includeAllBranches: hasFlag(tokens, 'include-all-branches'),
      addReadme: hasFlag(tokens, 'add-readme'),
      gitignore: flagValue(tokens, 'gitignore'),
      license: flagValue(tokens, 'license'),
      hasIssues: !hasFlag(tokens, 'disable-issues'),
      hasWiki: !hasFlag(tokens, 'disable-wiki'),
    },
    keyId: visibility === 'public' ? 'deploy' : 'code.write',
    action: `create the ${visibility} repository`,
    words: ['repo', 'create'],
    hashArgs: ['repo', 'create', ...wordsOf(tokens)],
  };
}

/* gh api (AGH-07, AGH-23) -------------------------------------------------------------------------- */

interface ApiWrite {
  keyId: KeyId;
  action: string;
  /** A comment's or an issue's `body` gets the signature line (AGH-13). */
  signs: boolean;
  branch?: string;
}

/** The `-f`/`-F` fields by name, a file's or stdin's text for `@…` (the last one of a name wins). */
function fieldsOf(tokens: readonly Token[], ctx: GhPlanContext): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of tokens) {
    if (t.kind !== 'flag' || t.value === null) continue;
    if (t.spec?.long !== 'raw-field' && t.spec?.long !== 'field') continue;
    const m = /^([^=]*)=([\s\S]*)$/.exec(t.value);
    if (!m) continue;
    const value = m[2] as string;
    out.set(m[1] as string, t.spec.field && value.startsWith('@') ? fileText(ctx, value.slice(1)) : value);
  }
  return out;
}

/**
 * What an api write changes and the key that decides it (AGH-23). Merges and reviews stay Whombat's (its rules, its
 * cards); everything else runs by the agent's keys: publishing (public, releases, Pages, deployments) by Deploy;
 * deleting, archiving and transferring by Destructive commands; lasting access (keys, collaborators, invitations) by
 * Push to main; a branch's commits by that branch's key; the rest by Write code.
 */
function apiWrite(
  method: string,
  segments: readonly string[],
  repo: string | null,
  fields: ReadonlyMap<string, string>,
  ctx: GhPlanContext,
): ApiWrite {
  const n = (s: string | undefined) => !!s && /^\d+$/.test(s);
  const code = (action: string): ApiWrite => ({ keyId: 'code.write', action, signs: false });
  const destroy = (action: string): ApiWrite => ({ keyId: 'commands.destructive', action, signs: false });
  const access = (action: string): ApiWrite => ({ keyId: 'branch.main.push', action, signs: false });
  const publish = (action: string): ApiWrite => ({ keyId: 'deploy', action, signs: false });
  const toBranch = (branch: string, action: string): ApiWrite => ({
    keyId: branchWriteKey(branch, 'main'),
    action,
    signs: false,
    branch,
  });
  const visibility = fields.get('visibility')?.toLowerCase();
  const isPublic = fields.get('private') === 'false' || visibility === 'public';
  const isPrivate = fields.get('private') === 'true' || visibility === 'private' || visibility === 'internal';
  const where = segments.join('/');

  if (segments[0] !== 'repos' || !repo) {
    const [s0, s1, s2] = segments;
    if (method === 'POST' && s0 === 'user' && ['keys', 'gpg_keys', 'ssh_signing_keys'].includes(s1 ?? ''))
      return access('add a key to the GitHub account');
    if (
      s0 === 'orgs' &&
      ['invitations', 'memberships', 'outside_collaborators'].includes(s2 ?? '') &&
      method !== 'DELETE'
    )
      return access(`give someone access to ${s1}`);
    if (method === 'POST' && ((s0 === 'user' && s1 === 'repos') || (s0 === 'orgs' && s2 === 'repos')))
      return isPrivate ? code('create a repository') : publish('create a public repository');
    if (method === 'POST' && s0 === 'gists' && segments.length === 1)
      return fields.get('public') === 'true' ? publish('create a public gist') : code('create a gist');
    if (method === 'DELETE') return destroy(`delete ${where}`);
    return code(`${method} ${where}`);
  }

  const rest = segments.slice(3);
  const [a, b2, c, d, e] = rest;
  const len = rest.length;
  if (a === 'pulls' && n(b2) && c === 'merge') refuse(GH_COPY.merge);
  if (a === 'pulls' && n(b2) && c === 'reviews') {
    if (n(d) && e === 'dismissals')
      return { keyId: 'pr.approve', action: `dismiss a review on PR #${b2}`, signs: false };
    refuse(GH_COPY.review);
  }
  const comment = (action: string, signs = true): ApiWrite => ({ keyId: 'pr.comment', action, signs });
  if (a === 'issues') {
    if (len === 1 && method === 'POST') return comment('open an issue');
    if (len === 2 && n(b2) && method === 'PATCH') return comment(`edit issue #${b2}`);
    if (len === 3 && n(b2) && c === 'comments' && method === 'POST')
      return comment(`comment on issue #${b2}`);
    if (len === 3 && b2 === 'comments' && n(c) && method === 'PATCH') return comment('edit an issue comment');
    if (len === 3 && n(b2) && c === 'labels' && (method === 'POST' || method === 'PUT'))
      return comment(`label issue #${b2}`, false);
  }
  if (a === 'pulls' && method === 'POST') {
    if (len === 3 && n(b2) && c === 'comments') return comment(`comment on PR #${b2}`);
    // The decision's `pulls/comments/N/replies`, and GitHub's own `pulls/N/comments/M/replies` (AGH-DS notes).
    if (len === 4 && b2 === 'comments' && n(c) && d === 'replies')
      return comment('reply to a review comment');
    if (len === 5 && n(b2) && c === 'comments' && n(d) && e === 'replies')
      return comment(`reply to a review comment on PR #${b2}`);
  }
  if (a === 'actions' && len === 4 && method === 'POST') {
    if (b2 === 'runs' && n(c) && (d === 'rerun' || d === 'rerun-failed-jobs'))
      return { keyId: 'pipelines.retry', action: `re-run workflow run ${c}`, signs: false };
    if (b2 === 'runs' && n(c) && d === 'cancel')
      return { keyId: 'ci.run', action: `cancel workflow run ${c}`, signs: false };
    if (b2 === 'workflows' && c && d === 'dispatches')
      return { keyId: workflowKey(c, repo, ctx), action: `run the workflow “${c}”`, signs: false };
  }
  const ci = (action: string): ApiWrite => ({ keyId: 'ci.run', action, signs: false });
  if (a === 'dispatches' && method === 'POST') return ci('send a repository dispatch');
  if (a === 'actions' && b2 === 'workflows' && (d === 'enable' || d === 'disable'))
    return ci(`${d} the workflow “${c}”`);
  if (a === 'actions' && b2 === 'caches') return ci('delete a cache');

  // A branch's commits: that branch's key (a push by other means).
  if (a === 'contents' && (method === 'PUT' || method === 'DELETE')) {
    const file = rest.slice(1).join('/');
    return toBranch(fields.get('branch') ?? 'main', method === 'PUT' ? `write ${file}` : `delete ${file}`);
  }
  if (a === 'git' && b2 === 'refs') {
    const ref = (method === 'POST' ? (fields.get('ref') ?? '') : rest.slice(2).join('/')).replace(
      /^refs\//,
      '',
    );
    if (ref.startsWith('tags/'))
      return method === 'DELETE' ? destroy(`delete the tag ${ref.slice(5)}`) : code(`tag ${ref.slice(5)}`);
    const branch = ref.replace(/^heads\//, '');
    return toBranch(
      branch,
      method === 'DELETE' ? `delete the branch ${branch}` : `move the branch ${branch}`,
    );
  }
  if (a === 'merges' && method === 'POST') return toBranch(fields.get('base') ?? 'main', 'merge a branch');
  if (a === 'branches' && b2 && c === 'rename' && method === 'POST')
    return toBranch(b2, `rename the branch ${b2}`);

  // Lasting access to the repository.
  if (a === 'keys' && method === 'POST')
    return fields.get('read_only') === 'true'
      ? code('add a read-only deploy key')
      : access('add a deploy key');
  if (a === 'collaborators' && method === 'PUT') return access(`give ${b2 ?? 'someone'} access`);
  if (a === 'invitations' && method === 'PATCH') return access('change an invitation');

  // The repository itself.
  if (len === 0 && method === 'PATCH') {
    if (isPublic) return publish('make the repository public');
    if (fields.get('archived') === 'true') return destroy('archive the repository');
    return code('change the repository’s settings');
  }
  if (len === 0 && method === 'DELETE') return destroy('delete the repository');
  if (a === 'transfer') return destroy('transfer the repository');
  if (a === 'generate' && method === 'POST')
    return isPrivate
      ? code('create a repository from this template')
      : publish('create a public repository from this template');

  // Publishing.
  if (method !== 'DELETE') {
    if (a === 'releases' && b2 !== 'generate-notes') return publish('publish a release');
    if (a === 'pages') return publish('publish GitHub Pages');
    if (a === 'deployments' && len === 1) return publish('create a deployment');
  }

  if (method === 'DELETE') {
    if (a === 'issues' && n(b2) && (c === 'labels' || c === 'assignees'))
      return comment(`change issue #${b2}`, false);
    if (a === 'pulls' && n(b2) && c === 'requested_reviewers') return comment(`change PR #${b2}`, false);
    if (rest.includes('reactions')) return comment('remove a reaction', false);
    return destroy(`delete ${rest.join('/')}`);
  }
  return code(`${method} ${rest.join('/') || 'the repository'}`);
}

/**
 * A GraphQL request's key (AGH-23): a query reads; a mutation is decided by what it does, as REST's would be. The text
 * comes from `-f query=…`, `-F query=@file` or `--input`; merges and reviews stay Whombat's.
 */
function graphqlWrite(
  tokens: readonly Token[],
  fields: ReadonlyMap<string, string>,
  ctx: GhPlanContext,
): ApiWrite | null {
  const texts = [...fields.values()];
  for (const t of tokens)
    if (t.kind === 'flag' && t.spec?.long === 'input' && t.value !== null) texts.push(fileText(ctx, t.value));
  const text = texts.join('\n');
  if (text && !/\bmutation\b/.test(text)) return null;
  const has = (re: RegExp) => re.test(text);
  if (has(/\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch|enqueuePullRequest)\b/))
    refuse(GH_COPY.merge);
  if (has(/\b(addPullRequestReview|submitPullRequestReview)\b/)) refuse(GH_COPY.review);
  const write = (keyId: KeyId, action: string): ApiWrite => ({ keyId, action, signs: false });
  if (has(/\b(createCommitOnBranch|updateRefs?|createRef|deleteRef)\b/))
    return write('branch.main.push', 'change a branch through GraphQL');
  if (has(/\b(delete[A-Z]\w*|archiveRepository|transferRepository)\b/))
    return write('commands.destructive', 'delete or archive through GraphQL');
  if (has(/visibility\s*:\s*PUBLIC/i)) return write('deploy', 'make something public through GraphQL');
  return write('code.write', 'run a GraphQL mutation');
}

function planApi(tokens: Token[], positionals: string[], named: Named, ctx: GhPlanContext): GhPlan {
  if (positionals.length !== 1) refuse(GH_COPY.apiPath);
  const endpoint = positionals[0] as string;
  if (OTHER_URL.test(endpoint)) refuse(GH_COPY.apiPath);
  const trimmed = endpoint.replace(/^\/+/, '');
  const q = trimmed.indexOf('?');
  const segments = (q < 0 ? trimmed : trimmed.slice(0, q)).split('/');
  if (!segments[0]) refuse(GH_COPY.apiPath);
  // The repository it is about: `repos/owner/name`, or gh's {owner}/{repo} placeholders anywhere, which it fills from
  // GH_REPO. Anything else is the account's or an organization's (repo null).
  if (segments[0] === 'repos' && segments.length >= 3) {
    const [owner, repoName] = [segments[1] as string, segments[2] as string];
    if (!(owner === '{owner}' && repoName === '{repo}')) {
      if (!NAME.test(owner) || !NAME.test(repoName)) refuse(GH_COPY.apiPath);
      named.add(`${owner}/${repoName}`);
    }
  }
  const placeholders = [
    trimmed,
    ...tokens.flatMap((t) => (t.kind === 'flag' && t.value ? [t.value] : [])),
  ].some((w) => /\{(owner|repo|branch)\}/.test(w));
  const repo = named.repo || placeholders ? resolveRepo(named.repo, ctx) : null;

  if (
    tokens.some(
      (t) =>
        t.kind === 'flag' && t.spec?.long === 'header' && /^\s*(authorization|host)\s*:/i.test(t.value ?? ''),
    )
  )
    refuse(GH_COPY.apiHeader);
  const hasFields = tokens.some(
    (t) => t.kind === 'flag' && ['raw-field', 'field', 'input'].includes(t.spec?.long ?? ''),
  );
  const method = (flagValue(tokens, 'method') ?? (hasFields ? 'POST' : 'GET')).toUpperCase();
  if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) refuse(notMethod(method));

  // Files (AGH-08): `--input <file>`, `-F key=@<file>`; `-` (stdin) stays.
  const placed = (t: FlagToken) => {
    if (t.value === null) return null;
    if (t.spec?.long === 'input' && t.value !== '-')
      return [t.name, ghFilePlaceholder(fileIndex(ctx, t.value))];
    const m = t.spec?.field ? /^([^=]*)=@(.+)$/.exec(t.value) : null;
    if (m && m[2] !== '-') return [t.name, `${m[1]}=@${ghFilePlaceholder(fileIndex(ctx, m[2] as string))}`];
    return null;
  };
  // The endpoint without its leading slash.
  const endpointAt = tokens.findIndex((t) => t.kind === 'pos');
  const normal = tokens.map((t, i) => (i === endpointAt ? { kind: 'pos' as const, value: trimmed } : t));
  const hashArgs = ['api', ...wordsOf(normal, placed)];
  if (method === 'GET' || method === 'HEAD') return { kind: 'read', args: hashArgs, repo };

  const fields = fieldsOf(tokens, ctx);
  let write: ApiWrite;
  if (segments[0] === 'graphql') {
    const g = graphqlWrite(tokens, fields, ctx);
    if (!g) return { kind: 'read', args: hashArgs, repo };
    write = g;
  } else write = apiWrite(method, segments, repo, fields, ctx);
  // A comment's or an issue's `body` field gets the signature line (AGH-13); a file's when it fits in a word.
  const run = wordsOf(normal, (t) => {
    const isField = t.spec?.long === 'raw-field' || t.spec?.long === 'field';
    const m = write.signs && isField && t.value !== null ? /^body=(@?)([\s\S]*)$/.exec(t.value) : null;
    if (!m) return placed(t);
    const fromFile = m[1] === '@';
    const body = signed(fromFile ? fileText(ctx, m[2] as string) : (m[2] as string), ctx.signature);
    if (fromFile && body.length + 5 > WORD_MAX) return placed(t);
    // A typed `-F body=…` would read `true`, `12` or `@x` as something else: the signed body goes raw.
    return ['-f', `body=${body}`];
  });
  return {
    kind: 'write',
    args: ['api', ...run],
    repo,
    ...(write.branch ? { branch: write.branch } : {}),
    keyId: write.keyId,
    action: write.action,
    words: commandWords(['api', trimmed]),
    hashArgs,
  };
}
