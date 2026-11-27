/**
 * The hosted app's legal pages (LC-17): `/legal/appliance-terms` renders `appliance-terms.md`, an exact copy of
 * `appliance/docs/legal/appliance-terms.md` (a harness gate checks they match), with its version on top;
 * `/legal/subscription-terms` renders this app's own `subscription-terms.md` (BL-24, AP-128), the version
 * `SUBSCRIPTION_TERMS_VERSION` names; `/legal/privacy` renders `privacy-policy.md` (AP-165) and `/legal/terms`
 * renders `terms-of-service.md` (AP-166). Nobody ticks those two, so no contract constant names their versions.
 * Public: no sign-in needed. Not in the mocks: a reading column in the design
 * system's type and colors.
 */

import { WhombatLogo } from '@whombat/brand/react';
import type { Inline } from '@whombat/core';
import { type ReactNode, useMemo } from 'react';
import terms from './appliance-terms.md?raw';
import styles from './LegalPage.module.css';
import { type LegalBlock, parseLegal } from './legal';
import privacyPolicy from './privacy-policy.md?raw';
import subscriptionTerms from './subscription-terms.md?raw';
import termsOfService from './terms-of-service.md?raw';

export const LEGAL_PAGES: Record<string, string> = {
  '/legal/appliance-terms': terms,
  '/legal/subscription-terms': subscriptionTerms,
  '/legal/privacy': privacyPolicy,
  '/legal/terms': termsOfService,
};

function inline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map(inlineNode);
}

/* Inline nodes are positional and never reorder, so they are keyed by index. */
function inlineNode(node: Inline, i: number): ReactNode {
  switch (node.type) {
    case 'text':
    case 'mention':
      return node.text;
    case 'break':
      return <br key={i} />;
    case 'code':
      return <code key={i}>{node.text}</code>;
    case 'strong':
      return <strong key={i}>{inline(node.children)}</strong>;
    case 'em':
      return <em key={i}>{inline(node.children)}</em>;
    case 'strike':
      return <s key={i}>{inline(node.children)}</s>;
    case 'link':
      return (
        <a key={i} href={node.href} rel="noopener noreferrer">
          {inline(node.children)}
        </a>
      );
    case 'image':
      // The terms have no images; an image would read as its description.
      return node.alt;
  }
}

function block(b: LegalBlock, i: number): ReactNode {
  switch (b.type) {
    case 'heading':
      return b.level === 1 ? (
        <h1 key={i} className={styles.title}>
          {inline(b.children)}
        </h1>
      ) : (
        <h2 key={i} className={styles.heading}>
          {inline(b.children)}
        </h2>
      );
    case 'quote':
      return (
        <div key={i} className={styles.version} role="note">
          {inline(b.children)}
        </div>
      );
    case 'list': {
      const items = b.items.map((item, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: items are positional and never reorder
        <li key={n}>{inline(item)}</li>
      ));
      return b.ordered ? (
        <ol key={i} className={styles.list}>
          {items}
        </ol>
      ) : (
        <ul key={i} className={styles.list}>
          {items}
        </ul>
      );
    }
    case 'paragraph':
      return <p key={i}>{inline(b.children)}</p>;
  }
}

/**
 * Who sells the service, under every legal page: the seller's details the law asks a web shop to show. Kept out of the
 * texts themselves so that adding them doesn't make an accepted version of the terms change.
 */
export const SELLER_LINE =
  'Cybex B.V. · James Cookstraat 12G · 7825 AN Emmen, the Netherlands · KvK 77711815 · VAT NL861104432B01';
export const SELLER_EMAIL = 'info@whombat.com';

/** A page's Markdown as blocks, in the reading column's type (the legal pages, What’s new). */
export function LegalBlocks({ text }: { text: string }) {
  const blocks = useMemo(() => parseLegal(text), [text]);
  return <>{blocks.map(block)}</>;
}

export function LegalPage({ text }: { text: string }) {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <a href="/" aria-label="Whombat">
          <WhombatLogo variant="lockup" height={23} label="Whombat" />
        </a>
      </header>
      <main className={styles.column}>
        <LegalBlocks text={text} />
      </main>
      <footer className={styles.seller}>
        {SELLER_LINE} · <a href={`mailto:${SELLER_EMAIL}`}>{SELLER_EMAIL}</a>
      </footer>
    </div>
  );
}
