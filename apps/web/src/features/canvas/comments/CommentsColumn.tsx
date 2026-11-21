/**
 * The comments column: threads next to the words they are about (≥1200px; stacked below the article
 * otherwise), replies, resolve / reopen, and the box for a new comment on the selected words.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { Editor } from '@tiptap/core';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation } from '@whombat/client/react';
import type { CanvasCommentThread } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { formatClock } from '@whombat/core/text';
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { anchorPosition, anchorRange, blockTop, type SelectionAnchor } from '../editor/anchors';
import { commentFocusKey, type FocusRange } from '../editor/commentFocus';
import { PrincipalAvatar } from '../PrincipalAvatar';
import type { PrincipalLite } from '../principals';
import styles from './CommentsColumn.module.css';
import { layoutThreads, type ThreadBox } from './layout';

const NEW_ID = '__new-comment';

export interface CommentsColumnProps {
  burrow: string;
  slug: string;
  threads: CanvasCommentThread[];
  principals: Map<string, PrincipalLite>;
  timeZone: string;
  editor: Editor | null;
  /** Threads positioned next to their anchors (wide layout) instead of stacked. */
  wide: boolean;
  /** The words a new comment is about (the composer is open), or null. */
  draft: SelectionAnchor | null;
  onDraftDone: () => void;
  /** Bumped by the screen when the article's layout may have moved (resize, content). */
  layoutKey?: unknown;
}

function focusRange(editor: Editor | null, range: FocusRange | null) {
  if (!editor || editor.isDestroyed) return;
  editor.view.dispatch(editor.state.tr.setMeta(commentFocusKey, { range }).setMeta('addToHistory', false));
}

export function CommentsColumn({
  burrow,
  slug,
  threads,
  principals,
  timeZone,
  editor,
  wide,
  draft,
  onDraftDone,
  layoutKey,
}: CommentsColumnProps) {
  const queryClient = useQueryClient();
  const addComment = useApiMutation(api.canvases.addComment);
  const resolveComment = useApiMutation(api.canvases.resolveComment);
  const [reply, setReply] = useState<Record<string, string>>({});
  const [draftText, setDraftText] = useState('');
  const asideRef = useRef<HTMLElement>(null);
  const boxes = useRef(new Map<string, HTMLElement>());
  const [placement, setPlacement] = useState<{ tops: Record<string, number>; height: number }>({
    tops: {},
    height: 0,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.canvases.get({ params: { burrow, slug } }) });

  const relayout = useCallback(() => {
    const aside = asideRef.current;
    if (!wide || !aside) return;
    const view = editor && !editor.isDestroyed ? editor.view : null;
    const measure = (id: string, anchor: CanvasCommentThread['anchor'] | null): ThreadBox => {
      const pos = editor && anchor ? anchorPosition(editor.state, anchor) : null;
      let top: number | null = null;
      try {
        top = view && pos !== null ? blockTop(view, pos, aside) : null;
      } catch {
        top = null;
      }
      return { id, anchorPos: pos, anchorTop: top, height: boxes.current.get(id)?.offsetHeight ?? 0 };
    };
    const items = threads.map((t) => measure(t.id, t.anchor));
    if (draft) items.push({ ...measure(NEW_ID, draft.anchor), anchorPos: draft.from });
    const { placed, height } = layoutThreads(items);
    const tops = Object.fromEntries(placed.map((p) => [p.id, p.top]));
    setPlacement((prev) =>
      prev.height === height &&
      Object.keys(tops).length === Object.keys(prev.tops).length &&
      Object.entries(tops).every(([id, top]) => prev.tops[id] === top)
        ? prev
        : { tops, height },
    );
  }, [wide, editor, threads, draft]);

  // Measure after every render (heights change with replies), when the document changes, and on resizes.
  useLayoutEffect(() => {
    relayout();
  });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `layoutKey` is the screen's "layout moved" signal.
  useEffect(() => {
    relayout();
  }, [layoutKey, relayout]);
  useEffect(() => {
    if (!editor) return;
    // Document changes can land while React renders a node view: measure on the next frame.
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(relayout);
    };
    editor.on('update', schedule);
    return () => {
      cancelAnimationFrame(frame);
      editor.off('update', schedule);
    };
  }, [editor, relayout]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-observe when the set of boxes changes.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => relayout());
    for (const el of boxes.current.values()) ro.observe(el);
    const article = editor && !editor.isDestroyed ? editor.view.dom : null;
    if (article instanceof HTMLElement) ro.observe(article);
    return () => ro.disconnect();
  }, [relayout, editor, threads, draft]);

  useEffect(() => {
    focusRange(editor, draft ? { from: draft.from, to: draft.to } : null);
    setDraftText('');
  }, [editor, draft]);

  const hover = (thread: CanvasCommentThread | null) => {
    if (draft || !editor || editor.isDestroyed) return;
    focusRange(editor, thread ? anchorRange(editor.state, thread.anchor) : null);
  };

  async function submitDraft(e?: FormEvent) {
    e?.preventDefault();
    const text = draftText.trim();
    if (!draft || !text) return;
    const result = await addComment.mutateAsync({
      params: { burrow, slug },
      body: { anchor: draft.anchor, text },
    });
    if (result.status === 'ok') {
      setDraftText('');
      onDraftDone();
      await refresh();
    }
  }

  function draftKeys(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onDraftDone();
      editor?.commands.focus();
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      void submitDraft();
    }
  }

  async function handleReply(threadId: string, e: FormEvent) {
    e.preventDefault();
    const text = (reply[threadId] ?? '').trim();
    if (!text) return;
    const result = await addComment.mutateAsync({
      params: { burrow, slug },
      body: { parentId: threadId, text },
    });
    if (result.status === 'ok') {
      setReply((r) => ({ ...r, [threadId]: '' }));
      await refresh();
    }
  }

  async function handleResolve(commentId: string, resolved: boolean) {
    const result = await resolveComment.mutateAsync({
      params: { burrow, slug, commentId },
      body: { resolved },
    });
    if (result.status === 'ok') await refresh();
  }

  const placed = (id: string) =>
    wide ? { position: 'absolute' as const, top: placement.tops[id] ?? 0, left: 0, right: 0 } : undefined;
  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) boxes.current.set(id, el);
    else boxes.current.delete(id);
  };

  const composer = draft && (
    <form
      key={NEW_ID}
      ref={register(NEW_ID)}
      className={`${styles.thread} ${styles.composer}`}
      style={placed(NEW_ID)}
      onSubmit={submitDraft}
      aria-label="New comment"
    >
      <blockquote className={styles.quote}>{draft.anchor.quote}</blockquote>
      <textarea
        className={styles.draftInput}
        placeholder="Add a comment…"
        aria-label="Comment"
        value={draftText}
        onChange={(e) => setDraftText(e.target.value)}
        onKeyDown={draftKeys}
        rows={3}
        // biome-ignore lint/a11y/noAutofocus: the box opens because the person asked to write a comment.
        autoFocus
      />
      <div className={styles.draftActions}>
        <button type="button" className={styles.textButton} onClick={onDraftDone}>
          Cancel
        </button>
        <button
          type="submit"
          className={styles.primaryButton}
          disabled={!draftText.trim() || addComment.isPending}
        >
          Comment
        </button>
      </div>
    </form>
  );

  return (
    <aside
      ref={asideRef}
      className={`${styles.comments} ${wide ? styles.wide : ''}`}
      style={wide ? { height: placement.height || undefined } : undefined}
      aria-label="Comments"
    >
      {!wide && composer}
      {threads.map((thread) => (
        // biome-ignore lint/a11y/noStaticElementInteractions: hovering only highlights the anchored words.
        <div
          key={thread.id}
          ref={register(thread.id)}
          className={styles.thread}
          style={placed(thread.id)}
          data-resolved={thread.resolved ? 'true' : undefined}
          onMouseEnter={() => hover(thread)}
          onMouseLeave={() => hover(null)}
        >
          {thread.comments.map((comment) => {
            const author = principals.get(comment.authorId);
            return (
              <div key={comment.id} className={styles.comment}>
                <div className={styles.commentHead}>
                  <span className={styles.commentAvatar}>
                    <PrincipalAvatar principal={author} size={24} />
                  </span>
                  <span className={styles.commentName}>{author?.name ?? '…'}</span>
                  <span className={styles.commentTime}>{formatClock(comment.createdAt, timeZone)}</span>
                </div>
                <span className={styles.commentText}>{comment.text}</span>
              </div>
            );
          })}
          <div className={styles.threadActions}>
            <button
              type="button"
              className={styles.textButton}
              onClick={() => handleResolve(thread.id, !thread.resolved)}
            >
              {thread.resolved ? 'Reopen' : 'Resolve'}
            </button>
          </div>
          <form className={styles.replyForm} onSubmit={(e) => handleReply(thread.id, e)}>
            <input
              className={styles.replyInput}
              placeholder="Reply…"
              value={reply[thread.id] ?? ''}
              onChange={(e) => setReply((r) => ({ ...r, [thread.id]: e.target.value }))}
              aria-label="Reply to this thread"
            />
          </form>
        </div>
      ))}
      {wide && composer}
    </aside>
  );
}
