/**
 * The final design's place pages on the web (Settings, Vault, Files, Usage;
 * docs/design-handoff/council-ui-2026-11/16-final/, docs/decisions/final-settings-vault-files-usage.md): the page
 * frame with its title and one line, a row's inside (icon tile, name, line, chevron) for the cards, and a read's
 * loading, empty and failed card that leaves the rest of the page usable.
 */
import { ArrowLeft, ChevronDown, ChevronRight, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Skeleton } from '../../components/ListState';
import { MoreDetail } from '../../components/MoreDetail';
import styles from './Place.module.css';

export { styles as placeStyles };

export function PlacePage({
  title,
  intro,
  back,
  action,
  screen,
  wide = false,
  children,
}: {
  title: string;
  intro?: ReactNode;
  /** The way back, first in the page (a group's “Back to Settings”). */
  back?: ReactNode;
  /** The header's action, beside the title and on its own line when there is no room. */
  action?: ReactNode;
  /** `data-screen`, for tests and the visual harness. */
  screen: string;
  /** A wider column (Settings → Screen's preview beside its choices). */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={styles.scroll} data-screen={screen}>
      <div className={cx(styles.page, wide && styles.pageWide)}>
        <div className={styles.header}>
          <div className={styles.heading}>
            {back}
            <h1 className={styles.title}>{title}</h1>
            {intro ? <p className={styles.intro}>{intro}</p> : null}
          </div>
          {action ? <div className={styles.action}>{action}</div> : null}
        </div>
        {children}
      </div>
    </div>
  );
}

/** The back link's look and arrow; the caller gives the link. */
export function BackLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <Icon icon={ArrowLeft} size={16} />
      {children}
    </>
  );
}

/** A row's inside: the icon tile (or a face), the name over its line, and the chevron. */
export function PlaceRowBody({
  icon,
  mark,
  name,
  line,
  bad = false,
  chevron = 'right',
}: {
  icon?: LucideIcon;
  /** In place of the icon: a face or a logo, in the same tile. */
  mark?: ReactNode;
  name: ReactNode;
  line?: ReactNode;
  /** The line in the Not working colour. */
  bad?: boolean;
  /** `down`: a row that opens something under it (Theme); its chevron turns up while open (`aria-expanded`). */
  chevron?: 'right' | 'down';
}) {
  return (
    <>
      <span className={styles.tile} aria-hidden="true">
        {mark ?? (icon ? <Icon icon={icon} size={18} /> : null)}
      </span>
      <span className={styles.main}>
        <span className={styles.name}>{name}</span>
        {line ? <span className={cx(styles.line, bad && styles.lineBad)}>{line}</span> : null}
      </span>
      <span className={cx(styles.chevron, chevron === 'down' && styles.chevronDown)} aria-hidden="true">
        <Icon icon={chevron === 'down' ? ChevronDown : ChevronRight} size={16} />
      </span>
    </>
  );
}

export type PlaceStateKind = 'loading' | 'empty' | 'failed';

/**
 * A read's state as one card: loading (its title and two bars, busy), empty (a successful read with nothing in it) or
 * failed (in the warning colour, never red: a read failing isn't the thing failing), with Try again and the error's
 * own words under More detail.
 */
export function PlaceState({
  kind,
  icon,
  title,
  line,
  onRetry,
  retryLabel,
  detail,
  children,
}: {
  kind: PlaceStateKind;
  icon: LucideIcon;
  title: string;
  line?: string;
  onRetry?: () => void;
  retryLabel?: string;
  detail?: string | null;
  /** The empty state's way on (Go to Chat). */
  children?: ReactNode;
}) {
  return (
    <div
      className={styles.state}
      data-state={kind}
      role={kind === 'failed' ? 'alert' : 'status'}
      aria-busy={kind === 'loading' || undefined}
    >
      <span className={styles.tile} aria-hidden="true">
        <Icon icon={icon} size={18} />
      </span>
      <p className={cx(styles.stateTitle, kind === 'failed' && styles.stateFailed)}>{title}</p>
      {line ? <p className={styles.stateLine}>{line}</p> : null}
      {kind === 'loading' ? (
        <div className={styles.bars} aria-hidden="true">
          <Skeleton width="80%" height={10} radius={5} />
          <Skeleton width="52%" height={10} radius={5} />
        </div>
      ) : null}
      {kind === 'failed' && onRetry ? (
        <Button variant="secondary" size="md" onClick={onRetry}>
          {retryLabel ?? 'Try again'}
        </Button>
      ) : null}
      {children}
      {kind === 'failed' && detail ? (
        <div className={styles.stateDetail}>
          <MoreDetail detail={detail} />
        </div>
      ) : null}
    </div>
  );
}

/** The error's own words for More detail. */
export function errorDetail(error: unknown): string | null {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}
