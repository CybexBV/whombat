import type { MouseEvent, ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { type DotTone, StatusDot } from '../../components/StatusDot';
import styles from './ConversationHeader.module.css';

/** A branch room's header (the one conversation with a header left: Whombat one-agent.md OA-04; AP-4949). */
export type ConversationHeaderVariant = {
  kind: 'branch';
  /** Branch name (`feat/invoice-pdf`), in DM Mono. */
  title: string;
  topic: string;
  /** "Open · changes requested" → "Open · ready" → "Merged". */
  status: { label: string; tone: DotTone };
};

export interface HeaderAction {
  label: string;
  /** App path the action opens (`/canvases/…`). */
  href: string;
}

export interface ConversationHeaderProps {
  variant: ConversationHeaderVariant;
  /** "Plan canvas", "Branch room". */
  actions?: HeaderAction[];
  /** In-app navigation for action links (plain links still work without it). */
  onNavigate?: (href: string) => void;
  /**
   * “Plans”: the conversation's plans in the right pane (`?plans=1`, WS-09). Placed before the mock's own actions so
   * those keep their place.
   */
  plansHref?: string;
  /**
   * “Files”: the conversation's Files (`/files/pr/…`, docs/decisions/files-space.md AP-778), right after “Plans” in its
   * style; only on a Whombat with `files.space`.
   */
  filesHref?: string;
  /** Buttons after the actions: the bell (AP-469) and the conversation's menu (AP-471). */
  tools?: ReactNode;
  /**
   * “Pinned · N”: the conversation's pinned messages in the right pane (`?pins=1`, essentials-messages.md AP-445); only
   * while something is pinned.
   */
  pins?: { count: number; href: string } | undefined;
}

/**
 * Conversation header (README "Branch room"): 76px min, title row, topic with ellipsis, action buttons. The mock's
 * member stack went with one person per Whombat (CT-1514; one-person.md AP-5714).
 */
export function ConversationHeader({
  variant,
  actions = [],
  onNavigate,
  plansHref,
  filesHref,
  tools,
  pins,
}: ConversationHeaderProps) {
  const follow = (href: string) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(href);
  };
  return (
    <header className={styles.header}>
      <div className={styles.heading}>
        <div className={styles.titleRow}>
          {variant.kind === 'branch' && (
            <>
              <h1 className={styles.branchTitle}>{variant.title}</h1>
              <span className={styles.statusChip}>
                <StatusDot tone={variant.status.tone} size={7} label={null} />
                {variant.status.label}
              </span>
            </>
          )}
        </div>
        <span className={styles.topic} title={variant.topic || undefined}>
          {variant.topic}
        </span>
      </div>
      {pins && pins.count > 0 && (
        <a
          href={pins.href}
          className={`${styles.action} ${styles.pinsAction}`}
          onClick={follow(pins.href)}
          title="Pinned messages"
          data-header-pins=""
        >
          <Icon name="pin" size={14} />
          <span className={styles.pinsWord}>Pinned ·</span> {pins.count}
        </a>
      )}
      {plansHref && (
        <a href={plansHref} className={styles.action} onClick={follow(plansHref)} data-header-plans="">
          Plans
        </a>
      )}
      {filesHref && (
        <a href={filesHref} className={styles.action} onClick={follow(filesHref)} data-header-files="">
          Files
        </a>
      )}
      {actions.map((a) => (
        <a key={a.label} href={a.href} className={styles.action} onClick={follow(a.href)}>
          {a.label}
        </a>
      ))}
      {tools}
    </header>
  );
}
