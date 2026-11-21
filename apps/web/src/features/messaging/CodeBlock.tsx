import { Check, Copy } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { copyText } from '../../components/CopyButton';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import styles from './CodeBlock.module.css';
import type { Token, TokenKind } from './highlight';

/*
 * A fenced code block in a message (AP-322): the dark code surface with its language and a Copy button above the
 * code, highlighted once the lazy highlighter (`highlight.ts`, its own chunk) has loaded; plain until then, and for
 * languages it doesn't know.
 */

type Highlighter = typeof import('./highlight');
let loading: Promise<Highlighter> | null = null;
function loadHighlighter(): Promise<Highlighter> {
  loading ??= import('./highlight').catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
}

const KIND_CLASS: Record<TokenKind, string | undefined> = {
  keyword: styles.keyword,
  string: styles.string,
  number: styles.number,
  comment: styles.comment,
  title: styles.title,
  type: styles.type,
  attr: styles.attr,
  tag: styles.tag,
  meta: styles.meta,
  added: styles.added,
  removed: styles.removed,
};

/** A highlighted token as React elements with the code block's colour classes. */
export function renderToken(token: Token, key: number | string): ReactNode {
  const children = token.children.map((c, i) => (typeof c === 'string' ? c : renderToken(c, i)));
  return token.kind ? (
    <span key={key} className={KIND_CLASS[token.kind]}>
      {children}
    </span>
  ) : (
    <span key={key}>{children}</span>
  );
}

/** The highlighted tree for `code`, once the highlighter is loaded (null: plain). */
export function useHighlighted(lang: string | null, code: string): Token | null {
  const [tokens, setTokens] = useState<{ lang: string | null; code: string; tree: Token | null } | null>(
    null,
  );
  useEffect(() => {
    if (!lang) return;
    let live = true;
    loadHighlighter()
      .then((h) => live && setTokens({ lang, code, tree: h.highlight(lang, code) }))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lang, code]);
  return tokens && tokens.lang === lang && tokens.code === code ? tokens.tree : null;
}

/** The label above the code: the fence's language as written (`ts`, `html`), else “Code”. */
export function codeLabel(lang: string | null): string {
  return lang?.trim() || 'Code';
}

export function CodeBlock({
  lang,
  text,
  label,
  className,
}: {
  lang: string | null;
  text: string;
  /** Overrides the language label (“HTML source”). */
  label?: string;
  className?: string;
}) {
  const tree = useHighlighted(lang, text);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className={cx(styles.block, className)}>
      <div className={styles.head}>
        <span className={styles.lang}>{label ?? codeLabel(lang)}</span>
        <button
          type="button"
          className={styles.copy}
          onClick={() => void copyText(text).then((ok) => ok && setCopied(true))}
        >
          <Icon icon={copied ? Check : Copy} size={14} />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className={styles.pre}>
        <code>{tree ? renderToken(tree, 'root') : text}</code>
      </pre>
    </div>
  );
}
