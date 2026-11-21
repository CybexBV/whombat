/**
 * The head of every server's and connection's page (Whombat dashboards.md DS-01, service-slots.md SLT-10;
 * dashboards-web.md AP-2050…, service-slots-web.md): the crumb, then two lines beside the kind's icon in its box — the
 * name (a server's in the mono face), one status badge, a few chips (what it runs, what Whombat may do) and the
 * verdict on the first, the fact line under it — and the actions on the right (Ask first, then the kind's). And the
 * tab row with the live words and, while a chart card is left, the range picker at its right end (connections-page.md
 * AP-2510).
 */
import type { MarkLike } from '@whombat/brand';
import { BrandMark } from '@whombat/brand/react';
import type { HostTone } from '@whombat/client/hosts';
import { ChevronLeft, type LucideIcon } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { AppLink, Badge } from '../parts';
import things from '../Things.module.css';
import styles from './Head.module.css';

const ICON_TONES = {
  plain: styles.iconPlain,
  blue: styles.iconBlue,
  warm: styles.iconWarm,
} as const;

export function Crumb({ href, label }: { href: string; label: string }) {
  return (
    <AppLink href={href} className={things.crumb}>
      <Icon icon={ChevronLeft} size={15} />
      {label}
    </AppLink>
  );
}

export function PageHead({
  crumb,
  icon,
  mark,
  iconTone = 'blue',
  name,
  mono = false,
  badge,
  chips,
  actions,
  verdict,
  facts,
  renaming,
  statusFirst = false,
  detail,
}: {
  crumb: { href: string; label: string };
  icon: LucideIcon;
  /** What it is as its maker's mark (a server's Debian, Home Assistant's house), drawn on the plain box instead of the icon. */
  mark?: MarkLike | null;
  /** The icon's box: plain for a server, the blue tint for a service, a warm one for a cloud. */
  iconTone?: keyof typeof ICON_TONES;
  name: string;
  /** A host name, set in the mono face. */
  mono?: boolean;
  /** Null while it isn't known (a page's head drawn before it answers, app page-speed.md AP-2652). */
  badge: { tone: HostTone; text: string } | null;
  chips?: readonly string[];
  /** Ask, then the kind's own (Shell and Power, Restart, Open). */
  actions: ReactNode;
  /**
   * The one plain sentence about it (“Plex is fine: 3 people are watching …”), after the badge on the name's line; it
   * wraps under the name when the line has no room. The badge already says the tone, so it has no dot of its own.
   */
  verdict?: string | null;
  /** The fact line's parts, each its own span. */
  facts?: ReactNode;
  /** The name being renamed: a box in the title's place (`InlineRename`). */
  renaming?: ReactNode;
  /** The status pill leads the fact line instead of following the name (a service's page). */
  statusFirst?: boolean;
  /** What “More detail” at the end of the fact line opens under it (a service's version, database, uptime). */
  detail?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const badgeEl = badge ? (
    <Badge tone={badge.tone} dot className={styles.badge}>
      {badge.text}
    </Badge>
  ) : null;
  const lead = statusFirst ? badgeEl : null;
  return (
    <>
      <Crumb {...crumb} />
      <div className={cx(things.head, styles.head)}>
        <span className={cx(styles.icon, ICON_TONES[mark ? 'plain' : iconTone])} aria-hidden="true">
          {mark ? <BrandMark mark={mark} size={30} /> : <Icon icon={icon} size={26} />}
        </span>
        <div className={styles.nameBox}>
          <div className={styles.nameLine}>
            {renaming ? (
              <div className={cx(styles.renaming, mono ? styles.nameMono : styles.name)}>{renaming}</div>
            ) : (
              <h1 className={mono ? styles.nameMono : styles.name}>{name}</h1>
            )}
            {statusFirst ? null : badgeEl}
            {chips?.length ? (
              <ul className={styles.chips} aria-label="About it">
                {chips.map((c) => (
                  <li key={c} className={styles.chip}>
                    {c}
                  </li>
                ))}
              </ul>
            ) : null}
            {verdict ? <p className={styles.verdict}>{verdict}</p> : null}
          </div>
          {facts || lead || detail ? (
            <div className={cx(things.facts, styles.facts)}>
              {lead ? <span className={styles.lead}>{lead}</span> : null}
              {facts}
              {detail ? (
                <span className={styles.moreSlot}>
                  <button
                    type="button"
                    className={styles.more}
                    aria-expanded={open}
                    aria-controls={detailId}
                    onClick={() => setOpen((o) => !o)}
                  >
                    More detail
                  </button>
                </span>
              ) : null}
            </div>
          ) : null}
          {detail ? (
            <div id={detailId} className={cx(things.facts, styles.facts, styles.detail)} hidden={!open}>
              {detail}
            </div>
          ) : null}
        </div>
        <div className={cx(things.actions, styles.actions)}>{actions}</div>
      </div>
    </>
  );
}

/** The tab row: the tabs, and on the Summary the live words and the range picker (when still needed) at the right end. */
export function TabRow({ children, picker }: { children: ReactNode; picker?: ReactNode }) {
  return (
    <div className={styles.tabRow}>
      {children}
      {picker}
    </div>
  );
}

/** The class the tabs take inside a `TabRow` (the row draws the rule under them). */
export const tabsInRow = cx(things.tabs, styles.tabsIn);
