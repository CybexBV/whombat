import { useQueryClient } from '@tanstack/react-query';
import { ApiError, filesPath } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, useBootstrap, useConversation, usePullRequest } from '@whombat/client/react';
import {
  api,
  type BranchRoomSummary,
  composerPlaceholder,
  filesNote,
  mergeToast,
  PR_STATUS_LABELS,
  shortNameOf,
} from '@whombat/core';
import { type MouseEvent, useState } from 'react';
import { useHereHref, useNavigateHref, useSearchUpdate } from '../../app/routing/navigation';
import type { BranchTab } from '../../app/routing/search';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { NotifyButton } from '../conversations/NotifyButton';
import { ConversationHeader } from '../messaging/ConversationHeader';
import { ConversationRoom, RoomStatus } from '../messaging/ConversationRoom';
import { PINS_SEARCH, usePinnedCount } from '../messaging/PinsPane';
import { useBurrowContext, useNow } from '../messaging/useRoom';
import { BranchMenu } from './BranchMenu';
import { BranchPane } from './BranchPane';
import styles from './BranchRoomScreen.module.css';
import { BranchTabs } from './BranchTabs';
import { FilesTable } from './FilesTable';
import { FileView } from './FileView';
import { prStatusChip } from './model';
import { branchRoomTarget, roomHref, roomRepo } from './prLinks';

export interface BranchRoomScreenProps {
  burrow: string;
  /** PR number (`/pr/:number`). */
  number: number;
  /** The room's repository (`?repo=owner/name`, AP-496); without it the number alone, or a choice. */
  repo?: string;
  /** `conversation` (default) or `files` (`?tab=files`). */
  tab: BranchTab;
  /** The file open in Files changed (`?tab=files&file=`, AP-664). */
  file?: string;
  /** Switches the tab (updates `?tab=`). */
  onTabChange: (tab: BranchTab) => void;
  /** Root message id of the open thread (`?thread=`). */
  threadId?: string;
}

const PANEL_ID = 'branch-room-panel';

/**
 * Branch room (TODO 10.2–10.3): the PR's conversation with a mono branch title and status chip
 * ("Open · changes requested" → "Open · ready" → "Merged", live through `pr.updated`), the
 * Conversation / Files changed tabs, and the 340px pane with CHECKS, REVIEWERS, STAGING and
 * Merge into main.
 */
export function BranchRoomScreen(props: BranchRoomScreenProps) {
  const { burrow, number, repo } = props;
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  // Several repos can have a PR with this number: a link without its repo asks which (AP-496).
  const target = bootstrap ? branchRoomTarget(bootstrap.sidebar.branchRooms, number, repo) : null;
  if (!target) return <RoomStatus screen="branch" />;
  if (target.kind === 'choose') return <BranchRoomChooser number={number} rooms={target.rooms} />;
  return <BranchRoom {...props} repo={target.repo} />;
}

function BranchRoom({ burrow, number, repo, tab, file, onTabChange }: BranchRoomScreenProps) {
  const repoQuery = repo ? { repo } : {};
  const pr = usePullRequest({ params: { burrow, number }, query: repoQuery });
  const here = useHereHref();
  const navigateHref = useNavigateHref();
  const conversationId = pr.data?.pr.conversationId;
  const conv = useConversation(conversationId ? { params: { burrow, conversationId } } : null);
  const pinned = usePinnedCount(burrow, conversationId);
  const { lookup, me, timeZone } = useBurrowContext(burrow);
  const now = useNow(60_000);
  const updateSearch = useSearchUpdate();
  const toast = useToast();
  const qc = useQueryClient();
  const merge = useApiMutation(api.prs.merge);
  const [mergeError, setMergeError] = useState<string | null>(null);

  const detail = pr.data;
  const room = conv.data;
  if (!detail || !room) {
    const failed = pr.error || conv.error;
    return failed ? (
      <RoomStatus
        screen="branch"
        title={repo ? `${repo} · PR #${number}` : `PR #${number}`}
        message="There’s no branch room for this pull request, or you’re not in it."
        onRetry={() => {
          void pr.refetch();
          void conv.refetch();
        }}
      />
    ) : (
      <RoomStatus screen="branch" />
    );
  }

  const onMerge = async () => {
    setMergeError(null);
    try {
      const result = await merge.mutateAsync({ params: { burrow, number }, query: repoQuery, body: {} });
      if (result.status === 'ok') {
        qc.setQueryData(queryKeys.prs.get({ params: { burrow, number }, query: repoQuery }), result.data);
        void qc.invalidateQueries({ queryKey: queryKeys.scope('conversations.bootstrap') });
        toast.show(mergeToast(number));
      } else if (result.status === 'blocked') {
        setMergeError(`Blocked: merging needs the “${result.keyNeeded.label}” key.`);
      } else {
        setMergeError('That needs a person to approve it first. We’ve asked.');
      }
    } catch (err) {
      setMergeError(
        err instanceof ApiError && err.message ? err.message : 'Couldn’t merge. Try again in a moment.',
      );
      void qc.invalidateQueries({ queryKey: queryKeys.scope('prs.get') });
    }
  };

  const c = room.conversation;
  // An open file takes the whole room: no side pane, no composer (AP-666).
  const fileOpen = tab === 'files' && !!file;
  const author = detail.pr.authorId ? lookup(detail.pr.authorId) : undefined;
  const viewer = me ? { id: me.id, kind: 'person' as const } : undefined;

  return (
    <div className={styles.layout}>
      <ConversationRoom
        burrow={burrow}
        detail={room}
        screen="branch"
        kind="branch"
        label={c.title}
        placeholder={composerPlaceholder({ kind: 'branch', prNumber: number })}
        scrollId={PANEL_ID}
        composer={!fileOpen}
        header={
          <ConversationHeader
            variant={{ kind: 'branch', title: c.title, topic: c.topic, status: prStatusChip(detail.status) }}
            plansHref={here({
              plans: 1,
              plan: undefined,
              step: undefined,
              thread: undefined,
              pins: undefined,
            })}
            filesHref={filesPath({ type: 'pr', number, ...(repo ? { repo } : {}) })}
            pins={pinned ? { count: pinned, href: here(PINS_SEARCH) } : undefined}
            onNavigate={(href) => navigateHref(href)}
            tools={
              <>
                <NotifyButton
                  burrow={burrow}
                  conversation={{ id: c.id, kind: c.kind, notify: room.notify ?? room.summary.notify }}
                />
                {/* What the sidebar's room row offered (SS-53). */}
                <BranchMenu conversationId={c.id} branch={c.title} />
              </>
            }
          />
        }
        tabs={
          <BranchTabs
            tab={tab}
            fileCount={detail.pr.files.length}
            onTabChange={onTabChange}
            panelId={PANEL_ID}
          />
        }
        body={
          tab !== 'files' ? undefined : file ? (
            <FileView
              key={file}
              burrow={burrow}
              number={number}
              repo={repo}
              path={file}
              files={detail.pr.files}
              headSha={detail.pr.headSha}
              backHref={here({ tab: 'files', file: undefined })}
              fileHref={(path) => here({ tab: 'files', file: path })}
              onNavigate={(href) => navigateHref(href)}
            />
          ) : (
            <FilesTable
              files={detail.pr.files}
              note={filesNote(author ? shortNameOf(author) : 'the author')}
              fileHref={(path: string) => here({ tab: 'files', file: path })}
              onNavigate={(href: string) => navigateHref(href)}
            />
          )
        }
      />
      {!fileOpen && (
        <BranchPane
          detail={detail}
          lookup={lookup}
          viewer={viewer}
          now={now}
          timeZone={timeZone}
          onReviewApproval={(n) => void updateSearch((s) => ({ ...s, approval: n }))}
          onMerge={() => void onMerge()}
          merging={merge.isPending}
          mergeError={mergeError}
        />
      )}
    </div>
  );
}

/**
 * “Which PR #1?”: several repos have a branch room with this number and the link didn't say which (an older link, an
 * older runtime's; AP-496). One row per room, its repo, branch and state, each a real link to `?repo=`.
 */
function BranchRoomChooser({ number, rooms }: { number: number; rooms: BranchRoomSummary[] }) {
  const navigateHref = useNavigateHref();
  const follow = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigateHref(href, { replace: true });
  };
  return (
    <section className={styles.chooser} data-screen="branch" aria-labelledby="pr-chooser-title">
      <h1 id="pr-chooser-title" className={styles.chooserTitle}>
        Which PR #{number}?
      </h1>
      <p className={styles.chooserText}>
        {rooms.length === 2 ? 'Two repos have' : `${rooms.length} repos have`} a pull request #{number}. Pick
        the one you meant.
      </p>
      <ul className={styles.chooserList}>
        {rooms.map((room) => {
          const href = roomHref(room);
          const chip = prStatusChip(room.prStatus);
          return (
            <li key={room.id}>
              <a href={href} className={styles.chooserRow} onClick={follow(href)}>
                <StatusDot tone={chip.tone} size={8} label={PR_STATUS_LABELS[room.prStatus]} />
                <span className={styles.chooserMain}>
                  <span className={styles.chooserRepo}>{roomRepo(room)}</span>
                  <span className={styles.chooserMeta}>
                    {room.branch} · {PR_STATUS_LABELS[room.prStatus]}
                  </span>
                </span>
                <span className={styles.chooserNumber}>#{number}</span>
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
