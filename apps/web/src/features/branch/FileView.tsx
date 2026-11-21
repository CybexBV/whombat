import { ApiError } from '@whombat/client';
import { usePullRequestFile } from '@whombat/client/react';
import {
  type FileChange,
  fileViewLines,
  PR_FILE_SHOWN_TEXT,
  type PrFileLine,
  type PrFileView,
} from '@whombat/core';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { type MouseEvent, type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { LoadErrorNote } from '../../app/runtime';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { EmptyNote, SkeletonRows } from '../../components/ListState';
import { renderToken, useHighlighted } from '../messaging/CodeBlock';
import styles from './FileView.module.css';
import { changeStarts, gutterDigits, languageOf, neighbours, splitTokenLines } from './fileView';

export interface FileViewProps {
  burrow: string;
  number: number;
  /** The room's repository (`?repo=`), as `prs.get` was asked. */
  repo?: string;
  path: string;
  /** Files changed, for the files before and after this one. */
  files: readonly FileChange[];
  /** The PR's head: a new push reads the file again. */
  headSha: string;
  /** Files changed (`?tab=files`). */
  backHref: string;
  /** Another file's view (`?tab=files&file=`). */
  fileHref: (path: string) => string;
  onNavigate: (href: string) => void;
}

const NO_LINES: PrFileLine[] = [];

/** Lines per block; blocks off screen skip layout and paint (`content-visibility`), so long files scroll smoothly. */
const BLOCK = 400;

/**
 * The file view (AP-664, contracts CT-241): a pull request's file whole, view only, in the code surface — old and new
 * line numbers, removed lines in red and added lines in green in place, highlighted by the file's language. Opened from
 * Files changed; Back returns there, the arrows step through the changes and to the files before and after.
 */
export function FileView({
  burrow,
  number,
  repo,
  path,
  files,
  headSha,
  backHref,
  fileHref,
  onNavigate,
}: FileViewProps) {
  const query = usePullRequestFile({
    params: { burrow, number },
    query: { ...(repo ? { repo } : {}), path },
  });
  const { refetch } = query;
  const read = useRef(headSha);
  useEffect(() => {
    if (read.current === headSha) return;
    read.current = headSha;
    void refetch();
  }, [headSha, refetch]);

  const counts = files.find((f) => f.path === path);
  const { previous, next } = neighbours(files, path);
  const view = query.data;
  const follow = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(href);
  };

  const lines = view?.shown === 'text' ? view.lines : NO_LINES;
  const starts = useMemo(() => changeStarts(lines), [lines]);
  const editorRef = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState(-1);
  const goTo = (index: number) => {
    const at = starts[index];
    if (at === undefined) return;
    setCurrent(index);
    editorRef.current
      ?.querySelector(`[data-line="${at}"]`)
      ?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  };
  // Opens at the first change when it is below the first screen.
  const first = starts[0];
  useEffect(() => {
    if (first === undefined || first < 20) return;
    editorRef.current?.querySelector(`[data-line="${first}"]`)?.scrollIntoView?.({ block: 'center' });
    setCurrent(0);
  }, [first]);

  let body: ReactNode;
  if (view) body = <FileBody view={view} editorRef={editorRef} />;
  else if (query.error instanceof ApiError && query.error.status === 404)
    body = <EmptyNote>This pull request doesn’t change {path}.</EmptyNote>;
  else if (query.error)
    body = (
      <LoadErrorNote
        error={query.error}
        message="Couldn’t open this file. Try again in a moment."
        onRetry={() => void refetch()}
      />
    );
  else body = <SkeletonRows count={6} lines={1} className={styles.loading} />;

  const add = view?.add ?? counts?.add;
  const del = view?.del ?? counts?.del;
  return (
    <div className={styles.view}>
      <div className={styles.bar}>
        <a href={backHref} className={styles.back} onClick={follow(backHref)}>
          <Icon icon={ArrowLeft} size={16} />
          Files changed
        </a>
        <span className={styles.path} title={path}>
          {path}
        </span>
        {add !== undefined && del !== undefined && (
          <span className={styles.stat}>
            <span className={styles.add}>+{add}</span> <span className={styles.del}>−{del}</span>
          </span>
        )}
        {view && view.status !== 'modified' && (
          <span className={styles.chip}>{view.status === 'added' ? 'New file' : 'Deleted'}</span>
        )}
        <span className={styles.chip}>View only</span>
        <span className={styles.nav}>
          {starts.length > 0 && (
            <span className={styles.changes}>
              <span className={styles.changeCount} aria-live="polite">
                {current >= 0
                  ? `Change ${current + 1} of ${starts.length}`
                  : `${starts.length} ${starts.length === 1 ? 'change' : 'changes'}`}
              </span>
              <button
                type="button"
                className={styles.step}
                aria-label="Previous change"
                title="Previous change"
                disabled={current <= 0}
                onClick={() => goTo(current - 1)}
              >
                <Icon icon={ChevronUp} size={16} />
              </button>
              <button
                type="button"
                className={styles.step}
                aria-label="Next change"
                title="Next change"
                disabled={current >= starts.length - 1}
                onClick={() => goTo(current + 1)}
              >
                <Icon icon={ChevronDown} size={16} />
              </button>
            </span>
          )}
          <span className={styles.files}>
            <FileStep href={previous ? fileHref(previous) : null} label="Previous file" onFollow={follow}>
              <Icon icon={ChevronLeft} size={16} />
            </FileStep>
            <FileStep href={next ? fileHref(next) : null} label="Next file" onFollow={follow}>
              <Icon icon={ChevronRight} size={16} />
            </FileStep>
          </span>
        </span>
      </div>
      {body}
    </div>
  );
}

function FileStep({
  href,
  label,
  onFollow,
  children,
}: {
  href: string | null;
  label: string;
  onFollow: (href: string) => (event: MouseEvent<HTMLAnchorElement>) => void;
  children: ReactNode;
}) {
  if (!href)
    return (
      <span className={cx(styles.step, styles.stepOff)} aria-hidden="true">
        {children}
      </span>
    );
  return (
    <a href={href} className={styles.step} aria-label={label} title={label} onClick={onFollow(href)}>
      {children}
    </a>
  );
}

const MARKS: Record<PrFileLine['kind'], string> = { context: ' ', add: '+', del: '−' };
const KIND_LABEL: Record<PrFileLine['kind'], string | undefined> = {
  context: undefined,
  add: 'Added',
  del: 'Removed',
};

type EditorRef = RefObject<HTMLElement | null>;

function FileBody({ view, editorRef }: { view: PrFileView; editorRef: EditorRef }) {
  if (view.shown !== 'text') return <EmptyNote>{PR_FILE_SHOWN_TEXT[view.shown]}</EmptyNote>;
  if (view.lines.length === 0) return <EmptyNote>This file is empty.</EmptyNote>;
  return <FileLines view={view} editorRef={editorRef} />;
}

/**
 * Two texts in the file view's lines (Settings → Skills' Compare with original, app all-skills.md AP-2311): the same
 * code surface, old and new line numbers, removed lines red and added lines green; `same` when nothing differs.
 */
export function TextDiff({
  path,
  base,
  head,
  same,
}: {
  path: string;
  base: string;
  head: string;
  same: string;
}) {
  const editorRef = useRef<HTMLElement>(null);
  const view = useMemo<PrFileView>(() => {
    const lines = fileViewLines(base, head);
    return {
      path,
      status: 'modified',
      shown: 'text',
      add: lines.filter((l) => l.kind === 'add').length,
      del: lines.filter((l) => l.kind === 'del').length,
      lines,
      baseSha: null,
      headSha: '',
    };
  }, [path, base, head]);
  if (view.add === 0 && view.del === 0) return <EmptyNote>{same}</EmptyNote>;
  return <FileLines view={view} editorRef={editorRef} />;
}

function FileLines({ view, editorRef }: { view: PrFileView; editorRef: EditorRef }) {
  const { lines, path } = view;
  const text = useMemo(() => lines.map((l) => l.text).join('\n'), [lines]);
  const tree = useHighlighted(languageOf(path), text);
  const rendered = useMemo(() => (tree ? splitTokenLines(tree, lines.length) : null), [tree, lines.length]);
  const digits = gutterDigits(lines);

  const blocks: PrFileLine[][] = [];
  for (let i = 0; i < lines.length; i += BLOCK) blocks.push(lines.slice(i, i + BLOCK));

  return (
    <section
      ref={editorRef}
      className={styles.editor}
      aria-label={`${path}, view only`}
      style={{ ['--gutter' as string]: `${digits}ch` }}
    >
      <div className={styles.code}>
        {blocks.map((block, b) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are fixed slices of the file
            key={b}
            className={styles.block}
            style={{ containIntrinsicSize: `auto ${block.length * 21}px` }}
          >
            {block.map((line, j) => {
              const i = b * BLOCK + j;
              const label = KIND_LABEL[line.kind];
              // Changed lines are all green or red (as the review card's diff); context keeps its syntax colours.
              const tokens = line.kind === 'context' ? rendered?.[i] : undefined;
              return (
                <div
                  key={i}
                  data-line={i}
                  className={cx(
                    styles.line,
                    line.kind === 'add' && styles.lineAdd,
                    line.kind === 'del' && styles.lineDel,
                  )}
                >
                  <span className={styles.num} aria-hidden="true">
                    {line.old ?? ''}
                  </span>
                  <span className={styles.num} aria-hidden="true">
                    {line.new ?? ''}
                  </span>
                  <span className={styles.mark} aria-hidden="true">
                    {MARKS[line.kind]}
                  </span>
                  <span className={styles.text}>
                    {label && <span className={styles.srOnly}>{label}: </span>}
                    {tokens ? renderToken(tokens, i) : line.text}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}
