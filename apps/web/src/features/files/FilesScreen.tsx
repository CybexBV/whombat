/**
 * `/files`: the person's Chat's files straight away (`FilesSpaceScreen`), the other conversations with files at its top
 * like folders. A Whombat without the Chat room (an older one) keeps the list of conversations below.
 *
 * The list (docs/decisions/files-space.md AP-773; the final design, docs/design-handoff/council-ui-2026-11/16-final/files/,
 * docs/decisions/final-settings-vault-files-usage.md): the one Files home, the conversations with files the viewer may
 * see (`files.summary`, FS-07), newest activity first, in one card — the conversation's mark (a branch room's folder,
 * the assistant's head for Chat) and name over “4 files · 136 MB · Last added 23 Sep 11:20”. A row opens that
 * conversation's Files. Loading, no files yet (with Go to Chat) and a failed read each have a card of their own.
 */
import { WhombatAvatar } from '@whombat/avatars/react';
import {
  agentFaceOf,
  FILES_COPY,
  type FilesConversationRow,
  type FilesPlace,
  filesConversationId,
  filesConversationRows,
  filesPath,
  filesSpaceLine,
} from '@whombat/client';
import { useBootstrap, useFilesSummary, useTheAgent } from '@whombat/client/react';
import type { AgentFace } from '@whombat/core';
import { Folder, MessageSquare } from 'lucide-react';
import { Icon } from '../../components/Icon';
import { useBurrowViewer } from '../runs/useBurrowViewer';
import { errorDetail, PlaceRowBody, PlaceState, placeStyles as place } from '../settings/Place';
import { AppLink } from './AppLink';
import styles from './Files.module.css';
import { FilesSpaceScreen } from './FilesSpaceScreen';
import { useConversationNaming } from './useFilesPlace';

export interface FilesScreenProps {
  burrow: string;
  /** The open folder of the Chat's files (`?folder=`). */
  folder?: string;
}

const CHAT: FilesPlace = { type: 'dm', room: 'chat' };

export function FilesScreen({ burrow, folder = '' }: FilesScreenProps) {
  const { data: bootstrap } = useBootstrap({ params: { burrow } });
  // Until the bootstrap is read the Chat's page waits (it shows its own loading rows).
  if (!bootstrap || filesConversationId(CHAT, bootstrap))
    return <FilesSpaceScreen burrow={burrow} place={CHAT} folder={folder} />;
  return <ConversationList burrow={burrow} />;
}

function ConversationList({ burrow }: { burrow: string }) {
  const { data, error, refetch } = useFilesSummary({ params: { burrow } }, { retry: false });
  const viewer = useBurrowViewer(burrow);
  const rows = filesConversationRows(data, viewer.bootstrap);
  const { words } = useTheAgent(burrow);
  return (
    <section className={place.scroll} data-screen="files" aria-labelledby="files-title">
      <div className={place.page}>
        <div className={place.header}>
          <div className={place.heading}>
            <h1 id="files-title" className={place.title}>
              {FILES_COPY.title}
            </h1>
            <p className={place.intro}>{FILES_COPY.intro}</p>
          </div>
        </div>
        {!data ? (
          error ? (
            <PlaceState
              kind="failed"
              icon={Folder}
              title={FILES_COPY.readFailed}
              line={FILES_COPY.readFailedLine}
              retryLabel={FILES_COPY.retry}
              onRetry={() => void refetch()}
              detail={errorDetail(error)}
            />
          ) : (
            <PlaceState kind="loading" icon={Folder} title={FILES_COPY.loading} />
          )
        ) : rows.length === 0 ? (
          <PlaceState
            kind="empty"
            icon={Folder}
            title={FILES_COPY.emptyTitle}
            line={FILES_COPY.emptyLine(words.Name)}
          >
            <AppLink href="/chat" className={styles.goToChat}>
              {FILES_COPY.goToChat}
            </AppLink>
          </PlaceState>
        ) : (
          <ul className={place.card} aria-label="Conversations with files">
            {rows.map((row) => (
              <ConversationRow
                key={row.conversationId}
                burrow={burrow}
                row={row}
                timeZone={viewer.timeZone}
              />
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The conversation's mark: the agent's head for the person's rooms with it, else a folder (a branch for a branch room). */
export function ConversationMark({
  row,
  agent,
}: {
  row: FilesConversationRow;
  agent: { name: string; face?: AgentFace | null } | null | undefined;
}) {
  if (row.kind === 'dm' && agent)
    return <WhombatAvatar face={agentFaceOf(agent)} crop="head" size={28} label={agent.name} />;
  return (
    <span className={styles.icon} aria-hidden="true">
      <Icon name={row.kind === 'branch' ? 'branch' : 'folder'} size={15} />
    </span>
  );
}

/** The conversation's name (“Chat”, “Feedback”, a branch). */
export function ConversationLabel({ row }: { row: FilesConversationRow }) {
  return <>{row.label}</>;
}

/**
 * A conversation with files: its mark, its name over how many files, their size and when the last one was added; the
 * whole row opens that conversation's Files.
 */
function ConversationRow({
  burrow,
  row,
  timeZone,
}: {
  burrow: string;
  row: FilesConversationRow;
  timeZone: string;
}) {
  // A task chat isn't in the sidebar: named from the conversation itself.
  const named = useConversationNaming(burrow, row.kind === 'unknown' ? row.conversationId : null);
  const { agent } = useTheAgent(burrow);
  const shown = named
    ? { ...row, ...named, count: row.count, bytes: row.bytes, lastAddedAt: row.lastAddedAt }
    : row;
  if (!shown.link) return null;
  return (
    <li>
      <AppLink href={filesPath(shown.link)} className={place.row} data-files-conversation="">
        <PlaceRowBody
          icon={shown.kind === 'dm' ? MessageSquare : Folder}
          mark={shown.kind === 'dm' && agent ? <ConversationMark row={shown} agent={agent} /> : undefined}
          name={<ConversationLabel row={shown} />}
          line={filesSpaceLine(shown, timeZone)}
        />
      </AppLink>
    </li>
  );
}
