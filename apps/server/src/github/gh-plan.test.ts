/**
 * The gh planner (docs/decisions/agent-gh.md AGH-04, AGH-05, AGH-07, AGH-08): which repository, which commands run,
 * which write needs which key, how files and stdin become placeholders, and what is refused with which sentence.
 */
import { describe, expect, it } from 'vitest';
import { GH_COPY, type GhPlan, type GhPlanContext, planGh } from './gh-plan';

const SIG = '— Dusty via Whombat';

function ctx(over: Partial<GhPlanContext> = {}): GhPlanContext {
  return {
    repos: ['acme/web', 'acme/api'],
    defaultRepo: 'acme/web',
    checkout: { repo: 'acme/web', branch: 'feat/x' },
    files: [],
    stdin: null,
    deployWorkflows: () => [],
    signature: SIG,
    ...over,
  };
}

const plan = (line: string | string[], over: Partial<GhPlanContext> = {}): GhPlan =>
  planGh(typeof line === 'string' ? line.split(' ').filter(Boolean) : line, ctx(over));

const refused = (p: GhPlan) => {
  expect(p.kind).toBe('refuse');
  return p.kind === 'refuse' ? p.message : '';
};

describe('help and the version (AGH-05)', () => {
  it.each([
    ['', ['help']],
    ['help', ['help']],
    ['help pr create', ['help', 'pr', 'create']],
    ['pr create --help', ['help', 'pr', 'create']],
    ['issue comment 12 -h', ['help', 'issue', 'comment']],
    ['secret set NAME --help', ['help', 'secret', 'set']],
    ['pr', ['help', 'pr']],
    ['--help', ['help']],
    ['-R acme/api pr list --help', ['help', 'pr', 'list']],
  ])('gh %s → %j, no repo', (line, args) => {
    expect(plan(line)).toEqual({ kind: 'read', args, repo: null });
  });

  it.each(['--version', 'version'])('gh %s', (line) => {
    expect(plan(line)).toEqual({ kind: 'read', args: ['--version'], repo: null });
  });

  it('a body that says --help is a body, not help', () => {
    expect(plan(['issue', 'comment', '12', '-b', '--help'])).toMatchObject({ kind: 'write' });
  });
});

describe('which repository (AGH-04)', () => {
  it('-R anywhere names it, and is taken out of the words', () => {
    expect(plan('-R acme/api pr list')).toEqual({ kind: 'read', args: ['pr', 'list'], repo: 'acme/api' });
    expect(plan('pr list -R acme/api --state open')).toEqual({
      kind: 'read',
      args: ['pr', 'list', '--state', 'open'],
      repo: 'acme/api',
    });
    expect(plan('pr list --repo=acme/api')).toMatchObject({ args: ['pr', 'list'], repo: 'acme/api' });
    expect(plan('pr list -Racme/api')).toMatchObject({ args: ['pr', 'list'], repo: 'acme/api' });
    expect(plan('pr list --repo https://github.com/acme/api.git')).toMatchObject({ repo: 'acme/api' });
    expect(plan('pr list -R github.com/acme/api')).toMatchObject({ repo: 'acme/api' });
  });

  it('a -R hidden in a cluster of short flags is still -R', () => {
    expect(plan('pr list -dR acme/api')).toMatchObject({ args: ['pr', 'list', '-d'], repo: 'acme/api' });
    expect(refused(plan('pr list -dR evil/x'))).toBe(
      'evil/x isn’t one this Whombat’s GitHub sign-in works on. A public repository still clones with git.',
    );
  });

  it('matches case-insensitively and uses the canonical name', () => {
    expect(plan('issue list -R ACME/Web')).toMatchObject({ repo: 'acme/web' });
  });

  it('else the turn’s repo, else the only one, else asks', () => {
    expect(plan('issue list')).toMatchObject({ repo: 'acme/web' });
    expect(plan('issue list', { defaultRepo: null, repos: ['acme/api'] })).toMatchObject({
      repo: 'acme/api',
    });
    expect(refused(plan('issue list', { defaultRepo: null }))).toBe(
      'Say which repository with -R: acme/web, acme/api.',
    );
  });

  it('refuses a repo that isn’t switched on, a local one, another host, and two different ones', () => {
    expect(refused(plan('issue list -R acme/secret'))).toBe(
      'acme/secret isn’t one this Whombat’s GitHub sign-in works on. A public repository still clones with git.',
    );
    // The repo it names, for the server to add when the burrow's GitHub connection reaches it (agent-repos.md AGR-01).
    expect(plan('issue list -R acme/secret')).toMatchObject({ kind: 'refuse', repo: 'acme/secret' });
    expect(plan('issue list -R acme/secret', { repos: [] })).toMatchObject({
      kind: 'refuse',
      repo: 'acme/secret',
    });
    expect(plan('issue list -R local/notes')).not.toHaveProperty('repo');
    expect(refused(plan('issue list -R local/notes'))).toBe(
      'local/notes is kept on this Whombat, not on GitHub: use git and open_pull_request.',
    );
    expect(refused(plan('issue list -R ghe.example.com/acme/web'))).toBe(GH_COPY.hostname);
    expect(refused(plan('issue list -R https://ghe.example.com/acme/web'))).toBe(GH_COPY.hostname);
    expect(refused(plan('issue list -R acme/web -R acme/api'))).toBe(GH_COPY.oneRepo);
    expect(refused(plan('issue list -R nonsense'))).toBe('nonsense isn’t owner/name.');
    expect(refused(plan('issue list', { repos: [], defaultRepo: null }))).toBe(GH_COPY.noRepos);
  });

  it('a github.com URL among the words names the repo (gh would follow it)', () => {
    expect(plan('issue view https://github.com/acme/api/issues/3')).toMatchObject({ repo: 'acme/api' });
    expect(refused(plan('issue view https://github.com/evil/x/issues/3'))).toMatch(
      /evil\/x isn’t one this Whombat’s GitHub sign-in works on/,
    );
    expect(refused(plan('pr view https://github.com/acme/api/pull/3 -R acme/web'))).toBe(GH_COPY.oneRepo);
    expect(refused(plan('pr view https://gitlab.com/acme/web/merge_requests/3'))).toBe(GH_COPY.hostname);
  });

  it('a body may quote any URL', () => {
    expect(plan(['issue', 'comment', '3', '-b', 'https://github.com/evil/x/issues/1'])).toMatchObject({
      kind: 'write',
      repo: 'acme/web',
    });
  });

  it('--hostname is github.com or nothing', () => {
    expect(plan('api repos/{owner}/{repo}/pulls --hostname github.com')).toMatchObject({
      kind: 'read',
      args: ['api', 'repos/{owner}/{repo}/pulls'],
    });
    expect(refused(plan('api repos/{owner}/{repo}/pulls --hostname ghe.example.com'))).toBe(GH_COPY.hostname);
  });

  it('flags before the command are only the global ones', () => {
    expect(refused(plan('--state open pr list'))).toBe(GH_COPY.flagsFirst);
  });
});

describe('reads (AGH-05)', () => {
  it.each([
    ['pr list --state open --json number,title', ['pr', 'list', '--state', 'open', '--json', 'number,title']],
    ['pr view 12 --comments', ['pr', 'view', '12', '--comments']],
    ['pr diff 12', ['pr', 'diff', '12']],
    ['pr checks 12', ['pr', 'checks', '12']],
    ['pr status', ['pr', 'status']],
    ['issue list -L 5', ['issue', 'list', '-L', '5']],
    ['issue view 7', ['issue', 'view', '7']],
    ['issue status', ['issue', 'status']],
    ['run list -w ci.yml', ['run', 'list', '-w', 'ci.yml']],
    ['run view 99 --log', ['run', 'view', '99', '--log']],
    ['run view 99 --log-failed', ['run', 'view', '99', '--log-failed']],
    ['workflow list', ['workflow', 'list']],
    ['workflow view ci.yml', ['workflow', 'view', 'ci.yml']],
    ['release list', ['release', 'list']],
    ['release view v1.0', ['release', 'view', 'v1.0']],
    ['label list', ['label', 'list']],
    ['cache list', ['cache', 'list']],
    ['ruleset list', ['ruleset', 'list']],
    ['ruleset view 3', ['ruleset', 'view', '3']],
    ['ruleset check main', ['ruleset', 'check', 'main']],
    ['pr list --unknown-flag', ['pr', 'list', '--unknown-flag']],
  ])('gh %s', (line, args) => {
    expect(plan(line)).toEqual({ kind: 'read', args, repo: 'acme/web' });
  });

  it('a pr read that names no pull request gets the checkout’s branch (there is no git where gh runs)', () => {
    expect(plan('pr view --json title')).toMatchObject({ args: ['pr', 'view', 'feat/x', '--json', 'title'] });
    expect(plan('pr checks')).toMatchObject({ args: ['pr', 'checks', 'feat/x'] });
    expect(plan('pr view -R acme/api')).toMatchObject({ args: ['pr', 'view'], repo: 'acme/api' });
  });

  it('repo view is the repo only', () => {
    expect(plan('repo view')).toEqual({ kind: 'read', args: ['repo', 'view', 'acme/web'], repo: 'acme/web' });
    expect(plan('repo view acme/API --json name')).toEqual({
      kind: 'read',
      args: ['repo', 'view', 'acme/api', '--json', 'name'],
      repo: 'acme/api',
    });
    expect(refused(plan('repo view evil/x'))).toMatch(
      /evil\/x isn’t one this Whombat’s GitHub sign-in works on/,
    );
  });

  it.each(['issues', 'prs', 'commits', 'code', 'repos'])(
    'search %s runs as written, anywhere (AGH-23)',
    (what) => {
      expect(plan(`search ${what} flaky`)).toEqual({
        kind: 'read',
        args: ['search', what, 'flaky'],
        repo: null,
      });
      // Its own --repo is its filter, kept; qualifiers too.
      expect(plan(`search ${what} flaky --repo acme/api`)).toEqual({
        kind: 'read',
        args: ['search', what, 'flaky', '--repo', 'acme/api'],
        repo: null,
      });
      expect(plan(['search', what, 'repo:MorpheApp/x flaky', '--owner', 'evil'])).toMatchObject({
        kind: 'read',
      });
    },
  );

  it('a list’s --search may use any qualifier', () => {
    expect(plan(['pr', 'list', '--search', 'is:open org:evil'])).toMatchObject({ kind: 'read' });
    expect(plan(['pr', 'list', '--jq', '.[] | { repo: .x }'])).toMatchObject({ kind: 'read' });
  });

  it('--web is refused; run list’s -w is its workflow', () => {
    expect(refused(plan('pr view 12 --web'))).toBe(GH_COPY.web);
    expect(refused(plan('issue list -w'))).toBe(GH_COPY.web);
    expect(refused(plan('issue status --web'))).toBe(GH_COPY.web);
    expect(plan('run list -w deploy.yml')).toMatchObject({ kind: 'read' });
  });

  it('ruleset --org reads the organization’s', () => {
    expect(plan('ruleset list --org acme')).toMatchObject({ kind: 'read' });
  });
});

describe('writes and their keys (AGH-05)', () => {
  it.each([
    ['issue create -t Bug -b Broken', 'pr.comment', 'open an issue', ['issue', 'create']],
    ['issue comment 12 -b Thanks', 'pr.comment', 'comment on issue #12', ['issue', 'comment', '12']],
    ['issue edit 12 --add-label bug', 'pr.comment', 'edit issue #12', ['issue', 'edit', '12']],
    ['issue edit 1 2 --add-label bug', 'pr.comment', 'edit issues #1, #2', ['issue', 'edit', '1', '2']],
    ['issue close #12', 'pr.comment', 'close issue #12', ['issue', 'close', '#12']],
    ['issue reopen 12', 'pr.comment', 'reopen issue #12', ['issue', 'reopen', '12']],
    ['pr comment 5 -b Looks', 'pr.comment', 'comment on PR #5', ['pr', 'comment', '5']],
    ['pr edit 5 --add-label ready', 'pr.comment', 'edit PR #5', ['pr', 'edit', '5']],
    ['pr close 5', 'pr.comment', 'close PR #5', ['pr', 'close', '5']],
    ['pr reopen 5', 'pr.comment', 'reopen PR #5', ['pr', 'reopen', '5']],
    ['pr ready 5', 'pr.comment', 'mark PR #5 ready for review', ['pr', 'ready', '5']],
    ['label create bug -c ff0000', 'pr.comment', 'create the label “bug”', ['label', 'create', 'bug']],
    ['label edit bug -c 00ff00', 'pr.comment', 'edit the label “bug”', ['label', 'edit', 'bug']],
    ['run rerun 99 --failed', 'pipelines.retry', 're-run workflow run 99', ['run', 'rerun', '99']],
    ['run cancel 99', 'ci.run', 'cancel workflow run 99', ['run', 'cancel', '99']],
    ['workflow run ci.yml -f x=1', 'ci.run', 'run the workflow “ci.yml”', ['workflow', 'run', 'ci.yml']],
    ['workflow run deploy.yml', 'deploy', 'run the workflow “deploy.yml”', ['workflow', 'run', 'deploy.yml']],
    ['workflow run Release', 'deploy', 'run the workflow “Release”', ['workflow', 'run', 'Release']],
    [
      'workflow run publish-npm.yaml',
      'deploy',
      'run the workflow “publish-npm.yaml”',
      ['workflow', 'run', 'publish-npm.yaml'],
    ],
  ])('gh %s → %s', (line, keyId, action, words) => {
    expect(plan(line)).toMatchObject({ kind: 'write', repo: 'acme/web', keyId, action, words });
  });

  it('the host’s deploy workflow is deploy, by file; a name could be it, so the file is asked for', () => {
    const deployWorkflows = (repo: string) => (repo === 'acme/web' ? ['ship.yml'] : []);
    expect(plan('workflow run ship.yml', { deployWorkflows })).toMatchObject({ keyId: 'deploy' });
    expect(plan('workflow run ship', { deployWorkflows })).toMatchObject({ keyId: 'deploy' });
    expect(plan('workflow run ci.yml', { deployWorkflows })).toMatchObject({ keyId: 'ci.run' });
    expect(refused(plan('workflow run CI', { deployWorkflows }))).toBe(GH_COPY.workflowFile);
    expect(plan('workflow run CI -R acme/api', { deployWorkflows })).toMatchObject({ keyId: 'ci.run' });
    expect(plan('workflow run ci.yml', { deployWorkflows: () => ['4242'] })).toMatchObject({
      keyId: 'deploy',
    });
    expect(refused(plan('workflow run 1234'))).toBe(GH_COPY.workflowFile);
    expect(refused(plan('workflow run'))).toBe(GH_COPY.workflowMissing);
    expect(refused(plan('workflow run ci.yml --json'))).toBe(GH_COPY.workflowJson);
    expect(refused(plan('workflow run ci.yml -F notes=@notes.md'))).toBe(GH_COPY.workflowFieldFile);
  });

  it('inline bodies are signed; the hash covers the words as decided', () => {
    const p = plan(['issue', 'comment', '12', '-b', 'Fixed in #13.', '-R', 'acme/web']);
    expect(p).toMatchObject({
      kind: 'write',
      args: ['issue', 'comment', '12', '-b', `Fixed in #13.\n\n${SIG}`],
      hashArgs: ['issue', 'comment', '12', '-b', 'Fixed in #13.'],
    });
    expect(plan(['issue', 'close', '12', '-c', 'Done'])).toMatchObject({
      args: ['issue', 'close', '12', '-c', `Done\n\n${SIG}`],
    });
    expect(plan(['issue', 'create', '--title=Bug', '--body=Broken'])).toMatchObject({
      args: ['issue', 'create', '--title', 'Bug', '--body', `Broken\n\n${SIG}`],
    });
    // Signed once.
    expect(plan(['pr', 'comment', '5', '-b', `Hi\n\n${SIG}`])).toMatchObject({
      args: ['pr', 'comment', '5', '-b', `Hi\n\n${SIG}`],
    });
    expect(plan(['pr', 'comment', '5', '-b', 'Hi'], { signature: null })).toMatchObject({
      args: ['pr', 'comment', '5', '-b', 'Hi'],
    });
  });

  it('a body file (or stdin) runs as a signed --body; the hash keeps the placeholder', () => {
    const files = [{ path: 'notes.md', text: 'From a file.' }];
    expect(plan(['issue', 'comment', '12', '-F', 'notes.md'], { files })).toMatchObject({
      args: ['issue', 'comment', '12', '--body', `From a file.\n\n${SIG}`],
      hashArgs: ['issue', 'comment', '12', '-F', '@whombat-file:0'],
    });
    expect(plan(['issue', 'comment', '12', '--body-file=notes.md'], { files })).toMatchObject({
      hashArgs: ['issue', 'comment', '12', '--body-file', '@whombat-file:0'],
    });
    expect(plan(['pr', 'comment', '5', '-F', '-'], { stdin: 'From stdin.' })).toMatchObject({
      args: ['pr', 'comment', '5', '--body', `From stdin.\n\n${SIG}`],
      hashArgs: ['pr', 'comment', '5', '-F', '-'],
    });
    // Too long for one word: the file stays, unsigned.
    const big = [{ path: 'big.md', text: 'x'.repeat(70_000) }];
    expect(plan(['issue', 'comment', '12', '-F', 'big.md'], { files: big })).toMatchObject({
      args: ['issue', 'comment', '12', '-F', '@whombat-file:0'],
    });
    expect(refused(plan(['issue', 'comment', '12', '-F', 'missing.md'], { files }))).toBe(
      'Whombat didn’t get the file missing.md.',
    );
  });

  it('a pr write that names no pull request gets the checkout’s branch', () => {
    expect(plan(['pr', 'comment', '-b', 'Hi'])).toMatchObject({
      args: ['pr', 'comment', 'feat/x', '-b', `Hi\n\n${SIG}`],
      action: 'comment on the pull request for feat/x',
      words: ['pr', 'comment', 'feat/x'],
      hashArgs: ['pr', 'comment', '-b', 'Hi'],
    });
    expect(plan(['pr', 'comment', '-b', 'Hi'], { checkout: null })).toMatchObject({
      action: 'comment on a pull request',
    });
  });

  it('refuses what a write can’t do here', () => {
    expect(refused(plan('issue comment 12 -e'))).toBe(GH_COPY.editor);
    expect(refused(plan('issue comment 12 --delete-last'))).toBe(
      'gh issue comment --delete-last isn’t available here.',
    );
    expect(refused(plan('pr close 5 -d'))).toBe(
      'Delete the branch with git: gh pr close -d isn’t available here.',
    );
    expect(refused(plan('issue create -t x --recover f.json'))).toBe(
      'gh issue create --recover isn’t supported here: leave it out.',
    );
    // A flag Whombat doesn't know passes on (AGH-23); Whombat's own commands still refuse one.
    expect(plan('issue comment 12 -b x --frobnicate')).toMatchObject({ kind: 'write' });
    expect(refused(plan('issue comment 12 -b'))).toBe('-b needs a value.');
  });
});

describe('everything gh does, by the agent’s keys (AGH-23)', () => {
  it.each([
    ['status', null],
    ['repo list --limit 5', null],
    ['org list', null],
    ['gist list', null],
    ['ssh-key list', null],
    ['project list --owner acme', null],
    ['codespace list', null],
    ['auth status', null],
    ['config get git_protocol', null],
    ['extension list', null],
    ['completion -s bash', null],
    ['attestation trusted-root', null],
    ['secret list --org acme', null],
    ['secret list', 'acme/web'],
    ['variable get NAME', 'acme/web'],
    ['run watch 9', 'acme/web'],
    ['release verify v1', 'acme/web'],
    ['browse -n', 'acme/web'],
    ['repo deploy-key list', 'acme/web'],
    ['repo autolink list', 'acme/web'],
  ])('gh %s reads (repo %s)', (line, repo) => {
    expect(plan(line)).toMatchObject({ kind: 'read', repo });
  });

  it.each([
    ['repo edit --default-branch main', 'code.write', 'acme/web'],
    ['repo edit acme/api --visibility public --accept-visibility-change-consequences', 'deploy', 'acme/api'],
    ['repo edit --visibility private --accept-visibility-change-consequences', 'code.write', 'acme/web'],
    ['repo rename web2 --yes', 'code.write', 'acme/web'],
    ['repo archive --yes', 'commands.destructive', 'acme/web'],
    ['repo unarchive --yes', 'code.write', 'acme/web'],
    ['repo delete acme/web --yes', 'commands.destructive', 'acme/web'],
    ['repo fork acme/api --default-branch-only', 'code.write', 'acme/api'],
    ['repo sync', 'branch.main.push', 'acme/web'],
    ['repo sync -b feat/x', 'branch.feature.readwrite', 'acme/web'],
    ['repo deploy-key delete 12', 'commands.destructive', 'acme/web'],
    ['repo autolink create JIRA- https://jira.example/browse/<num>', 'code.write', 'acme/web'],
    ['issue delete 5 --yes', 'commands.destructive', 'acme/web'],
    ['issue transfer 5 acme/api', 'code.write', 'acme/web'],
    ['issue pin 5', 'pr.comment', 'acme/web'],
    ['issue lock 5', 'pr.comment', 'acme/web'],
    ['issue develop 5 --name feat/5', 'code.write', 'acme/web'],
    ['pr lock 5', 'pr.comment', 'acme/web'],
    ['pr update-branch 5', 'code.write', 'acme/web'],
    ['run delete 9', 'commands.destructive', 'acme/web'],
    ['workflow enable ci.yml', 'ci.run', 'acme/web'],
    ['workflow disable ci.yml', 'ci.run', 'acme/web'],
    ['release delete v1 --yes', 'commands.destructive', 'acme/web'],
    ['label delete bug --yes', 'commands.destructive', 'acme/web'],
    ['label clone acme/api', 'pr.comment', 'acme/web'],
    ['cache delete k', 'ci.run', 'acme/web'],
    ['secret set TOKEN -b s3cret', 'code.write', 'acme/web'],
    ['secret set TOKEN -b s3cret --org acme', 'code.write', null],
    ['secret delete TOKEN', 'commands.destructive', 'acme/web'],
    ['variable set NAME -b x', 'code.write', 'acme/web'],
    ['ssh-key delete 7 --yes', 'commands.destructive', null],
    ['gist edit abc --desc New', 'code.write', null],
    ['gist delete abc --yes', 'commands.destructive', null],
    ['project item-add 1 --owner acme --url https://github.com/acme/web/issues/1', 'code.write', null],
    ['project delete 1 --owner acme', 'commands.destructive', null],
    ['codespace create -R acme/web', 'code.write', null],
    ['codespace delete -c x', 'commands.destructive', null],
    ['agent-task create fix-the-bug', 'code.write', 'acme/web'],
  ])('gh %s → %s', (line, keyId, repo) => {
    expect(plan(line)).toMatchObject({ kind: 'write', keyId, repo });
  });

  it('release notes from a file go inline as --notes, signed (AGH-21)', () => {
    expect(
      plan(['release', 'create', 'v1', '-F', 'notes.md'], {
        files: [{ path: 'notes.md', text: 'Fixes PiP.' }],
      }),
    ).toMatchObject({
      kind: 'write',
      keyId: 'deploy',
      args: ['release', 'create', 'v1', '--notes', `Fixes PiP.\n\n${SIG}`],
      hashArgs: ['release', 'create', 'v1', '-F', '@whombat-file:0'],
    });
  });

  it.each([
    ['auth token', GH_COPY.auth],
    ['auth login --with-token', GH_COPY.auth],
    ['auth status --show-token', GH_COPY.auth],
    ['config set editor vim', GH_COPY.config],
    ['extension install x/y', `gh extension install ${GH_COPY.runnerCode}`],
    ['ext install x/y', `gh extension install ${GH_COPY.runnerCode}`],
    ['alias set co pr checkout', `gh alias set ${GH_COPY.runnerCode}`],
    ['codespace ssh -c x', `gh codespace ssh ${GH_COPY.terminal}`],
    ['cs code', `gh codespace code ${GH_COPY.terminal}`],
    ['run download 9', `gh run download ${GH_COPY.download}`],
    ['release download v1', `gh release download ${GH_COPY.download}`],
    ['release upload v1 app.apk', GH_COPY.releaseFiles],
    ['release create v1 app.apk', GH_COPY.releaseFiles],
    ['repo clone acme/web', GH_COPY.checkout],
    ['pr checkout 12', GH_COPY.checkout],
    ['repo set-default acme/web', GH_COPY.setDefault],
    ['secret set TOKEN', GH_COPY.secretValue],
    ['browse', GH_COPY.noBrowser],
    ['frobnicate', `gh frobnicate ${GH_COPY.unknown}`],
  ])('gh %s is refused', (line, message) => {
    expect(refused(plan(line))).toBe(message);
  });

  it.each([
    'ssh-key add key.pub',
    'gpg-key add key.asc',
    'gist create notes.md',
    'repo deploy-key add key.pub',
    'attestation verify app.apk -R acme/web',
    'secret set X -f .env',
    'gist edit abc -a x.txt',
  ])('gh %s: files only reach gh as -F or through gh api', (line) => {
    expect(refused(plan(line))).toMatch(/can’t read files of your commands by their path here/);
  });

  it('a path of the agent’s commands is never handed to gh (Whombat’s side would read its own)', () => {
    for (const path of ['/etc/passwd', '~/.ssh/id_ed25519', './secret.txt', '../x', 'a/../../b'])
      expect(refused(plan(['issue', 'comment', '12', '-b', 'x', '--frobnicate', path]))).toMatch(
        /can’t read files of your commands by their path here/,
      );
    // Text is text: a body may say anything.
    expect(plan(['issue', 'comment', '12', '-b', '/etc/passwd'])).toMatchObject({ kind: 'write' });
  });

  it('every refusal exits 1', () => {
    expect(plan('auth token')).toMatchObject({ kind: 'refuse', exitCode: 1 });
  });

  it('a word can’t smuggle a placeholder', () => {
    expect(refused(plan(['issue', 'comment', '1', '-b', '@whombat-file:0']))).toBe(GH_COPY.placeholder);
  });
});

describe('gh repo create (AGH-19, AGH-20)', () => {
  const spec = {
    owner: null,
    name: 'site',
    visibility: 'private',
    description: null,
    homepage: null,
    template: null,
    includeAllBranches: false,
    addReadme: false,
    gitignore: null,
    license: null,
    hasIssues: true,
    hasWiki: true,
  };

  it('a private repository in the connection’s account: Write code', () => {
    expect(plan('repo create site --private')).toEqual({
      kind: 'create_repo',
      repo: spec,
      keyId: 'code.write',
      action: 'create the private repository',
      words: ['repo', 'create'],
      hashArgs: ['repo', 'create', 'site', '--private'],
    });
  });

  it('a public one is published: Deploy', () => {
    expect(plan('repo create acme/site --public')).toMatchObject({
      kind: 'create_repo',
      repo: { owner: 'acme', name: 'site', visibility: 'public' },
      keyId: 'deploy',
      action: 'create the public repository',
    });
    expect(plan('repo create acme/site --internal')).toMatchObject({ keyId: 'code.write' });
  });

  it('from a template, with every branch; the template may be a URL', () => {
    expect(
      plan([
        'repo',
        'create',
        'johns-morphe-patches',
        '--public',
        '-p',
        'https://github.com/MorpheApp/morphe-patches-template',
        '--include-all-branches',
        '-d',
        'John’s Morphe Patches',
      ]),
    ).toMatchObject({
      kind: 'create_repo',
      repo: {
        name: 'johns-morphe-patches',
        template: 'MorpheApp/morphe-patches-template',
        includeAllBranches: true,
        description: 'John’s Morphe Patches',
      },
    });
  });

  it('a README, .gitignore, licence, homepage and what is switched off', () => {
    expect(
      plan(
        'repo create site --private --add-readme -g Node -l mit -h https://github.com/acme/web --disable-issues --disable-wiki',
      ),
    ).toMatchObject({
      repo: {
        addReadme: true,
        gitignore: 'Node',
        license: 'mit',
        homepage: 'https://github.com/acme/web',
        hasIssues: false,
        hasWiki: false,
      },
    });
  });

  it.each([
    ['repo create site', GH_COPY.repoVisibility],
    ['repo create site --public --private', GH_COPY.repoVisibility],
    ['repo create --private', GH_COPY.repoName],
    ['repo create a b --private', GH_COPY.repoName],
    ['repo create -R acme/web site --private', GH_COPY.repoNamed],
    [
      'repo create a/b/c --private',
      'a/b/c can’t be a repository’s name: use letters, digits, -, _ and . (like my-repo).',
    ],
    [
      'repo create .. --private',
      '.. can’t be a repository’s name: use letters, digits, -, _ and . (like my-repo).',
    ],
    ['repo create site --private --source .', GH_COPY.repoSource],
    ['repo create site --private --push', GH_COPY.repoSource],
    ['repo create site --private --clone', GH_COPY.repoClone],
    ['repo create site --private -t core', 'gh repo create --team isn’t supported here: leave it out.'],
    ['repo create site --private --frob', 'gh repo create --frob isn’t supported here: leave it out.'],
    [
      'repo create site --private -p acme/tpl --add-readme',
      'gh repo create --template can’t be combined with --add-readme.',
    ],
    [
      'repo create site --internal -p acme/tpl',
      'gh repo create --template can’t be combined with --internal.',
    ],
    ['repo create site --private --include-all-branches', '--include-all-branches needs --template.'],
    ['repo create site --private -p gitlab.com/a/b', GH_COPY.hostname],
  ])('gh %s', (line, message) => {
    expect(refused(plan(line))).toBe(message);
  });
});

describe('gh release (AGH-21)', () => {
  it('create: Deploy, the notes signed', () => {
    expect(plan(['release', 'create', 'v1.2.0', '-t', 'v1.2.0', '-n', 'Fixes NLZiet.'])).toEqual({
      kind: 'write',
      args: ['release', 'create', 'v1.2.0', '-t', 'v1.2.0', '-n', `Fixes NLZiet.\n\n${SIG}`],
      repo: 'acme/web',
      keyId: 'deploy',
      action: 'create release v1.2.0',
      words: ['release', 'create', 'v1.2.0'],
      hashArgs: ['release', 'create', 'v1.2.0', '-t', 'v1.2.0', '-n', 'Fixes NLZiet.'],
    });
    expect(plan('release create v1 --generate-notes --latest=false --target main')).toMatchObject({
      kind: 'write',
      keyId: 'deploy',
    });
  });

  it('edit: Deploy', () => {
    expect(plan('-R acme/api release edit v1 --draft=false')).toMatchObject({
      kind: 'write',
      repo: 'acme/api',
      keyId: 'deploy',
      action: 'edit release v1',
    });
  });

  it.each([
    ['release create', GH_COPY.releaseTag],
    ['release create v1 app.apk', GH_COPY.releaseFiles],
    ['release edit', GH_COPY.releaseTag],
  ])('gh %s', (line, message) => {
    expect(refused(plan(line))).toBe(message);
  });
});

describe('Whombat’s own commands (AGH-05)', () => {
  it('pr create opens the Whombat way: title, body, base and head (else the checkout’s branch)', () => {
    expect(plan(['pr', 'create', '-t', 'Invoice PDF', '-b', 'Adds it.'])).toEqual({
      kind: 'whombat',
      repo: 'acme/web',
      op: { op: 'pr_create', title: 'Invoice PDF', body: 'Adds it.', base: null, head: 'feat/x' },
    });
    expect(
      plan(['pr', 'create', '--title', 'T', '-F', 'body.md', '-B', 'develop', '-H', 'acme:feat/y'], {
        files: [{ path: 'body.md', text: 'From a file.' }],
      }),
    ).toMatchObject({ op: { body: 'From a file.', base: 'develop', head: 'feat/y' } });
    expect(refused(plan(['pr', 'create', '-t', 'T', '-H', 'someone:feat/y']))).toBe(GH_COPY.fork);
    expect(refused(plan(['pr', 'create', '-b', 'no title']))).toBe(GH_COPY.title);
    expect(refused(plan(['pr', 'create', '-t', 'T', '-R', 'acme/api']))).toBe(
      'Say which branch with -H: this turn has no checkout of acme/api.',
    );
  });

  it.each([
    ['--draft', 'gh pr create --draft isn’t supported here: leave it out.'],
    ['--fill', 'gh pr create --fill isn’t supported here: leave it out.'],
    ['-r mara', 'gh pr create --reviewer isn’t supported here: leave it out.'],
    ['-l bug', 'gh pr create --label isn’t supported here: leave it out.'],
    ['-a mara', 'gh pr create --assignee isn’t supported here: leave it out.'],
    ['--web', GH_COPY.web],
  ])('pr create %s is refused', (flag, message) => {
    expect(refused(plan(`pr create -t T ${flag}`))).toBe(message);
  });

  it('pr merge: a number, a URL, a branch, or the checkout’s branch; the method the agent says (AGH-22)', () => {
    expect(plan('pr merge 12 --merge --delete-branch')).toEqual({
      kind: 'whombat',
      repo: 'acme/web',
      op: { op: 'pr_merge', pr: { number: 12 }, method: 'merge' },
    });
    expect(plan('pr merge https://github.com/acme/api/pull/7')).toEqual({
      kind: 'whombat',
      repo: 'acme/api',
      op: { op: 'pr_merge', pr: { number: 7 }, method: null },
    });
    expect(plan('pr merge feat/y -r')).toMatchObject({ op: { pr: { branch: 'feat/y' }, method: 'rebase' } });
    expect(plan('pr merge -s')).toMatchObject({ op: { pr: { branch: 'feat/x' }, method: 'squash' } });
    expect(refused(plan('pr merge 12 --merge --squash'))).toBe(GH_COPY.mergeMethod);
    expect(refused(plan('pr merge', { checkout: null }))).toBe('Say which pull request: gh pr merge 12.');
    expect(refused(plan('pr merge 12 --admin'))).toBe(
      'gh pr merge --admin isn’t supported here: Whombat merges by its own rules.',
    );
    expect(refused(plan('pr merge 12 --auto'))).toMatch(/--auto isn’t supported/);
  });

  it('pr review: one decision, a body for changes and comments', () => {
    expect(plan(['pr', 'review', '12', '--approve'])).toEqual({
      kind: 'whombat',
      repo: 'acme/web',
      op: { op: 'pr_review', pr: { number: 12 }, decision: 'approve', body: '' },
    });
    expect(plan(['pr', 'review', '12', '-r', '-b', 'Fix the test'])).toMatchObject({
      op: { decision: 'request_changes', body: 'Fix the test' },
    });
    expect(plan(['pr', 'review', '--comment', '-F', '-'], { stdin: 'Nice.' })).toMatchObject({
      op: { pr: { branch: 'feat/x' }, decision: 'comment', body: 'Nice.' },
    });
    expect(refused(plan('pr review 12'))).toBe(GH_COPY.reviewDecision);
    expect(refused(plan('pr review 12 --approve --comment'))).toBe(GH_COPY.reviewDecision);
    expect(refused(plan('pr review 12 --comment'))).toBe(GH_COPY.reviewBody);
    expect(refused(plan('pr review 12 --approve -e'))).toBe(GH_COPY.editor);
  });
});

describe('gh api (AGH-07)', () => {
  it('GET under the repo is a read; flags that only shape the answer pass', () => {
    expect(plan('api repos/{owner}/{repo}/pulls --paginate --jq .[].number')).toEqual({
      kind: 'read',
      args: ['api', 'repos/{owner}/{repo}/pulls', '--paginate', '--jq', '.[].number'],
      repo: 'acme/web',
    });
    expect(plan('api /repos/acme/api/issues?state=all -i')).toEqual({
      kind: 'read',
      args: ['api', 'repos/acme/api/issues?state=all', '-i'],
      repo: 'acme/api',
    });
    expect(plan('api repos/{owner}/{repo} -X HEAD')).toMatchObject({ kind: 'read' });
    expect(
      plan(['api', 'repos/{owner}/{repo}/commits', '-H', 'Accept: application/vnd.github+json']),
    ).toMatchObject({
      kind: 'read',
    });
    expect(plan('api repos/{owner}/{repo}/issues -X GET -f state=open')).toMatchObject({ kind: 'read' });
  });

  it('any path on api.github.com (AGH-23): the account’s and others’ repositories too', () => {
    expect(plan('api user')).toEqual({ kind: 'read', args: ['api', 'user'], repo: null });
    expect(plan('api search/issues?q=x')).toMatchObject({ kind: 'read', repo: null });
    expect(plan('api orgs/acme/repos')).toMatchObject({ kind: 'read', repo: null });
    // Someone else's repository: the server lets it through when the burrow doesn't have it (switched off stays off).
    expect(plan('api repos/evil/x/issues')).toMatchObject({ kind: 'refuse', repo: 'evil/x' });
    expect(plan('api repos/evil/x/issues', { repos: ['acme/web', 'evil/x'] })).toMatchObject({
      kind: 'read',
      repo: 'evil/x',
    });
    for (const path of ['https://api.github.com/repos/acme/web', 'https://evil.example/x'])
      expect(refused(plan(['api', path]))).toBe(GH_COPY.apiPath);
    expect(refused(plan('api repos/acme/api/issues -R acme/web'))).toBe(GH_COPY.oneRepo);
    expect(refused(plan('api repos/{owner}/{repo}/issues extra'))).toBe(GH_COPY.apiPath);
  });

  it.each([
    ['-X POST repos/{owner}/{repo}/issues -f title=Bug', 'pr.comment', 'open an issue'],
    ['repos/{owner}/{repo}/issues -f title=Bug', 'pr.comment', 'open an issue'],
    ['-X PATCH repos/{owner}/{repo}/issues/12 -f state=closed', 'pr.comment', 'edit issue #12'],
    ['repos/{owner}/{repo}/issues/12/comments -f body=Hi', 'pr.comment', 'comment on issue #12'],
    ['-X PATCH repos/{owner}/{repo}/issues/comments/55 -f body=Hi', 'pr.comment', 'edit an issue comment'],
    ['repos/{owner}/{repo}/issues/12/labels -f labels[]=bug', 'pr.comment', 'label issue #12'],
    ['-X PUT repos/{owner}/{repo}/issues/12/labels -f labels[]=bug', 'pr.comment', 'label issue #12'],
    ['repos/{owner}/{repo}/pulls/5/comments -f body=x', 'pr.comment', 'comment on PR #5'],
    ['repos/{owner}/{repo}/pulls/comments/9/replies -f body=x', 'pr.comment', 'reply to a review comment'],
    [
      'repos/{owner}/{repo}/pulls/5/comments/9/replies -f body=x',
      'pr.comment',
      'reply to a review comment on PR #5',
    ],
    ['-X POST repos/{owner}/{repo}/actions/runs/99/rerun', 'pipelines.retry', 're-run workflow run 99'],
    [
      '-X POST repos/{owner}/{repo}/actions/runs/99/rerun-failed-jobs',
      'pipelines.retry',
      're-run workflow run 99',
    ],
    ['-X POST repos/{owner}/{repo}/actions/runs/99/cancel', 'ci.run', 'cancel workflow run 99'],
    [
      'repos/{owner}/{repo}/actions/workflows/ci.yml/dispatches -f ref=main',
      'ci.run',
      'run the workflow “ci.yml”',
    ],
    [
      'repos/{owner}/{repo}/actions/workflows/deploy.yml/dispatches -f ref=main',
      'deploy',
      'run the workflow “deploy.yml”',
    ],
  ])('api %s → %s', (line, keyId, action) => {
    expect(plan(`api ${line}`)).toMatchObject({ kind: 'write', keyId, action, repo: 'acme/web' });
  });

  it.each([
    ['-X DELETE repos/{owner}/{repo}/issues/comments/5', 'commands.destructive', undefined],
    ['-X DELETE repos/{owner}/{repo}/issues/5/labels/bug', 'pr.comment', undefined],
    ['-X PUT repos/{owner}/{repo}/contents/a.txt -f message=x -f content=eA==', 'branch.main.push', 'main'],
    [
      '-X PUT repos/{owner}/{repo}/contents/a.txt -f message=x -f branch=feat/a',
      'branch.feature.readwrite',
      'feat/a',
    ],
    [
      'repos/{owner}/{repo}/git/refs -f ref=refs/heads/feat/b -f sha=abc',
      'branch.feature.readwrite',
      'feat/b',
    ],
    ['-X PATCH repos/{owner}/{repo}/git/refs/heads/main -f sha=abc', 'branch.main.push', 'main'],
    ['repos/{owner}/{repo}/git/refs -f ref=refs/tags/v1 -f sha=abc', 'code.write', undefined],
    ['-X POST repos/{owner}/{repo}/branches/main/rename -f new_name=trunk', 'branch.main.push', 'main'],
    ['repos/{owner}/{repo}/merges -f base=main -f head=feat/x', 'branch.main.push', 'main'],
    ['repos/{owner}/{repo}/releases -f tag_name=v1', 'deploy', undefined],
    ['-X POST repos/{owner}/{repo}/pages -f build_type=workflow', 'deploy', undefined],
    ['repos/{owner}/{repo}/hooks -f name=web', 'code.write', undefined],
    ['repos/{owner}/{repo}/keys -f key=x', 'branch.main.push', undefined],
    ['repos/{owner}/{repo}/keys -f key=x -F read_only=true', 'code.write', undefined],
    ['-X PUT repos/{owner}/{repo}/collaborators/x', 'branch.main.push', undefined],
    ['-X PUT repos/{owner}/{repo}/actions/secrets/X -f encrypted_value=x', 'code.write', undefined],
    [
      '-X PUT repos/{owner}/{repo}/actions/permissions/workflow -F can_approve_pull_request_reviews=true',
      'code.write',
      undefined,
    ],
    ['-X PATCH repos/{owner}/{repo} -f private=false', 'deploy', undefined],
    ['-X PATCH repos/{owner}/{repo} -F archived=true', 'commands.destructive', undefined],
    ['-X PATCH repos/{owner}/{repo} -f description=x', 'code.write', undefined],
    ['-X DELETE repos/{owner}/{repo}', 'commands.destructive', undefined],
    ['repos/{owner}/{repo}/transfer -f new_owner=x', 'commands.destructive', undefined],
    ['-X PUT repos/{owner}/{repo}/pulls/5/reviews/3/dismissals -f message=x', 'pr.approve', undefined],
  ])('api %s → %s', (line, keyId, branch) => {
    const p = plan(`api ${line}`);
    expect(p).toMatchObject({ kind: 'write', keyId, repo: 'acme/web' });
    expect(p.kind === 'write' ? p.branch : 'x').toBe(branch);
  });

  it.each([
    ['user/keys -f key=x', 'branch.main.push'],
    ['user/repos -f name=x', 'deploy'],
    ['user/repos -f name=x -F private=true', 'code.write'],
    ['orgs/acme/repos -f name=x -f visibility=internal', 'code.write'],
    ['-X PUT orgs/acme/memberships/bob', 'branch.main.push'],
    ['gists -F "files[a.txt][content]=x" -F public=true', 'deploy'],
    ['-X PATCH user -f bio=x', 'code.write'],
    ['-X DELETE user/starred/acme/web', 'commands.destructive'],
  ])('api %s (the account) → %s', (line, keyId) => {
    expect(plan(['api', ...line.split(' ').map((w) => w.replace(/^"|"$/g, ''))])).toMatchObject({
      kind: 'write',
      keyId,
      repo: null,
    });
  });

  it('GraphQL: a query reads, a mutation goes by what it does', () => {
    expect(plan(['api', 'graphql', '-f', 'query={ viewer { login } }'])).toMatchObject({
      kind: 'read',
      repo: null,
    });
    expect(
      plan([
        'api',
        'graphql',
        '-f',
        'query=mutation { addStar(input: {starrableId: "x"}) { clientMutationId } }',
      ]),
    ).toMatchObject({ kind: 'write', keyId: 'code.write', repo: null });
    expect(
      plan([
        'api',
        'graphql',
        '-f',
        'query=mutation { deleteIssue(input: {issueId: "x"}) { clientMutationId } }',
      ]),
    ).toMatchObject({ keyId: 'commands.destructive' });
    expect(
      plan(['api', 'graphql', '-f', 'query=mutation { createCommitOnBranch(input: {}) { commit { oid } } }']),
    ).toMatchObject({ keyId: 'branch.main.push' });
    expect(
      plan(['api', 'graphql', '-F', 'query=@q.graphql'], {
        files: [{ path: 'q.graphql', text: 'mutation { mergePullRequest(input: {}) { clientMutationId } }' }],
      }),
    ).toEqual({ kind: 'refuse', message: GH_COPY.merge, exitCode: 1 });
  });

  it.each([
    ['-X PUT repos/{owner}/{repo}/pulls/5/merge', GH_COPY.merge],
    ['repos/{owner}/{repo}/pulls/5/reviews -f event=APPROVE', GH_COPY.review],
    ['-X GIT repos/{owner}/{repo}/issues', 'GIT isn’t an HTTP method.'],
    ['repos/{owner}/{repo}/actions/workflows/1234/dispatches -f ref=main', GH_COPY.workflowFile],
  ])('api %s is refused', (line, message) => {
    expect(refused(plan(`api ${line}`))).toBe(message);
  });

  it('refuses headers that would change who or where, and unknown flags', () => {
    expect(refused(plan(['api', 'repos/{owner}/{repo}', '-H', 'Authorization: token x']))).toBe(
      GH_COPY.apiHeader,
    );
    expect(refused(plan(['api', 'repos/{owner}/{repo}', '-H', 'host: evil']))).toBe(GH_COPY.apiHeader);
    expect(refused(plan('api repos/{owner}/{repo} --verbose'))).toBe(
      'gh api --verbose isn’t supported here: leave it out.',
    );
  });

  it('files: --input and -F key=@file become placeholders; stdin stays', () => {
    const files = [
      { path: 'payload.json', text: '{"title":"x"}' },
      { path: 'n.txt', text: 'note' },
    ];
    expect(plan('api repos/{owner}/{repo}/issues --input payload.json', { files })).toMatchObject({
      kind: 'write',
      args: ['api', 'repos/{owner}/{repo}/issues', '--input', '@whombat-file:0'],
    });
    expect(plan('api repos/{owner}/{repo}/issues -F title=@n.txt -F labels[]=bug', { files })).toMatchObject({
      args: ['api', 'repos/{owner}/{repo}/issues', '-F', 'title=@@whombat-file:1', '-F', 'labels[]=bug'],
    });
    expect(plan('api repos/{owner}/{repo}/issues --input -', { stdin: '{}' })).toMatchObject({
      args: ['api', 'repos/{owner}/{repo}/issues', '--input', '-'],
    });
    expect(refused(plan('api repos/{owner}/{repo}/issues --input nope.json', { files }))).toBe(
      'Whombat didn’t get the file nope.json.',
    );
  });

  it('a comment’s body field is signed (raw), files too; labels and re-runs aren’t', () => {
    expect(plan(['api', 'repos/{owner}/{repo}/issues/12/comments', '-f', 'body=Hi'])).toMatchObject({
      args: ['api', 'repos/{owner}/{repo}/issues/12/comments', '-f', `body=Hi\n\n${SIG}`],
      hashArgs: ['api', 'repos/{owner}/{repo}/issues/12/comments', '-f', 'body=Hi'],
      words: ['api', 'repos/{owner}/{repo}/issues/12/comments'],
    });
    expect(
      plan(['api', 'repos/{owner}/{repo}/issues/12/comments', '-F', 'body=@n.txt'], {
        files: [{ path: 'n.txt', text: 'From a file' }],
      }),
    ).toMatchObject({
      args: ['api', 'repos/{owner}/{repo}/issues/12/comments', '-f', `body=From a file\n\n${SIG}`],
      hashArgs: ['api', 'repos/{owner}/{repo}/issues/12/comments', '-F', 'body=@@whombat-file:0'],
    });
    expect(plan(['api', 'repos/{owner}/{repo}/issues/12/labels', '-f', 'body=x'])).toMatchObject({
      args: ['api', 'repos/{owner}/{repo}/issues/12/labels', '-f', 'body=x'],
    });
  });
});
