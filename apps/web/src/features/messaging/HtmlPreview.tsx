import * as Dialog from '@radix-ui/react-dialog';
import { htmlTitle, withPageStyle } from '@whombat/core';
import { isThemeName, pageThemeCss } from '@whombat/tokens';
import { Code2, Download, Globe, Maximize2, Minimize2, Workflow } from 'lucide-react';
import mermaidUrl from 'mermaid/dist/mermaid.min.js?url';
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { saveBlob } from '../../lib/saveBlob';
import { CodeBlock } from './CodeBlock';
import styles from './HtmlPreview.module.css';
import {
  type DiagramTheme,
  FRAME_INITIAL_HEIGHT,
  FRAME_MAX_HEIGHT,
  FRAME_MIN_HEIGHT,
  frameHeight,
  frameReady,
  type HtmlMessage,
  htmlFileName,
  mermaidDocument,
  SANDBOX_FLAGS,
  SANDBOX_FRAME_URL,
  type ThemeMessage,
} from './sandbox';

/*
 * Previews in a sandboxed frame (AP-320, AP-323): an agent's HTML page (a fenced `html` block, a raw page, an `.html`
 * attachment) and Mermaid diagrams. The page lives in `/sandbox/html-frame.html` under `sandbox="allow-scripts"` and
 * its own CSP (sandbox.ts); this side only posts the HTML to that frame and reads its height.
 */

/**
 * One sandboxed frame showing `html`. Its height follows the page (clamped) unless `fill` (full screen). The page goes
 * to the frame whenever the frame page says it's ready: a frame React moves in the document reloads, and asks again.
 * With `pageCss` the page gets the app's theme as its first style, and a new theme reaches the running page.
 */
export function SandboxFrame({
  html,
  title,
  pageCss,
  fill = false,
  minHeight = FRAME_MIN_HEIGHT,
  maxHeight = FRAME_MAX_HEIGHT,
  className,
}: {
  html: string;
  /** The frame's accessible name. */
  title: string;
  /** The theme sheet of an agent's page (`pageThemeCss`); none for a document the app wrote itself (a diagram). */
  pageCss?: string;
  fill?: boolean;
  minHeight?: number;
  maxHeight?: number;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(Math.min(maxHeight, Math.max(minHeight, FRAME_INITIAL_HEIGHT)));
  // The newest theme, for a page that (re)starts later; the effect below sends a change to the running page.
  const css = useRef(pageCss);
  css.current = pageCss;

  // A layout effect: listening before the frame (inserted in this commit) can run its script and say it's ready.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only this frame's window: a readiness or a height, nothing else the page may post.
      const win = ref.current?.contentWindow;
      if (!win || event.source !== win) return;
      if (frameReady(event.data)) {
        const page = css.current === undefined ? html : withPageStyle(html, css.current);
        const message: HtmlMessage = { type: 'whombat.html', html: page };
        win.postMessage(message, '*');
        return;
      }
      const h = frameHeight(event.data, minHeight, maxHeight);
      if (h !== null) setHeight(h);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [html, minHeight, maxHeight]);

  useEffect(() => {
    const win = ref.current?.contentWindow;
    if (!win || pageCss === undefined) return;
    const message: ThemeMessage = { type: 'whombat.theme', css: pageCss };
    win.postMessage(message, '*');
  }, [pageCss]);

  return (
    <iframe
      ref={ref}
      className={cx(styles.frame, fill && styles.fill, className)}
      src={SANDBOX_FRAME_URL}
      sandbox={SANDBOX_FLAGS}
      title={title}
      referrerPolicy="no-referrer"
      loading={fill ? undefined : 'lazy'}
      style={fill ? undefined : { height }}
    />
  );
}

function saveHtml(html: string, name: string) {
  // A download, never a navigation: a neutral type, an `<a download>` click (like saveResource).
  saveBlob(new Blob([html], { type: 'application/octet-stream' }), name);
}

/** An action's name: hidden (kept for assistive technology) when the card is narrow. */
export function ActionLabel({ children }: { children: ReactNode }) {
  return <span className={styles.actionLabel}>{children}</span>;
}

function ActionButton({
  icon,
  label,
  onClick,
  pressed,
}: {
  icon: typeof Globe;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button type="button" className={styles.action} onClick={onClick} aria-pressed={pressed}>
      <Icon icon={icon} size={14} />
      <span className={styles.actionLabel}>{label}</span>
    </button>
  );
}

interface PreviewProps {
  kind: 'html' | 'mermaid';
  /** The page's title, “HTML page” or “Diagram”. */
  title: string;
  /** The line under the title (“HTML page · 12 KB”). */
  meta?: string;
  /** What “View source” shows, and its language. */
  source: string;
  lang: string;
  /** The document the frame shows. */
  frameHtml: string;
  /** The Download control: an attachment's own (a session download), or null for none. */
  download?: ReactNode;
  /** Download the source as a file (code blocks): its file name. */
  downloadName?: string;
  minHeight?: number;
  /** The theme sheet for an agent's page. */
  pageCss?: string;
}

/**
 * The preview card: a header with the title and “Open full screen”, “View source” and “Download”, then the live page
 * (or its source).
 */
function PreviewCard({
  kind,
  title,
  meta,
  source,
  lang,
  frameHtml,
  download,
  downloadName,
  minHeight,
  pageCss,
}: PreviewProps) {
  const [showSource, setShowSource] = useState(false);
  const [full, setFull] = useState(false);
  const frameTitle = kind === 'html' ? `Page preview: ${title}` : `Diagram: ${title}`;
  const downloadControl =
    download ??
    (downloadName ? (
      <ActionButton icon={Download} label="Download" onClick={() => saveHtml(source, downloadName)} />
    ) : null);
  return (
    <figure className={styles.card} aria-label={title}>
      <figcaption className={styles.head}>
        <Icon icon={kind === 'html' ? Globe : Workflow} size={16} className={styles.headIcon} />
        <span className={styles.titles}>
          <span className={styles.title} title={title}>
            {title}
          </span>
          {meta && <span className={styles.meta}>{meta}</span>}
        </span>
        <span className={styles.actions}>
          <ActionButton icon={Maximize2} label="Open full screen" onClick={() => setFull(true)} />
          <ActionButton
            icon={Code2}
            label="View source"
            pressed={showSource}
            onClick={() => setShowSource((s) => !s)}
          />
          {downloadControl}
        </span>
      </figcaption>
      {showSource ? (
        <CodeBlock lang={lang} text={source} className={styles.source} />
      ) : (
        <SandboxFrame html={frameHtml} title={frameTitle} minHeight={minHeight} pageCss={pageCss} />
      )}
      <Dialog.Root open={full} onOpenChange={setFull}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.overlay} />
          <Dialog.Content className={styles.full} aria-describedby={undefined}>
            <div className={styles.fullBar}>
              <Icon icon={kind === 'html' ? Globe : Workflow} size={16} className={styles.headIcon} />
              <Dialog.Title className={styles.fullTitle}>{title}</Dialog.Title>
              <span className={styles.actions}>
                {downloadControl}
                <Dialog.Close asChild>
                  <button type="button" className={styles.action}>
                    <Icon icon={Minimize2} size={14} />
                    <span className={styles.actionLabel}>Close full screen</span>
                  </button>
                </Dialog.Close>
              </span>
            </div>
            {full && <SandboxFrame html={frameHtml} title={frameTitle} pageCss={pageCss} fill />}
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </figure>
  );
}

/** An HTML page (a fenced block, a raw page or an attachment) as a live preview. */
export function HtmlPreviewCard({
  html,
  meta,
  download,
  fallbackTitle,
}: {
  html: string;
  meta?: string;
  /** An attachment's download; without one, Download saves the page from the message. */
  download?: ReactNode;
  /** Without a `<title>`: the attachment's name, else “HTML page”. */
  fallbackTitle?: string;
}) {
  const title = useMemo(() => htmlTitle(html), [html]);
  const pageCss = usePageCss();
  return (
    <PreviewCard
      kind="html"
      title={title ?? fallbackTitle ?? 'HTML page'}
      meta={meta ?? (title ? 'HTML page' : undefined)}
      source={html}
      lang="html"
      frameHtml={html}
      pageCss={pageCss}
      download={download}
      downloadName={download ? undefined : htmlFileName(title)}
    />
  );
}

const THEME_VARS = {
  background: '--sf',
  node: '--sf2',
  text: '--ink',
  line: '--mut',
  accent: '--brand',
  secondary: '--bubble',
  font: '--font-sans',
} as const;

const readTheme = () => document.documentElement.dataset.theme ?? 'light';

/** The document's theme (`data-theme` on `<html>`), following changes. */
function useDocumentTheme(): string {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

function diagramTheme(theme: string): DiagramTheme {
  const style = getComputedStyle(document.documentElement);
  const value = (name: string) => style.getPropertyValue(name).trim();
  return {
    dark: theme === 'dark',
    ...(Object.fromEntries(Object.entries(THEME_VARS).map(([k, v]) => [k, value(v)])) as Omit<
      DiagramTheme,
      'dark'
    >),
  };
}

/** A Mermaid diagram (a fenced `mermaid` block or an `.mmd` attachment), drawn in the sandbox (AP-323). */
export function MermaidPreview({
  source,
  title = 'Diagram',
  meta,
  download,
}: {
  source: string;
  title?: string;
  meta?: string;
  download?: ReactNode;
}) {
  const theme = useDocumentTheme();
  const frameHtml = useMermaidDocument(source, theme);
  return (
    <PreviewCard
      // A new theme is a new drawing.
      key={theme}
      kind="mermaid"
      title={title}
      meta={meta}
      source={source}
      lang="mermaid"
      frameHtml={frameHtml}
      download={download}
      minHeight={80}
    />
  );
}

/** The theme sheet an agent's page gets in the app's current theme (docs/decisions/visual-replies.md). */
function usePageCss(): string {
  const theme = useDocumentTheme();
  return useMemo(() => pageThemeCss(isThemeName(theme) ? theme : 'light'), [theme]);
}

/** A diagram's page in the app's colours. */
function useMermaidDocument(source: string, theme: string): string {
  return useMemo(
    () => mermaidDocument(source, new URL(mermaidUrl, window.location.href).href, diagramTheme(theme)),
    [source, theme],
  );
}

/** An HTML page filling its container (Files' viewer): the same sandbox and theme as in a message. */
export function PageFrame({ html, title }: { html: string; title: string }) {
  return <SandboxFrame html={html} title={`Page preview: ${title}`} pageCss={usePageCss()} fill />;
}

/** A Mermaid diagram filling its container (Files' viewer). */
export function DiagramFrame({ source, title }: { source: string; title: string }) {
  const theme = useDocumentTheme();
  const html = useMermaidDocument(source, theme);
  return <SandboxFrame key={theme} html={html} title={`Diagram: ${title}`} fill />;
}
