/**
 * Overview's Connections (docs/decisions/overview-one-page.md OVP-09): a small tile a connection from `overviewTiles` —
 * its logo, name and one line, its mark at the top right (the status level's shape; connected is the plain dot), and
 * a foot with what it is and when it was last used when either is known. Worst first. A tile is one link; its page is
 * read while the pointer rests on it.
 */
import { BrandMark } from '@whombat/brand/react';
import { type OverviewTile, STATUS_LEVEL_WORDS } from '@whombat/client';
import { Icon } from '../../components/Icon';
import { StatusMark } from '../../components/StatusMark';
import { AppLink } from '../things/parts';
import { type ThingLinkProps, useThingLinkProps } from '../things/prefetch';
import { THING_ICONS } from '../things/thingIcons';
import styles from './Overview.module.css';

/** The tile's edge: amber when it needs a look, red when it isn't working (an offline one is only grey). */
function edgeOf(tile: OverviewTile): 'warn' | 'bad' | undefined {
  if (tile.line.tone === 'warn') return 'warn';
  if (tile.line.tone === 'bad') return 'bad';
  return undefined;
}

export function ConnectionTile({ tile, linkProps }: { tile: OverviewTile; linkProps?: ThingLinkProps }) {
  const r = tile.row;
  return (
    <AppLink
      href={r.href}
      {...linkProps}
      className={styles.con}
      aria-label={tile.label}
      data-thing={r.id}
      data-level={r.level}
      data-edge={edgeOf(tile)}
    >
      <span className={styles.logo} aria-hidden="true">
        {r.mark ? <BrandMark mark={r.mark} size={22} /> : <Icon icon={THING_ICONS[r.glyph]} size={20} />}
      </span>
      <span className={styles.cwho}>
        <span className={styles.cname}>{r.name}</span>
        <span className={styles.cline} data-tone={tile.line.tone}>
          {tile.line.text}
        </span>
      </span>
      <span className={styles.cstate}>
        {r.level === 'connected' ? (
          <span
            className={styles.okDot}
            role="img"
            aria-label={STATUS_LEVEL_WORDS.connected}
            title={STATUS_LEVEL_WORDS.connected}
          />
        ) : (
          <StatusMark level={r.level} label={r.word} />
        )}
      </span>
      {tile.what || tile.used ? (
        <span className={styles.cfoot}>
          {tile.what ? <span>{tile.what}</span> : null}
          {tile.used ? <span className={styles.cused}>{tile.used}</span> : null}
        </span>
      ) : null}
    </AppLink>
  );
}

/** The tiles in the mock's grid. */
export function OverviewConnections({ burrow, tiles }: { burrow: string; tiles: readonly OverviewTile[] }) {
  const linkProps = useThingLinkProps(burrow);
  return (
    <div className={styles.cons}>
      {tiles.map((t) => (
        <ConnectionTile key={t.row.id} tile={t} linkProps={linkProps(t.row.href)} />
      ))}
    </div>
  );
}
