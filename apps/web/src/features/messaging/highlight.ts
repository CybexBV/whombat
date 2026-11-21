/**
 * Syntax highlighting for message code blocks (AP-322), loaded lazily (`import('./highlight')`): highlight.js core with
 * a handful of common languages, turned into a small token tree that `CodeBlock` renders as React elements with CSS
 * module classes. No HTML strings, no `style` attributes, no eval: it works under the hosted build's CSP.
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

/** The colour classes a token can take (`codeColors.syntax*` in @whombat/tokens, plus the diff lines). */
export type TokenKind =
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'title'
  | 'type'
  | 'attr'
  | 'tag'
  | 'meta'
  | 'added'
  | 'removed';

export interface Token {
  kind: TokenKind | null;
  children: (string | Token)[];
}

const engine = hljs.newInstance();
for (const [name, grammar] of Object.entries({
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
}))
  engine.registerLanguage(name, grammar);
// Names people write after a fence that the grammars don't list themselves.
engine.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' });
engine.registerAliases(['svg', 'htm', 'xhtml'], { languageName: 'xml' });
engine.registerAliases(['patch'], { languageName: 'diff' });
engine.registerAliases(['mjs', 'cjs', 'jsx'], { languageName: 'javascript' });
engine.registerAliases(['tsx', 'mts', 'cts'], { languageName: 'typescript' });

/** Longest code highlighted, in characters (longer blocks stay plain: fast and predictable). */
export const HIGHLIGHT_MAX = 100_000;

const KINDS: Record<string, TokenKind> = {
  keyword: 'keyword',
  built_in: 'keyword',
  literal: 'number',
  number: 'number',
  symbol: 'number',
  bullet: 'number',
  string: 'string',
  regexp: 'string',
  char: 'string',
  link: 'string',
  comment: 'comment',
  quote: 'comment',
  title: 'title',
  section: 'title',
  type: 'type',
  class: 'type',
  'selector-tag': 'type',
  attr: 'attr',
  attribute: 'attr',
  property: 'attr',
  variable: 'attr',
  params: 'attr',
  'template-variable': 'attr',
  'selector-attr': 'attr',
  'selector-class': 'attr',
  'selector-id': 'attr',
  'selector-pseudo': 'attr',
  name: 'tag',
  tag: 'tag',
  meta: 'meta',
  doctag: 'meta',
  subst: 'meta',
  addition: 'added',
  deletion: 'removed',
};

/** `title.function` → `title`; `meta keyword` → `meta`; `language:css` → none. */
function kindOf(scope: string | undefined): TokenKind | null {
  if (!scope || scope.startsWith('language:')) return null;
  return KINDS[scope.split(/[.\s]/)[0] as string] ?? null;
}

interface DataNode {
  scope?: string;
  children?: (string | DataNode)[];
}

function convert(node: DataNode): Token {
  return {
    kind: kindOf(node.scope),
    children: (node.children ?? []).map((c) => (typeof c === 'string' ? c : convert(c))),
  };
}

/** Whether `lang` (as written after the fence) has a grammar here. */
export function canHighlight(lang: string | null): boolean {
  return !!lang && !!engine.getLanguage(lang.toLowerCase());
}

/** The code as tokens, or null when the language is unknown or the code too long. */
export function highlight(lang: string | null, code: string): Token | null {
  if (!lang || code.length > HIGHLIGHT_MAX || !canHighlight(lang)) return null;
  try {
    const result = engine.highlight(code, { language: lang.toLowerCase(), ignoreIllegals: true });
    // The token tree highlight.js builds before it renders HTML (its default emitter's `root`).
    const root = (result as unknown as { _emitter?: { root?: DataNode } })._emitter?.root;
    return root?.children ? convert(root) : null;
  } catch {
    return null;
  }
}
