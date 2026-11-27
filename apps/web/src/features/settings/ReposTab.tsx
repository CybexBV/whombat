import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, useBootstrap, useGitHubStatus, useRepos, useTheAgent } from '@whombat/client/react';
import { GITHUB_SIGNIN_TEXT, githubSignInOf } from '@whombat/client/signins';
import { api } from '@whombat/core/contracts';
import { type Repo, repoDisplayName, repoSourceOf } from '@whombat/core/domain';
import { formatRepoMeta, formatUpdated, githubConnectedToast } from '@whombat/core/text';
import { useEffect, useRef, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { ErrorNote, SkeletonRows } from '../../components/ListState';
import { SectionLabel } from '../../components/SectionLabel';
import { StatusDot } from '../../components/StatusDot';
import { Tag } from '../../components/Tag';
import { useToast } from '../../components/Toast';
import { currentLocale, useWebI18n } from '../../i18n/provider';
import { GitHubSignInRow, useGitHubRefresh, useSignInsStatus } from '../ai';
import { GitHubNotice } from '../github/GitHubNotice';
import { useConnectGitHub } from '../github/useGitHub';
import { GitHubMark } from './GitHubMark';
import { NewRepoModal } from './NewRepoModal';
import styles from './ReposTab.module.css';
import base from './SettingsScreen.module.css';

/** How long a repository just created stays highlighted in the list. */
const FRESH_MS = 2_400;

/**
 * Settings → Connections → GitHub (was Settings → Repositories, “Software Dev” before that; docs/decisions/
 * repositories.md AP-540…AP-549, settings-simplify.md SS-05):
 * - GITHUB: one card that walks you from nothing to connected: “Sign in to GitHub” shows GitHub's device code and,
 *   once signed in, connects the burrow by itself (AP-543).
 * - REPOSITORIES: the burrow's repos — every one the GitHub account owns, others the agent worked in, and the ones kept
 *   on this Whombat — with nothing to pick (docs/decisions/agent-repos.md AGR-12), and “New repository” (`repos.create`):
 *   a Git repository on this Whombat, first commit by you.
 */
export function ReposTab({ burrow }: { burrow: string }) {
  const { tag: uiLocale } = useWebI18n();
  const toast = useToast();
  const { words } = useTheAgent(burrow);
  const qc = useQueryClient();
  const managed = Boolean(useAppServices().managed);
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  const reposQuery = useRepos({ params: { burrow } });
  const githubQuery = useGitHubStatus({ params: { burrow } });
  const syncRepos = useApiMutation(api.repos.sync);

  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [connectProblem, setConnectProblem] = useState<{ message: string } | null>(null);
  // Signed in from this card: connect as soon as the runtime says it can (AP-543).
  const [autoConnect, setAutoConnect] = useState(false);

  const timeZone = bootstrap?.burrow.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.now();
  const burrowName = bootstrap?.burrow.name ?? burrow;

  const repos = reposQuery.data?.repos ?? [];
  const create = reposQuery.data?.create;
  const github = githubQuery.data;
  const connected = github?.connected ?? reposQuery.data?.githubConnected ?? false;
  const canConnect = github?.canConnect ?? false;
  // GitHub is reached through people's own sign-ins (AP-543).
  const signInNeeded = !connected && github?.signInNeeded === true;
  // Your own GitHub sign-in lives here (AP-550): the connection runs on it.
  const signIns = useSignInsStatus(true);
  const githubOff = github?.mode === 'off';
  const refreshGitHub = useGitHubRefresh();
  const signedInAs = githubSignInOf(signIns.data)?.login ?? null;
  const { connect, connecting } = useConnectGitHub(burrow);
  const problem = connectProblem ?? (github?.error ? { message: github.error } : null);
  const reposKey = queryKeys.repos.list({ params: { burrow } });

  async function handleConnect() {
    setConnectProblem(null);
    const result = await connect();
    if (result.ok) toast.show(githubConnectedToast(words.name, uiLocale));
    else setConnectProblem({ message: result.message });
  }

  const connectRef = useRef(handleConnect);
  connectRef.current = handleConnect;
  useEffect(() => {
    if (!autoConnect || connected || connecting || !canConnect) return;
    setAutoConnect(false);
    void connectRef.current();
  }, [autoConnect, connected, connecting, canConnect]);

  async function handleSync() {
    const result = await syncRepos.mutateAsync({ params: { burrow } });
    if (result.status === 'ok') void qc.invalidateQueries({ queryKey: reposKey });
  }

  function handleCreated(repo: Repo) {
    setCreating(false);
    setFresh(repo.id);
    window.setTimeout(() => setFresh((id) => (id === repo.id ? null : id)), FRESH_MS);
    void qc.invalidateQueries({ queryKey: reposKey });
    toast.show(`Created ${repoDisplayName(repo)}. ${words.Name} can work in it now.`);
  }

  const mayCreate = create?.allowed === true;
  const newRepoButton = mayCreate ? (
    <Button
      variant="secondary"
      size="sm"
      iconStart={<Icon name="add" size={15} />}
      onClick={() => setCreating(true)}
    >
      New repository
    </Button>
  ) : null;

  /* GITHUB ------------------------------------------------------------------------------------------------------ */

  const login = github?.login ?? null;
  const githubTitle = connected
    ? login
      ? `@${login}`
      : 'Connected'
    : githubOff
      ? 'GitHub is off'
      : 'Connect GitHub';
  const githubMeta = connected
    ? login
      ? `Connected. ${words.Name} works in every repository @${login} owns, as @${login}.`
      : `Connected. ${words.Name} works in every repository this account owns, as this account.`
    : githubOff
      ? 'GitHub is switched off on this Whombat, so repos come only from here.'
      : signInNeeded
        ? `Sign in with your GitHub account and ${burrowName} is connected right after. ${words.Name} then works on your repos as you.`
        : canConnect
          ? `You’re signed in${signedInAs ? ` as @${signedInAs}` : ''}. Connect it for ${burrowName} and ${words.name} works on your GitHub repos as you.`
          : GITHUB_SIGNIN_TEXT.dev.signInFirst;

  const githubSection = (
    <section className={base.section} aria-labelledby="repos-github">
      <SectionLabel as="h2" id="repos-github">
        GITHUB
      </SectionLabel>
      <div className={base.card}>
        {!github && githubQuery.isPending ? (
          <SkeletonRows count={1} lines={2} />
        ) : (
          <div className={cx(base.row, styles.githubRow)}>
            <span className={cx(styles.tile, styles.githubTile, connected && styles.tileOn)}>
              <GitHubMark size={20} />
              {connected ? (
                <span className={styles.tileDot}>
                  <StatusDot tone="ok" size={8} label={null} />
                </span>
              ) : null}
            </span>
            <span className={base.rowMain}>
              <span className={cx(base.rowTitle, connected && login && styles.login)}>{githubTitle}</span>
              <span className={base.rowMeta}>{githubMeta}</span>
            </span>
            {connected ? (
              <Button
                variant="ghost"
                size="sm"
                iconStart={<Icon name="refresh" size={14} />}
                onClick={handleSync}
                disabled={syncRepos.isPending}
              >
                {syncRepos.isPending ? 'Syncing…' : 'Sync repos'}
              </Button>
            ) : !connected && canConnect ? (
              <Button
                variant="primary"
                size="md"
                onClick={handleConnect}
                disabled={connecting || !canConnect}
              >
                {connecting ? 'Connecting…' : 'Connect GitHub'}
              </Button>
            ) : null}
          </div>
        )}
        {!githubOff && (
          <div className={styles.signInRow}>
            <GitHubSignInRow
              list={signIns.data}
              title="Your GitHub sign-in"
              onChanged={refreshGitHub}
              // Signing in here connects the burrow right after (AP-543), unless it already is.
              onSignedIn={() => {
                if (!connected) setAutoConnect(true);
              }}
            />
          </div>
        )}
        {connecting && autoConnect === false && !connected && (
          <div className={base.noticeRow}>
            <span className={styles.connectingNote} role="status">
              <StatusDot tone="warn" size={8} label={null} /> Connecting {burrowName} to GitHub…
            </span>
          </div>
        )}
        {(problem || github?.note) && (
          <div className={base.noticeRow}>
            {problem ? (
              <GitHubNotice text={problem.message} />
            ) : (
              <GitHubNotice text={github?.note ?? ''} tone="neutral" />
            )}
          </div>
        )}
      </div>
    </section>
  );

  /* REPOSITORIES ------------------------------------------------------------------------------------------------ */

  const emptyText = mayCreate
    ? connected
      ? 'Create one on this Whombat. Every repository you own on GitHub shows up here too.'
      : 'Create one on this Whombat, or connect GitHub above to bring in yours.'
    : connected
      ? 'Every repository you own on GitHub shows up here.'
      : 'Connect GitHub above to bring in your repos.';

  const reposSection = (
    <section className={base.section} aria-labelledby="repos-list">
      <div className={base.sectionHead}>
        <SectionLabel as="h2" id="repos-list">
          REPOSITORIES
        </SectionLabel>
        {repos.length > 0 ? newRepoButton : null}
      </div>
      {reposQuery.error && !reposQuery.data ? (
        <ErrorNote
          message="Couldn’t load repos. Try again in a moment."
          onRetry={() => void reposQuery.refetch()}
        />
      ) : !reposQuery.data ? (
        <div className={base.card}>
          <SkeletonRows count={3} lines={2} />
        </div>
      ) : repos.length === 0 ? (
        <div className={cx(base.card, styles.empty)}>
          <span className={styles.emptyIcon}>
            <Icon name="branch" size={22} />
          </span>
          <span className={styles.emptyTitle}>No repositories yet</span>
          <span className={styles.emptyText}>{emptyText}</span>
          {mayCreate ? (
            <Button
              variant="primary"
              size="md"
              iconStart={<Icon name="add" size={15} />}
              onClick={() => setCreating(true)}
            >
              New repository
            </Button>
          ) : null}
        </div>
      ) : (
        <div className={base.card}>
          {repos.map((repo) => (
            <RepoRow
              key={repo.id}
              repo={repo}
              fresh={fresh === repo.id}
              now={now}
              timeZone={timeZone}
              managed={managed}
            />
          ))}
        </div>
      )}
      {create && !create.allowed && create.reason ? (
        <span className={base.fieldHint}>{create.reason}</span>
      ) : null}
    </section>
  );

  return (
    <>
      {githubSection}
      {reposSection}
      {create?.author ? (
        <NewRepoModal
          burrow={burrow}
          open={creating}
          onOpenChange={setCreating}
          author={create.author}
          taken={repos.map((r) => repoDisplayName(r))}
          onCreated={handleCreated}
        />
      ) : null}
    </>
  );
}

/** One repo of the burrow: where it lives and what it is. */
function RepoRow({
  repo,
  fresh,
  now,
  timeZone,
  managed,
}: {
  repo: Repo;
  fresh: boolean;
  now: number;
  timeZone: string;
  managed: boolean;
}) {
  const local = repoSourceOf(repo) === 'local';
  const since = repo.createdAt ?? repo.pushedAt;
  const meta = local
    ? [
        repo.description || null,
        since ? `created ${formatUpdated(since, now, timeZone, currentLocale())}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : formatRepoMeta(repo.language, repo.pushedAt, now, timeZone, currentLocale());
  return (
    <div className={cx(base.row, styles.repoRow, fresh && styles.fresh)}>
      <span className={cx(styles.tile, local ? styles.localTile : styles.githubTile)}>
        {local ? <Icon name="branch" size={17} /> : <GitHubMark size={16} />}
      </span>
      <span className={base.rowMain}>
        <span className={styles.repoName}>
          <span className={base.rowRepo}>{repoDisplayName(repo)}</span>
          {local ? <Tag tone="brand">On this Whombat</Tag> : null}
        </span>
        <span className={base.rowMeta}>{meta}</span>
        {/* Self-hosted: where to clone it from on this machine; a managed box has no shell to use it in. */}
        {local && repo.path && !managed ? (
          <span className={styles.repoPath} title={repo.path}>
            {repo.path}
          </span>
        ) : null}
      </span>
    </div>
  );
}
