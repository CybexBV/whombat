import { WhombatAvatar } from '@whombat/avatars/react';
import { agentFaceOf } from '@whombat/client';
import type { Principal, SearchResult } from '@whombat/core';
import { receiptMarker, SEARCH_TYPE_LABELS } from '@whombat/core';
import { Tag } from '../../components/Tag';
import { useWebI18n } from '../../i18n/provider';
import { PersonAvatar } from '../messaging/PersonAvatar';
import styles from './SearchResultRow.module.css';

export interface SearchResultRowProps {
  result: SearchResult;
  /** Result author, for the avatar and the mono name. */
  author?: Principal;
  onOpen: () => void;
}

/**
 * One search result: `[28px avatar · TYPE tag · where · who · "receipt n" · snippet]`; plans, decisions and automation
 * outcomes add their state pill (WS-21).
 */
export function SearchResultRow({ result, author, onOpen }: SearchResultRowProps) {
  const { tag: uiLocale } = useWebI18n();
  return (
    <button type="button" className={styles.row} onClick={onOpen}>
      {author?.kind === 'agent' ? (
        <WhombatAvatar face={agentFaceOf(author)} crop="head" size={28} label={author.name} />
      ) : author?.kind === 'person' ? (
        <PersonAvatar
          avatarUrl={author.avatarUrl}
          initials={author.initials}
          tone={author.tone}
          size={28}
          label={author.name}
        />
      ) : (
        <span className={styles.avatarPlaceholder} aria-hidden="true" />
      )}
      <span className={styles.content}>
        <span className={styles.metaRow}>
          <Tag>{SEARCH_TYPE_LABELS[result.type]}</Tag>
          <span className={styles.where}>{result.where}</span>
          {/* The mock's `r.a.name` binding is the principal's full name here, unlike the audit log's
              short names — see docs/decisions/audit-search.md. */}
          <span className={styles.author}>{author?.name ?? ''}</span>
          {result.citedAs !== null && (
            <span className={styles.receipt}>{receiptMarker(result.citedAs, uiLocale)}</span>
          )}
          {result.status && (
            // The state of a plan, decision or automation result (WS-21): “APPROVED BY MARA”, “2 OF 4 DONE”.
            <Tag variant="outline" tone={result.status.tone === 'neutral' ? 'mut' : result.status.tone}>
              {result.status.text}
            </Tag>
          )}
        </span>
        <span className={styles.snippet}>{result.snippet}</span>
      </span>
    </button>
  );
}
