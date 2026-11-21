import type { Editor } from '@tiptap/core';
import { withBurrow } from '@whombat/client';
import { applianceLink } from '@whombat/client/managed';
import { useBootstrap, useBurrow, useCanvas, useSubscription } from '@whombat/client/react';
import { topics } from '@whombat/core';
import { formatCanvasProvenance, formatPresence } from '@whombat/core/text';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { Button } from '../../components/Button';
import { Icon } from '../../components/Icon';
import { ErrorNote, Skeleton, SkeletonRows } from '../../components/ListState';
import { useToast } from '../../components/Toast';
import styles from './CanvasScreen.module.css';
import { canvasHeading } from './canvasCopy';
import { useCollaborators, useMinWidth } from './collab/hooks';
import { useCanvasCollab } from './collab/session';
import { collabUserOf, presentPrincipalIds } from './collab/users';
import { CommentsColumn } from './comments/CommentsColumn';
import { type SelectionAnchor, selectionAnchor } from './editor/anchors';
import { CanvasEditor } from './editor/CanvasEditor';
import { CanvasViewContext, type CanvasViewValue } from './editor/context';
import { PrincipalAvatar } from './PrincipalAvatar';
import { type PrincipalLite, usePrincipals } from './principals';

export interface CanvasScreenProps {
  burrow: string;
  /** Canvas slug (`/canvases/:slug`). */
  slug: string;
}

/** The comments column sits beside the article from this width (README: "only ≥1200px; otherwise stacks"). */
const WIDE_PX = 1200;

function principalName(byId: Map<string, PrincipalLite>, id: string): string {
  return byId.get(id)?.shortName ?? '…';
}

/** Where the "Comment" button floats: above the end of the selected words, in the grid's coordinates. */
interface SelectionButton {
  sel: SelectionAnchor;
  top: number;
  left: number;
}

/**
 * Collaborative canvas (TODO 11.1–11.3): header with live presence, the article as a live Tiptap editor on the
 * canvas's Yjs document (carets, "is writing", the plan block bound to the Plan, author-tinted highlights) and
 * the comments column (threads next to their anchors, new comments on selected words, replies, resolve).
 */
export function CanvasScreen({ burrow, slug }: CanvasScreenProps) {
  const { data, error, refetch } = useCanvas({ params: { burrow, slug } });
  const burrowQuery = useBurrow({ params: { burrow } });
  const bootstrap = useBootstrap({ params: { burrow } });
  const { byId: principals } = usePrincipals(burrow);
  const toast = useToast();
  const { managed } = useAppServices();
  const wide = useMinWidth(WIDE_PX);
  const gridRef = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selection, setSelection] = useState<SelectionButton | null>(null);
  const [draft, setDraft] = useState<SelectionAnchor | null>(null);

  useSubscription(data ? topics.canvas(data.canvas.id) : null);

  // One session per canvas document (not per refetch of its metadata).
  const canvasId = data?.canvas.id;
  const documentName = data?.documentName;
  const target = useMemo(
    () => (canvasId && documentName ? { burrow, slug, canvasId, documentName } : null),
    [burrow, slug, canvasId, documentName],
  );
  const { session, snapshot } = useCanvasCollab(target);
  const everyone = useCollaborators(session);

  const meId = bootstrap.data?.me.id ?? null;
  const me = meId ? principals.get(meId) : undefined;
  const user = useMemo(() => (me ? collabUserOf(me) : null), [me]);

  const now = Date.now();
  const timeZone = burrowQuery.data?.burrow.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const provenanceText = useMemo(() => {
    if (!data) return '';
    const p = data.canvas.provenance;
    return formatCanvasProvenance(
      {
        createdBy: principalName(principals, p.createdById),
        requestedBy: p.requestedById ? principalName(principals, p.requestedById) : null,
        editors: p.editorIds.map((id) => principalName(principals, id)),
      },
      data.canvas.updatedAt,
      now,
      timeZone,
    );
  }, [data, principals, now, timeZone]);

  const view = useMemo<CanvasViewValue>(
    () => ({ principals, plan: data?.plan ?? null, provenance: provenanceText }),
    [principals, data?.plan, provenanceText],
  );

  const editable = snapshot.synced && snapshot.scope !== 'readonly' && snapshot.status !== 'denied';

  // The floating "Comment" button follows a non-empty selection while the editor has focus.
  useEffect(() => {
    if (!editor) {
      setSelection(null);
      return;
    }
    const update = () => {
      const grid = gridRef.current;
      const sel = editor.isFocused ? selectionAnchor(editor.state) : null;
      if (!sel || !grid || editor.isDestroyed) {
        setSelection(null);
        return;
      }
      try {
        const at = editor.view.coordsAtPos(sel.to);
        const box = grid.getBoundingClientRect();
        setSelection({ sel, top: at.top - box.top - 38, left: Math.max(0, at.left - box.left - 44) });
      } catch {
        setSelection(null);
      }
    };
    // Editor events can fire while React renders a node view: update on the next frame, not in there.
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(update);
    };
    editor.on('selectionUpdate', schedule);
    editor.on('focus', schedule);
    editor.on('blur', schedule);
    return () => {
      cancelAnimationFrame(frame);
      editor.off('selectionUpdate', schedule);
      editor.off('focus', schedule);
      editor.off('blur', schedule);
    };
  }, [editor]);

  const openDraft = useCallback(() => {
    const sel = editor && !editor.isDestroyed ? selectionAnchor(editor.state) : null;
    if (!sel) return false;
    setDraft(sel);
    setSelection(null);
    return true;
  }, [editor]);
  const closeDraft = useCallback(() => setDraft(null), []);

  if (error && !data) {
    return (
      <div className={styles.screen} data-screen="canvas">
        <ErrorNote
          message="Couldn’t load this canvas. Try again in a moment."
          onRetry={() => void refetch()}
          className={styles.status}
        />
      </div>
    );
  }
  if (!data) {
    return (
      <div className={styles.screen} data-screen="canvas">
        <div className={styles.status} aria-busy="true">
          <Skeleton width="40%" height={20} />
          <SkeletonRows count={4} lines={2} />
        </div>
      </div>
    );
  }

  const { canvas, comments } = data;
  // "2 here": everyone in the document's awareness once connected; the server's count until then.
  const presentIds = snapshot.synced && everyone.length ? presentPrincipalIds(everyone) : data.presentIds;
  const readOnly = snapshot.synced && snapshot.scope === 'readonly';

  async function handleShare() {
    // Burrow-less with `?burrow=` (AP-365), so it opens this burrow for someone in several; managed: a link that names
    // this Whombat too (MR-45), so it opens here even with several.
    const path = withBurrow(`/canvases/${encodeURIComponent(slug)}`, burrow);
    const url = managed
      ? applianceLink(window.location.origin, managed.applianceId, path)
      : `${window.location.origin}${path}`;
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // Clipboard access can be denied (permissions, non-secure context); the toast still confirms intent.
    }
    toast.show('Canvas link copied.');
  }

  return (
    <div className={styles.screen} data-screen="canvas">
      <header className={styles.header}>
        {data.conversationTitle && <span className={styles.crumb}>{data.conversationTitle} /</span>}
        <span className={styles.title}>{canvas.title}</span>
        {(readOnly || snapshot.status === 'offline' || snapshot.status === 'denied') && (
          <span className={styles.connection} role="status">
            {snapshot.status === 'denied'
              ? 'You can’t edit this canvas any more'
              : snapshot.status === 'offline'
                ? 'Reconnecting…'
                : 'Read only'}
          </span>
        )}
        <span className={styles.presence}>
          <span className={styles.presenceStack}>
            {presentIds.map((id) => {
              const p = principals.get(id);
              return (
                <span
                  key={id}
                  className={styles.presenceAvatar}
                  data-kind={p?.kind}
                  style={p?.kind === 'agent' && p.face ? { borderColor: `var(--face-${p.face})` } : undefined}
                >
                  <PrincipalAvatar principal={p} size={24} label={p?.name} />
                </span>
              );
            })}
          </span>
          {formatPresence(presentIds.length)}
        </span>
        <Button variant="secondary" size="md" onClick={handleShare}>
          Share
        </Button>
      </header>

      <div className={styles.body}>
        <div className={styles.grid} ref={gridRef}>
          <article className={styles.article} aria-busy={!snapshot.synced}>
            {session && snapshot.synced ? (
              <CanvasViewContext.Provider value={view}>
                <CanvasEditor
                  session={session}
                  user={user}
                  editable={editable}
                  principals={principals}
                  onEditor={setEditor}
                  onCommentShortcut={openDraft}
                />
              </CanvasViewContext.Provider>
            ) : (
              <div className={styles.titleBlock}>
                <h1 className={styles.h1}>{canvasHeading(canvas.title)}</h1>
                <span className={styles.provenance}>{provenanceText}</span>
                {snapshot.status === 'denied' && (
                  <p className={styles.note}>You don’t have access to this canvas any more.</p>
                )}
              </div>
            )}
          </article>

          <CommentsColumn
            burrow={burrow}
            slug={slug}
            threads={comments}
            principals={principals}
            timeZone={timeZone}
            editor={editor}
            wide={wide}
            draft={draft}
            onDraftDone={closeDraft}
            layoutKey={`${everyone.length}|${snapshot.synced}`}
          />

          {selection && !draft && (
            <button
              type="button"
              className={styles.commentButton}
              style={{ top: selection.top, left: selection.left }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={openDraft}
              aria-keyshortcuts="Control+Alt+M Meta+Alt+M"
            >
              <Icon name="thread" size={14} />
              Comment
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
