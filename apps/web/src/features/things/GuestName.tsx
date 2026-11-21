/**
 * A guest's kind as an icon and its name line in a table row (less-is-more.md AP-1755, AP-1756…): Docker's mark, the
 * Linux Containers mark or a screen before the name, the words (“Incus VM”, “Proxmox container 140”) in the icon's
 * tooltip and accessible name; the name ellipsises with the whole name in its tooltip; Proxmox's id muted after it;
 * an Incus project and “This Whombat” that shrink rather than push the columns; a change waiting for a restart as a
 * warning mark when the row's notes column has dropped out.
 */
import { BrandMark } from '@whombat/brand/react';
import { type GuestKindView, guestKind, isSelfGuest, SELF_GUEST_CHIP } from '@whombat/client/hosts';
import type { HostGuest } from '@whombat/core/domain';
import { AlertTriangle, House, Monitor } from 'lucide-react';
import type { ReactNode } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import wi from './incus/Incus.module.css';
import { AppLink } from './parts';
import styles from './Things.module.css';

/** The kind's icon: `role="img"` named by the kind's words, which are its tooltip too. */
export function GuestKindIcon({ kind, size = 16 }: { kind: GuestKindView; size?: number }) {
  return (
    <span
      className={styles.kindIcon}
      role="img"
      aria-label={kind.label}
      title={kind.label}
      data-kind={kind.glyph}
    >
      {kind.glyph === 'docker' ? (
        <BrandMark mark="docker" size={size} />
      ) : kind.glyph === 'lxc' ? (
        <BrandMark mark="linuxcontainers" size={size} />
      ) : (
        <Icon icon={Monitor} size={size} />
      )}
    </span>
  );
}

export function GuestName({
  guest: g,
  href,
  onOpen,
  note,
  after,
}: {
  guest: Pick<HostGuest, 'id' | 'name' | 'platform' | 'kind' | 'vmid' | 'project' | 'self'>;
  /** The guest's page as a link (the fleet's list) … */
  href?: string;
  /** … or a button that opens it on this page. */
  onOpen?: () => void;
  /** A change waiting for a restart: a warning mark once the notes column has dropped out (under 760 px). */
  note?: string | null;
  /** More after the name (the fleet's tags). */
  after?: ReactNode;
}) {
  const kind = guestKind(g);
  const nameClass = cx(styles.name, styles.gName, styles.ellipsis);
  return (
    <span className={styles.cellLine}>
      <GuestKindIcon kind={kind} />
      {href ? (
        <AppLink href={href} className={nameClass} title={g.name}>
          {g.name}
        </AppLink>
      ) : (
        <button type="button" className={nameClass} title={g.name} onClick={onOpen}>
          {g.name}
        </button>
      )}
      {kind.id ? <span className={styles.gId}>{kind.id}</span> : null}
      {g.platform === 'incus' && g.project && g.project !== 'default' ? (
        <span className={cx(wi.wiProject, styles.gProject, styles.ellipsis)} title={`Project ${g.project}`}>
          {g.project}
        </span>
      ) : null}
      {isSelfGuest(g) ? (
        <span className={cx(wi.wiSelf, styles.gSelf)} title="The guest this Whombat runs in">
          <Icon icon={House} size={12} />
          <span className={styles.gSelfWords}>{SELF_GUEST_CHIP}</span>
        </span>
      ) : null}
      {note ? (
        <span className={cx(styles.gNote, styles.onlyNarrow)} role="img" aria-label={note} title={note}>
          <Icon icon={AlertTriangle} size={14} />
        </span>
      ) : null}
      {after}
    </span>
  );
}
