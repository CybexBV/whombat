import { svgIntrinsicSize } from '@whombat/client';
import {
  type Block,
  type Inline,
  type ListBlock,
  parseMessage,
  svgImageSrc,
  type TableAlign,
  type TableBlock,
} from '@whombat/core';
import { Image as ImageIcon } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { cx } from '../../components/cx';
import { CodeBlock } from './CodeBlock';
import { HtmlPreviewCard, MermaidPreview } from './HtmlPreview';
import { ImageLightbox, LightboxImage } from './MessageAttachments';
import styles from './RichText.module.css';

/*
 * Message text as the light Markdown people and agents write (`parseMessage`, docs/decisions/rich-messages.md,
 * contracts CT-149): paragraphs, headings 1–6, lists with task items, nested quotes, tables, code with its language,
 * Copy and highlighting, bold/italic/code/links, `@Name` in brand/600, images and SVG drawings (CT-90, AP-101), HTML
 * pages and Mermaid diagrams in the sandboxed preview (AP-320, AP-323). Nodes are positional and never reorder, so
 * they are keyed by index.
 */

interface Picture {
  src: string;
  alt: string;
}

interface Ctx {
  /** Open a picture in the lightbox. */
  open: (picture: Picture) => void;
  /** `http(s)` images load (legacy self-hosted); the hosted build's CSP allows only its own, `blob:` and `data:`. */
  remoteImages: boolean;
  /** Inside a link: an image is the link's content, not a button of its own. */
  inLink?: boolean;
}

function inlines(nodes: readonly Inline[], ctx: Ctx): ReactNode[] {
  return nodes.map((node, i) => inlineNode(node, i, ctx));
}

function hostOf(src: string): string {
  try {
    return new URL(src).host;
  } catch {
    return src;
  }
}

/** A remote image the page can't load: a link to it, with its alt text and host (AP-101). */
function ImageChip({ src, alt, inLink }: Picture & { inLink?: boolean }) {
  const host = hostOf(src);
  const content = (
    <>
      <ImageIcon size={14} aria-hidden="true" className={styles.imageChipIcon} />
      <span className={styles.imageChipAlt}>{alt || 'Image'}</span>
      <span className={styles.imageChipHost}>{host}</span>
    </>
  );
  if (inLink) return <span className={styles.imageChip}>{content}</span>;
  return (
    <a
      className={styles.imageChip}
      href={src}
      target="_blank"
      rel="noopener noreferrer nofollow"
      title={src}
      aria-label={`${alt || 'Image'}, on ${host}`}
    >
      {content}
    </a>
  );
}

function InlineImage({ src, alt, ctx }: Picture & { ctx: Ctx }) {
  const [broken, setBroken] = useState(false);
  const remote = !src.startsWith('data:');
  if (broken || (remote && !ctx.remoteImages)) {
    return remote ? <ImageChip src={src} alt={alt} inLink={ctx.inLink} /> : <span>{alt}</span>;
  }
  const img = (
    <img
      className={styles.image}
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
    />
  );
  if (ctx.inLink) return img;
  return (
    <button
      type="button"
      className={styles.imageButton}
      aria-label={alt ? `Open image: ${alt}` : 'Open image'}
      onClick={() => ctx.open({ src, alt })}
    >
      {img}
    </button>
  );
}

function inlineNode(node: Inline, i: number, ctx: Ctx): ReactNode {
  const kids = (children: readonly Inline[]) => inlines(children, ctx);
  switch (node.type) {
    case 'text':
      return node.text;
    case 'break':
      return <br key={i} />;
    case 'mention':
      return (
        <span key={i} className={styles.mention}>
          {node.text}
        </span>
      );
    case 'code':
      return (
        <code key={i} className={styles.code}>
          {node.text}
        </code>
      );
    case 'strong':
      return (
        <strong key={i} className={styles.strong}>
          {kids(node.children)}
        </strong>
      );
    case 'em':
      return <em key={i}>{kids(node.children)}</em>;
    case 'strike':
      return <s key={i}>{kids(node.children)}</s>;
    case 'link':
      return (
        <a key={i} className={styles.link} href={node.href} target="_blank" rel="noopener noreferrer">
          {inlines(node.children, { ...ctx, inLink: true })}
        </a>
      );
    case 'image':
      return <InlineImage key={i} src={node.src} alt={node.alt} ctx={ctx} />;
  }
}

const SVG_WIDTH = 360;

/** An SVG an agent drew (CT-90): the picture, with its code a toggle away (AP-101). */
function SvgBlock({ text, src, ctx }: { text: string; src: string; ctx: Ctx }) {
  const [code, setCode] = useState(false);
  // An SVG with only a viewBox has no size of its own as an image: its declared width, else 360px.
  const width = Math.min(svgIntrinsicSize(text)?.width ?? SVG_WIDTH, SVG_WIDTH);
  return (
    <figure className={styles.svg}>
      <button
        type="button"
        className={styles.imageButton}
        aria-label="Open drawing"
        onClick={() => ctx.open({ src, alt: 'Drawing' })}
      >
        <img className={styles.image} src={src} alt="Drawing" style={{ width }} />
      </button>
      <figcaption>
        <button
          type="button"
          className={styles.codeToggle}
          aria-expanded={code}
          onClick={() => setCode((c) => !c)}
        >
          {code ? 'Hide code' : 'View code'}
        </button>
      </figcaption>
      {code && <CodeBlock lang="svg" text={text} className={styles.svgCode} />}
    </figure>
  );
}

function blocks(list: readonly Block[], ctx: Ctx, tight = false): ReactNode[] {
  return list.map((block, i) => blockNode(block, i, ctx, tight));
}

/** Headings sit under the page's own (the screen title, the conversation): `#` is an `<h3>`, `####`… an `<h6>`. */
const HEADING_TAGS = ['h3', 'h4', 'h5', 'h6', 'h6', 'h6'] as const;
const HEADING_CLASS = [styles.h1, styles.h2, styles.h3, styles.h4, styles.h5, styles.h6];

function listNode(block: ListBlock, i: number, ctx: Ctx): ReactNode {
  const tasks = block.checked;
  const items = block.items.map((item, n) => {
    const checked = tasks?.[n];
    if (checked === undefined || checked === null)
      // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and never reorder
      return <li key={n}>{blocks(item, ctx, true)}</li>;
    // A task item (CT-149): a read-only checkbox labelled by the item's text, then any nested lists.
    const [first, ...rest] = item;
    return (
      // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and never reorder
      <li key={n} className={styles.task}>
        <label className={styles.taskLabel}>
          <input type="checkbox" className={styles.checkbox} checked={checked} disabled readOnly />
          <span>{first ? blocks([first], ctx, true) : null}</span>
        </label>
        {rest.length > 0 && blocks(rest, ctx)}
      </li>
    );
  });
  const className = cx(styles.list, tasks && styles.taskList);
  return block.ordered ? (
    <ol key={i} className={className} start={block.start === 1 ? undefined : block.start}>
      {items}
    </ol>
  ) : (
    <ul key={i} className={className}>
      {items}
    </ul>
  );
}

const ALIGN_CLASS: Record<NonNullable<TableAlign>, string | undefined> = {
  left: styles.alignLeft,
  center: styles.alignCenter,
  right: styles.alignRight,
};

/** A GitHub table (CT-149): scrolls sideways inside the message when it is wider than the column. */
function tableNode(block: TableBlock, i: number, ctx: Ctx): ReactNode {
  const align = (col: number) => {
    const a = block.align[col];
    return a ? ALIGN_CLASS[a] : undefined;
  };
  return (
    // A focusable scroll area, so the keyboard can scroll a wide table too.
    // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrollable region must be reachable by keyboard
    <section key={i} className={styles.tableWrap} tabIndex={0} aria-label="Table">
      <table className={styles.table}>
        <thead>
          <tr>
            {block.header.map((cell, c) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional and never reorder
              <th key={c} scope="col" className={align(c)}>
                {inlines(cell, ctx)}
              </th>
            ))}
          </tr>
        </thead>
        {block.rows.length > 0 && (
          <tbody>
            {block.rows.map((row, r) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows are positional and never reorder
              <tr key={r}>
                {row.map((cell, c) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: cells are positional and never reorder
                  <td key={c} className={align(c)}>
                    {inlines(cell, ctx)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        )}
      </table>
    </section>
  );
}

function blockNode(block: Block, i: number, ctx: Ctx, tight: boolean): ReactNode {
  const kids = (children: readonly Inline[]) => inlines(children, ctx);
  switch (block.type) {
    case 'paragraph':
      // A list item's own text sits in the <li> without a paragraph box.
      return tight && i === 0 ? kids(block.children) : <p key={i}>{kids(block.children)}</p>;
    case 'heading': {
      const level = Math.min(6, Math.max(1, block.level ?? 1)) - 1;
      const Tag = HEADING_TAGS[level] ?? 'h6';
      return (
        <Tag key={i} className={cx(styles.heading, HEADING_CLASS[level])}>
          {kids(block.children)}
        </Tag>
      );
    }
    case 'list':
      return listNode(block, i, ctx);
    case 'quote':
      return (
        <blockquote key={i} className={styles.quote}>
          {blocks(block.children, ctx)}
        </blockquote>
      );
    case 'table':
      return tableNode(block, i, ctx);
    case 'code': {
      if (block.preview === 'html') return <HtmlPreviewCard key={i} html={block.text} />;
      if (block.preview === 'mermaid') return <MermaidPreview key={i} source={block.text} />;
      const src = block.lang === 'svg' ? svgImageSrc(block.text) : null;
      if (src) return <SvgBlock key={i} text={block.text} src={src} ctx={ctx} />;
      return <CodeBlock key={i} lang={block.lang} text={block.text} />;
    }
    case 'rule':
      return <hr key={i} className={styles.rule} />;
  }
}

/**
 * Message body (README "Message row": 16/1.55 ink2, `@Name` brand/600) with formatting. A one-line message
 * is one paragraph, as before.
 */
export function RichText({ text, className }: { text: string; className?: string }) {
  const parsed = useMemo(() => parseMessage(text), [text]);
  const [zoom, setZoom] = useState<Picture | null>(null);
  // Both pages' policies keep images to this origin and decrypted files (AP-23): a remote image is a link.
  const ctx: Ctx = { open: setZoom, remoteImages: false };
  return (
    <>
      <div className={cx(styles.rich, className)}>{blocks(parsed, ctx)}</div>
      {zoom && (
        <ImageLightbox open onClose={() => setZoom(null)} title={zoom.alt || 'Image'}>
          <LightboxImage src={zoom.src} alt={zoom.alt} />
        </ImageLightbox>
      )}
    </>
  );
}
