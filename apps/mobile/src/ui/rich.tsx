/**
 * Formatted message text on mobile (docs/decisions/rich-messages.md RM-02, contracts CT-149, AP-328): the same
 * `parseMessage` tree the web renders, as nested native text: bold, italic, `code`, links (open in the browser),
 * `@Name` mentions, headings 1–6, lists with task items, quotes, tables (scrolling sideways), code blocks with their
 * language, images and SVG drawings (CT-90, AP-101: `richImages.tsx`), HTML pages in a confined WebView and Mermaid
 * diagrams as their source (`htmlPreview.tsx`). Sizes follow the bubble text (15.5 / 1.45). With `selectable` on iPhone the
 * paragraphs and headings are iOS's own text view (`@bsky.app/react-native-uitextview`): held, a word is selected with
 * its handles and the system's Copy, Select All, Look Up and Share; links still open with a tap (ios-native.md).
 */

import { UITextView } from '@bsky.app/react-native-uitextview';
import { type Block, type Inline, parseMessage, type TableAlign, type TableBlock } from '@whombat/core';
import { type ComponentType, memo, type ReactNode, useEffect, useId, useMemo } from 'react';
import { Platform, Text as RNText, ScrollView, type TextProps, type TextStyle, View } from 'react-native';
import { headingSize } from '../data/richPreview';
import { useMobileT } from '../i18n';
import { useOpenUrl } from '../navigation/hooks';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { CodeBlockView, DiagramPreview, HtmlPreviewCard } from './htmlPreview';
import { Square, SquareCheck } from './icons';
import { MessageImage, SvgDrawing } from './richImages';
import { KeepsSideways } from './sideways';

export interface RichTextProps {
  text: string;
  /** Body text color. */
  color: string;
  /** Mentions and links (brand; the bubble's own color on my dark bubble). */
  accentColor: string;
  /** Inline code background; none on my bubble. */
  codeBackground?: string;
  size?: number;
  lh?: number;
  /** On iPhone its words can be selected and copied in part, as in iOS's own apps. */
  selectable?: boolean;
}

type SelectableTextProps = TextProps & {
  uiTextView?: boolean;
  onSelectionChange?: (event: { nativeEvent: { start: number; end: number } }) => void;
};

/** The paragraphs whose words are selected now: while any is, a tap only deals with the selection (`MessageRow`). */
const selected = new Set<string>();

export function textSelectionShowing(): boolean {
  return selected.size > 0;
}

interface Palette {
  base: TextStyle;
  bold: TextStyle;
  code: TextStyle;
  accent: string;
  /** The bubble text size, for headings. */
  size: number;
  /** Opens a tapped link: the app's screen for a Whombat link, else the browser (AP-709). */
  open: (href: string) => void;
  /** The text inside a paragraph or heading: iOS's text view's own runs when its words can be selected. */
  T: ComponentType<SelectableTextProps>;
  /** What a paragraph or heading adds to be iOS's selectable text view; empty otherwise. */
  select: Pick<SelectableTextProps, 'onSelectionChange'> & { selectable?: true; uiTextView?: true };
  /** What an image without a description and a task without words are called, in the person's language. */
  words: { image: string; task: string };
}

function inlines(nodes: readonly Inline[], p: Palette, key = ''): ReactNode[] {
  return nodes.map((node, i) => inlineNode(node, p, `${key}${i}`));
}

function inlineNode(node: Inline, p: Palette, k: string): ReactNode {
  switch (node.type) {
    case 'text':
      return node.text;
    case 'break':
      return '\n';
    case 'mention':
      return (
        <p.T key={k} style={[p.bold, { color: p.accent }]}>
          {node.text}
        </p.T>
      );
    case 'code':
      return (
        <p.T key={k} style={p.code}>
          {node.text}
        </p.T>
      );
    case 'strong':
      return (
        <p.T key={k} style={p.bold}>
          {inlines(node.children, p, `${k}.`)}
        </p.T>
      );
    case 'em':
      return (
        <p.T key={k} style={{ fontStyle: 'italic' }}>
          {inlines(node.children, p, `${k}.`)}
        </p.T>
      );
    case 'strike':
      return (
        <p.T key={k} style={{ textDecorationLine: 'line-through' }}>
          {inlines(node.children, p, `${k}.`)}
        </p.T>
      );
    case 'link':
      return (
        <p.T
          key={k}
          accessibilityRole="link"
          onPress={() => p.open(node.href)}
          style={{ color: p.accent, textDecorationLine: 'underline' }}
        >
          {inlines(node.children, p, `${k}.`)}
        </p.T>
      );
    case 'image':
      // Inside a run (a link, bold): its description; a paragraph's own images are rows (`paragraphRuns`).
      return node.alt || p.words.image;
  }
}

type Run = { kind: 'text'; nodes: Inline[] } | { kind: 'image'; src: string; alt: string };

/** A paragraph's text split around its own images, which show as rows of their own. */
function paragraphRuns(nodes: readonly Inline[]): Run[] {
  const runs: Run[] = [];
  for (const node of nodes) {
    if (node.type === 'image') runs.push({ kind: 'image', src: node.src, alt: node.alt });
    else {
      const last = runs.at(-1);
      if (last?.kind === 'text') last.nodes.push(node);
      else runs.push({ kind: 'text', nodes: [node] });
    }
  }
  // Line breaks next to an image would only leave empty lines.
  return runs
    .map((r) => (r.kind === 'text' ? { ...r, nodes: trimBreaks(r.nodes) } : r))
    .filter((r) => r.kind === 'image' || r.nodes.length > 0);
}

function trimBreaks(nodes: Inline[]): Inline[] {
  let start = 0;
  let end = nodes.length;
  while (start < end && nodes[start]?.type === 'break') start++;
  while (end > start && nodes[end - 1]?.type === 'break') end--;
  return nodes.slice(start, end);
}

/** A task item's text, for its checkbox's label. */
function taskLabel(item: readonly Block[], task: string): string {
  const first = item[0];
  if (first?.type !== 'paragraph') return task;
  return first.children.map((n) => ('text' in n ? n.text : n.type === 'image' ? n.alt : '')).join('') || task;
}

/** A column's width: its longest cell's text at about 0.55 em a character, plus padding; 72…240 dp. */
function columnWidth(cells: readonly (readonly Inline[])[], size: number): number {
  const longest = Math.max(0, ...cells.map((c) => inlineLength(c)));
  return Math.min(240, Math.max(72, Math.ceil(longest * size * 0.56) + 22));
}

function inlineLength(nodes: readonly Inline[]): number {
  return nodes.reduce(
    (n, node) =>
      n +
      ('children' in node
        ? inlineLength(node.children)
        : 'text' in node
          ? node.text.length
          : node.type === 'image'
            ? node.alt.length
            : 0),
    0,
  );
}

const ALIGN: Record<NonNullable<TableAlign>, TextStyle['textAlign']> = {
  left: 'left',
  center: 'center',
  right: 'right',
};

/** A GitHub table (CT-149): scrolls sideways inside the bubble; header on sf2, rows ruled and tinted in turn. */
function TableView({ block, p }: { block: TableBlock; p: Palette }) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  // Rows are laid out one by one: every cell of a column gets the column's width (from its longest text).
  const widths = block.align.map((_, col) =>
    columnWidth([block.header[col] ?? [], ...block.rows.map((r) => r[col] ?? [])], p.size * 0.9),
  );
  const cell = (content: readonly Inline[], col: number, header: boolean, key: string) => (
    <View
      key={key}
      style={{
        width: widths[col],
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderLeftWidth: col > 0 ? 1 : 0,
        borderLeftColor: theme.colors.line,
        justifyContent: 'center',
      }}
    >
      <RNText
        style={[
          p.base,
          { fontSize: p.size * 0.9, textAlign: ALIGN[block.align[col] ?? 'left'] ?? 'left' },
          header ? p.bold : null,
        ]}
        maxFontSizeMultiplier={1.6}
      >
        {inlines(content, p, key)}
      </RNText>
    </View>
  );
  // A wide table scrolls sideways here, not the message's swipe.
  return (
    <KeepsSideways>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        accessibilityLabel={tMobile('ui.table')}
        style={{ flexGrow: 0, borderRadius: 10, borderWidth: 1, borderColor: theme.colors.line }}
      >
        <View>
          <View style={{ flexDirection: 'row', backgroundColor: theme.colors.sf2 }}>
            {block.header.map((c, col) => cell(c, col, true, `h${col}`))}
          </View>
          {block.rows.map((row, r) => (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
              key={r}
              style={{
                flexDirection: 'row',
                borderTopWidth: 1,
                borderTopColor: theme.colors.line,
                backgroundColor: r % 2 === 1 ? theme.colors.sel : 'transparent',
              }}
            >
              {row.map((c, col) => cell(c, col, false, `r${r}c${col}`))}
            </View>
          ))}
        </View>
      </ScrollView>
    </KeepsSideways>
  );
}

function BlockView({ block, p: palette }: { block: Block; p: Palette }) {
  const theme = useTheme();
  // Its words selected or not, for a tap to know.
  const id = useId();
  useEffect(() => () => void selected.delete(id), [id]);
  const p: Palette = palette.select.uiTextView
    ? {
        ...palette,
        select: {
          ...palette.select,
          onSelectionChange: (e) => {
            if (e.nativeEvent.end > e.nativeEvent.start) selected.add(id);
            else selected.delete(id);
          },
        },
      }
    : palette;
  switch (block.type) {
    case 'paragraph': {
      if (!block.children.some((n) => n.type === 'image'))
        return (
          <p.T style={p.base} maxFontSizeMultiplier={1.6} {...p.select}>
            {inlines(block.children, p)}
          </p.T>
        );
      return (
        <View style={{ gap: 8 }}>
          {paragraphRuns(block.children).map((r, n) =>
            r.kind === 'image' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
              <MessageImage key={n} src={r.src} alt={r.alt} />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional and never reorder
              <p.T key={n} style={p.base} maxFontSizeMultiplier={1.6} {...p.select}>
                {inlines(r.nodes, p)}
              </p.T>
            ),
          )}
        </View>
      );
    }
    case 'heading': {
      const h = headingSize(block.level ?? 1, p.size);
      return (
        <p.T
          accessibilityRole="header"
          style={[p.base, textMetrics({ size: h.size, weight: h.weight, lineHeight: 1.3 })]}
          maxFontSizeMultiplier={1.6}
          {...p.select}
        >
          {inlines(block.children, p)}
        </p.T>
      );
    }
    case 'table':
      return <TableView block={block} p={p} />;
    case 'list':
      return (
        <View style={{ gap: 4 }}>
          {block.items.map((item, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and never reorder
            <View key={n} style={{ flexDirection: 'row', gap: 6 }}>
              {typeof block.checked?.[n] === 'boolean' ? (
                // A task item (CT-149): a read-only checkbox.
                <View
                  accessible
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: block.checked[n] === true, disabled: true }}
                  accessibilityLabel={taskLabel(item, p.words.task)}
                  style={{ paddingTop: 2 }}
                >
                  {block.checked[n] ? (
                    <SquareCheck size={17} color={p.accent} strokeWidth={1.75} />
                  ) : (
                    <Square size={17} color={theme.colors.mut} strokeWidth={1.75} />
                  )}
                </View>
              ) : (
                <RNText style={[p.base, { minWidth: block.ordered ? 18 : 10, opacity: 0.7 }]}>
                  {block.ordered ? `${block.start + n}.` : '•'}
                </RNText>
              )}
              <View style={{ flex: 1, gap: 4 }}>
                {item.map((b, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reorder
                  <BlockView key={j} block={b} p={p} />
                ))}
              </View>
            </View>
          ))}
        </View>
      );
    case 'quote':
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.line2, paddingLeft: 10, gap: 6 }}>
          {block.children.map((b, j) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reorder
            <BlockView key={j} block={b} p={{ ...p, base: { ...p.base, opacity: 0.75 } }} />
          ))}
        </View>
      );
    case 'code': {
      if (block.preview === 'html') return <HtmlPreviewCard html={block.text} />;
      if (block.preview === 'mermaid') return <DiagramPreview source={block.text} />;
      const codeBlock = <CodeBlockView label={block.lang} text={block.text} />;
      return block.lang === 'svg' ? <SvgDrawing text={block.text} codeBlock={codeBlock} /> : codeBlock;
    }
    case 'rule':
      return <View style={{ height: 1, backgroundColor: theme.colors.line }} />;
  }
}

/**
 * Memoised on its props (plain strings, numbers and a flag): a message row that re-renders for its reactions, its
 * thread's work or a busy button doesn't parse and lay out its words again.
 */
export const RichText = memo(function RichText({
  text,
  color,
  accentColor,
  codeBackground,
  size = 15.5,
  lh = 1.45,
  selectable = false,
}: RichTextProps) {
  const { t: tMobile } = useMobileT();
  const blocks = useMemo(() => parseMessage(text), [text]);
  const open = useOpenUrl();
  const base: TextStyle = { ...textMetrics({ size, lineHeight: lh }), color, includeFontPadding: false };
  const p: Palette = {
    base,
    bold: { fontFamily: textMetrics({ size, weight: 600 }).fontFamily },
    code: {
      fontFamily: textMetrics({ size, family: 'mono' }).fontFamily,
      fontSize: Math.round(size * 0.875 * 100) / 100,
      ...(codeBackground ? { backgroundColor: codeBackground } : null),
    },
    accent: accentColor,
    size,
    open,
    words: { image: tMobile('screens2.rich.image'), task: tMobile('screens2.rich.task') },
    ...(selectable && Platform.OS === 'ios'
      ? {
          T: UITextView as ComponentType<SelectableTextProps>,
          select: { selectable: true, uiTextView: true } as const,
        }
      : { T: RNText, select: {} }),
  };
  return (
    <View style={{ gap: 8 }}>
      {blocks.map((b, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are positional and never reorder
        <BlockView key={i} block={b} p={p} />
      ))}
    </View>
  );
});
