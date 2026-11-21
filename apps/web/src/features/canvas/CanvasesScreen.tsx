import { Link, useNavigate } from '@tanstack/react-router';
import { WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceBackground } from '@whombat/client';
import { useBurrow, useCanvases } from '@whombat/client/react';
import { DEFAULT_AGENT_FACE } from '@whombat/core';
import { formatUpdated } from '@whombat/core/text';
import { useState } from 'react';
import { Button } from '../../components/Button';
import { EmptyNote, ErrorNote, SkeletonRows } from '../../components/ListState';
import { PersonAvatar } from '../messaging/PersonAvatar';
import styles from './CanvasesScreen.module.css';
import { NewCanvasDialog } from './NewCanvasDialog';
import { usePrincipals } from './principals';

export interface CanvasesScreenProps {
  burrow: string;
}

/**
 * Canvases index (TODO 11.4). Not mocked in the reference; follows the audit-log/roster row language
 * (row list, border-top, mono meta) since that's the nearest pattern for "a list of things with people
 * and a time attached to them".
 */
export function CanvasesScreen({ burrow }: CanvasesScreenProps) {
  const { data, error, refetch } = useCanvases({ params: { burrow } });
  const burrowQuery = useBurrow({ params: { burrow } });
  const { byId: principals } = usePrincipals(burrow);
  const timeZone = burrowQuery.data?.burrow.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = Date.now();
  const navigate = useNavigate();
  // “New canvas” (essentials-messages.md AP-449).
  const [creating, setCreating] = useState(false);

  if (error && !data) {
    return (
      <div className={styles.screen} data-screen="canvases">
        <div className={styles.page}>
          <ErrorNote
            message="Couldn’t load canvases. Try again in a moment."
            onRetry={() => void refetch()}
          />
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className={styles.screen} data-screen="canvases">
        <div className={styles.page}>
          <SkeletonRows count={6} lines={1} />
        </div>
      </div>
    );
  }

  return (
    <div className={styles.screen} data-screen="canvases">
      <div className={styles.page}>
        <div className={styles.head}>
          <div className={styles.headRow}>
            <h1 className={styles.h1}>Canvases</h1>
            <p className={styles.sub}>
              {data.canvases.length} canvas{data.canvases.length === 1 ? '' : 'es'} in {burrow}.
            </p>
          </div>
          <Button variant="primary" size="xl" onClick={() => setCreating(true)}>
            New canvas
          </Button>
        </div>
        <NewCanvasDialog
          burrow={burrow}
          open={creating}
          onOpenChange={setCreating}
          onCreated={(canvas) => void navigate({ to: '/canvases/$slug', params: { slug: canvas.slug } })}
        />
        {data.canvases.length === 0 && <EmptyNote>No canvases yet. Start one with “New canvas”.</EmptyNote>}
        <div className={styles.list}>
          {data.canvases.map((canvas) => {
            const authorIds = [canvas.provenance.createdById, ...canvas.provenance.editorIds];
            const authors = [...new Set(authorIds)]
              .map((id) => principals.get(id))
              .filter((p): p is NonNullable<typeof p> => Boolean(p));
            return (
              <Link
                key={canvas.id}
                to="/canvases/$slug"
                params={{ slug: canvas.slug }}
                className={styles.row}
              >
                <span className={styles.rowMain}>
                  <span className={styles.title}>{canvas.title}</span>
                  {canvas.conversationTitle && <span className={styles.tag}>{canvas.conversationTitle}</span>}
                </span>
                <span className={styles.authors}>
                  {authors.map((p) => (
                    <span
                      key={p.id}
                      className={
                        p.kind === 'agent'
                          ? `${styles.authorAvatar} ${styles.authorAgent}`
                          : styles.authorAvatar
                      }
                      style={
                        p.kind === 'agent'
                          ? { background: agentFaceBackground(p.face ?? DEFAULT_AGENT_FACE) }
                          : undefined
                      }
                    >
                      {p.kind === 'agent' ? (
                        // The small head on a 14% tint of the face's colour, not clipped (FA-06).
                        <WhombatAvatar face={p.face ?? DEFAULT_AGENT_FACE} size={18} />
                      ) : (
                        <PersonAvatar avatarUrl={p.avatarUrl} initials={p.initials} tone={p.tone} size={22} />
                      )}
                    </span>
                  ))}
                </span>
                <span className={styles.updated}>
                  updated {formatUpdated(canvas.updatedAt, now, timeZone)}
                </span>
              </Link>
            );
          })}
        </div>
      </div>
    </div>
  );
}
