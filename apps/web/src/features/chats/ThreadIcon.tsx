/**
 * The icon at the start of a thread's row in Chat's and Feedback's lists (app chat-inbox-web.md): what the thread is
 * about at a glance, and its state on the icon's corners. A repository's own icon on a rounded tile (its letter on an
 * avatar tone until the picture arrives, when it fails or when there is none), the thing a thread is about as the
 * sidebar and Overview mark it, else the assistant's face. Something new is a blue dot on the top corner; where the
 * thread stands is a mark on the bottom corner, told apart by its shape (CTC-09): a filled dot waiting for the person, a
 * turning ring at work, a dashed ring waiting for checks, a tick done, a ring with a bar where it didn't finish, a square
 * stopped. Decorative: the row's name says all of it.
 */
import { HUMAN_INITIALS_COLOR, toneFor } from '@whombat/avatars';
import { WhombatAvatar } from '@whombat/avatars/react';
import { BrandMark } from '@whombat/brand/react';
import {
  agentFaceOf,
  type RowStatusKind,
  type ThreadIconFields,
  thingGlyph,
  thingMark,
} from '@whombat/client';
import { useHomeOverview, useTheAgent } from '@whombat/client/react';
import { thingId } from '@whombat/core';
import { useState } from 'react';
import { Icon } from '../../components/Icon';
import { usePhotoSrc } from '../messaging/attachmentSource';
import { THING_ICONS } from '../things/thingIcons';
import styles from './ThreadIcon.module.css';

/** The icon's size in the list. */
export const THREAD_ICON = 40;

export function ThreadIcon({
  burrow,
  row,
  fresh = false,
  status = null,
  size = THREAD_ICON,
}: {
  burrow: string;
  row: ThreadIconFields;
  /** Something in the thread is new. */
  fresh?: boolean;
  /** Where the thread stands (`InboxRow.status`); null shows no mark. */
  status?: RowStatusKind | null;
  size?: number;
}) {
  return (
    <span
      className={styles.icon}
      style={{ width: size, height: size }}
      aria-hidden="true"
      data-thread-icon={row.icon}
    >
      {row.icon === 'repo' ? (
        <RepoTile
          name={row.repoName ?? ''}
          letter={row.repoLetter ?? '?'}
          url={row.repoIconUrl}
          size={size}
        />
      ) : row.icon === 'subject' && row.subjectKind && row.subjectId ? (
        <SubjectTile burrow={burrow} kind={row.subjectKind} id={row.subjectId} size={size} />
      ) : (
        <AgentFace burrow={burrow} size={size} />
      )}
      {fresh ? <span className={styles.fresh} data-thread-new="" /> : null}
      {status ? (
        <span
          className={styles.working}
          data-thread-status={status}
          data-thread-working={status === 'working' ? '' : undefined}
        >
          <StatusMark kind={status} />
        </span>
      ) : null}
    </span>
  );
}

/** The mark of where a thread stands, 16px, by shape so colour never says it alone. */
function StatusMark({ kind }: { kind: RowStatusKind }) {
  const box = { width: 16, height: 16, viewBox: '0 0 16 16' } as const;
  switch (kind) {
    case 'working':
      return (
        <svg className={styles.ring} {...box} aria-hidden="true">
          <circle className={styles.track} cx="8" cy="8" r="6" />
          <circle className={styles.arc} cx="8" cy="8" r="6" />
        </svg>
      );
    case 'waiting':
      return (
        <svg className={styles.waitingMark} {...box} aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
        </svg>
      );
    case 'checks':
      return (
        <svg className={styles.checksMark} {...box} aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
        </svg>
      );
    case 'done':
      return (
        <svg className={styles.doneMark} {...box} aria-hidden="true">
          <circle cx="8" cy="8" r="7" />
          <path d="M4.8 8.3l2.1 2.1 4.3-4.6" />
        </svg>
      );
    case 'failed':
      return (
        <svg className={styles.failedMark} {...box} aria-hidden="true">
          <circle cx="8" cy="8" r="6" />
          <path d="M5 8h6" />
        </svg>
      );
    default:
      return (
        <svg className={styles.stoppedMark} {...box} aria-hidden="true">
          <rect x="3" y="3" width="10" height="10" rx="2" />
        </svg>
      );
  }
}

/**
 * The repository's own picture, loaded as a person's photo is; its letter on a tone chosen from its name shows until
 * then, and stays when there is no picture or it fails.
 */
function RepoTile({
  name,
  letter,
  url,
  size,
}: {
  name: string;
  letter: string;
  url: string | null;
  size: number;
}) {
  const src = usePhotoSrc(url);
  const [shown, setShown] = useState<{ src: string; ok: boolean } | null>(null);
  const loaded = !!src && shown?.src === src && shown.ok;
  const failed = !!src && shown?.src === src && !shown.ok;
  return (
    <span
      className={styles.tile}
      style={{
        background: loaded ? undefined : toneFor(name.toLocaleLowerCase()),
        color: HUMAN_INITIALS_COLOR,
        fontSize: Math.round(size * 0.42),
      }}
    >
      {loaded ? null : letter}
      {src && !failed ? (
        <img
          className={styles.picture}
          src={src}
          alt=""
          draggable={false}
          onLoad={() => setShown({ src, ok: true })}
          onError={() => setShown({ src, ok: false })}
        />
      ) : null}
    </span>
  );
}

/** The thing a thread is about, with the mark the app gives it elsewhere (the sidebar, Overview), on a quiet tile. */
function SubjectTile({
  burrow,
  kind,
  id,
  size,
}: {
  burrow: string;
  kind: 'server' | 'connection' | 'device';
  id: string;
  size: number;
}) {
  const { data } = useHomeOverview({ params: { burrow } }, { retry: false });
  const thing = data?.things.find((t) => t.id === thingId(kind, id));
  const mark = thing ? thingMark(thing) : null;
  const glyph = thing
    ? thingGlyph(thing)
    : kind === 'server'
      ? 'server'
      : kind === 'device'
        ? 'device'
        : 'plug';
  const inner = Math.round(size * 0.55);
  return (
    <span className={styles.tile}>
      {mark ? <BrandMark mark={mark} size={inner} /> : <Icon icon={THING_ICONS[glyph]} size={inner} />}
    </span>
  );
}

/** The assistant's face, round on a quiet disc, as its chats show it. */
function AgentFace({ burrow, size }: { burrow: string; size: number }) {
  const { agent } = useTheAgent(burrow);
  return (
    <span className={styles.face}>
      {agent ? <WhombatAvatar face={agentFaceOf(agent)} size={size} crop="head" /> : null}
    </span>
  );
}
