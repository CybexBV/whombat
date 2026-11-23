/**
 * What starts an automation, as the tile at the start of its row and its page (automation-list.md AP-1080, AP-1081;
 * automation-page.md): a GitHub repo's owner picture with GitHub's mark on it (the mark alone while the picture loads,
 * or when the Whombat couldn't fetch it), or an icon for a report tracker, a schedule, a message, a reaction, a webhook
 * or a start by hand: a tracker is any ticket system, so its tile is the same for all of them and its label names it.
 * Logos are drawn, never fetched; the owner picture arrives as a `data:` URL from the Whombat (`github.avatar`).
 */
import type { AutomationTileView } from '@whombat/client';
import { useGitHubAvatar } from '@whombat/client/react';
import type { AutomationSource } from '@whombat/core';
import {
  Clock,
  Inbox,
  type LucideIcon,
  Mail,
  MapPin,
  MessageSquare,
  Play,
  SmilePlus,
  Webhook,
} from 'lucide-react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { GitHubMark } from '../settings/GitHubMark';
import styles from './Automations.module.css';

/** The owner picture's lifetime here: the Whombat keeps it a day, so a list opened again doesn't ask. */
const AVATAR_STALE_MS = 6 * 60 * 60 * 1000;

const SOURCE_ICONS: Record<Exclude<AutomationSource, 'github'>, LucideIcon> = {
  tracker: Inbox,
  mail: Mail,
  findmy: MapPin,
  schedule: Clock,
  message: MessageSquare,
  reaction: SmilePlus,
  webhook: Webhook,
  manual: Play,
};

/** A 24px mark on the list's compact rows, a 40px tile, 52px on the automation's page, as the phone's. */
const SIZES = { mark: 24, row: 40, page: 52 } as const;

export function SourceTile({
  burrow,
  tile,
  size = 'row',
}: {
  burrow: string;
  tile: AutomationTileView;
  size?: keyof typeof SIZES;
}) {
  const px = SIZES[size];
  const owner = tile.owner ?? '';
  const { data } = useGitHubAvatar(owner ? { params: { burrow, owner } } : null, {
    staleTime: AVATAR_STALE_MS,
    retry: false,
  });
  const className = cx(styles.tile, size === 'page' && styles.tilePage, size === 'mark' && styles.tileMark);
  const mark = size === 'mark';
  if (tile.source === 'github') {
    const image = owner && data?.owner.toLowerCase() === owner.toLowerCase() ? data.image : null;
    return (
      <span className={className} role="img" aria-label={tile.label}>
        {image ? (
          <>
            <img className={styles.tileImage} src={image} alt="" />
            <span className={styles.tileBadge}>
              <GitHubMark size={size === 'page' ? 12 : mark ? 9 : 10} />
            </span>
          </>
        ) : (
          <GitHubMark size={mark ? 22 : Math.round(px / 2)} />
        )}
      </span>
    );
  }
  return (
    <span className={className} role="img" aria-label={tile.label}>
      <Icon icon={SOURCE_ICONS[tile.source]} size={mark ? 21 : Math.round(px * 0.45)} />
    </span>
  );
}
