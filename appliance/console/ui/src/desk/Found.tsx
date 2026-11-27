/**
 * Found on your network (Whombat desk-found.md DF-01…DF-12, mockups `docs/design/desk-found/`; CG-230…): what the
 * scan found that isn't connected yet. On a glance without servers and tiles it is the panel where This Whombat would
 * be (frames 1–2): up to eight cards in two rows of four, dashed places while the first scan looks; beside servers or
 * tiles the one-line strip (frame 3). Connecting happens on the computer (DF-01); the screen only shows and offers
 * Not now (DF-04), which works locked too. Cards that arrive while the page watches fade in once (DF-10).
 */

import { isBrandMark } from '@whombat/brand';
import { BrandMark } from '@whombat/brand/react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useT } from '../i18n/react';
import type { DeskFound, DeskFoundItem } from '../lib/desk';
import { fill, foundCopy, foundHead } from '../lib/deskCopy';
import { FIT } from '../lib/deskFit';
import styles from './desk.module.css';
import { FOUND_MARKS } from './foundMarks';
import { Icon } from './icons';

/** A found service's key: its entry and address (two Proxmox hosts are two cards). */
export const foundKey = (i: DeskFoundItem): string => `${i.catalogId}@${i.address}`;

/** The service's mark (DF-12): the app's, Synology's or QNAP's, else the name's first letter. */
export function FoundMark({ item, size }: { item: DeskFoundItem; size: number }) {
  const id = item.catalogId;
  if (isBrandMark(id)) return <BrandMark mark={id} size={size} />;
  const own = Object.hasOwn(FOUND_MARKS, id) ? FOUND_MARKS[id] : undefined;
  if (own)
    return (
      <svg
        viewBox={own.viewBox}
        width={size}
        height={size}
        data-mark={id}
        aria-hidden="true"
        focusable="false"
        style={{ display: 'block', flex: 'none' }}
      >
        {own.shapes.map((s) => (
          <path key={s.d.slice(0, 24)} d={s.d} fill={s.fill} />
        ))}
      </svg>
    );
  return (
    <span className={styles.foundLetter} aria-hidden="true">
      {([...item.name][0] ?? '?').toUpperCase()}
    </span>
  );
}

/** “Connect them on your computer: app.whombat.com → Connections”, the address in the mono face. */
function Connect({ words, appUrl }: { words: { before: string; after: string }; appUrl: string }) {
  return (
    <span>
      {words.before}
      <b className={styles.foundUrl}>{appUrl}</b>
      {words.after}
    </span>
  );
}

function NotNow({ onDismiss, className }: { onDismiss: () => void; className?: string }) {
  const t = useT();
  const FOUND = foundCopy(t);

  return (
    <button
      type="button"
      className={className}
      onClick={(e) => {
        // Not the PIN pad a touch on the locked glance opens (DF-04: it works locked).
        e.stopPropagation();
        onDismiss();
      }}
    >
      {FOUND.notNow}
    </button>
  );
}

export interface FoundProps {
  found: DeskFound;
  /** The console's `appUrl` (“app.whombat.com”); empty: the line is left out. */
  appUrl: string;
  /** Whombat's clock (ms), for “8 found · just now”. */
  now: number;
  /** The cards that arrived in the last change while the page watched (`foundKey`): they fade in (DF-10). */
  latest: ReadonlySet<string>;
  /** Not now (DF-04); absent while Whombat is away (nothing is sent). */
  onDismiss?: () => void;
}

/** A found service (frame 2): its mark, name, short line and address. */
function Card({ item, fresh, edge }: { item: DeskFoundItem; fresh: boolean; edge: boolean }) {
  return (
    <div className={styles.foundCard} data-new={fresh || undefined} data-edge={edge || undefined}>
      <div className={styles.foundBody}>
        <span className={styles.foundLogo}>
          <FoundMark item={item} size={24} />
        </span>
        <b className={styles.foundName}>{item.name}</b>
        {item.tagline && <span className={styles.foundWhat}>{item.tagline}</span>}
        <span className={styles.foundAddress}>{item.address}</span>
      </div>
    </div>
  );
}

/** A place still empty while the first scan looks (frame 1): a dashed outline. */
function Place() {
  return (
    <div className={styles.foundCard} data-wait aria-hidden="true">
      <div className={styles.foundBody}>
        <span className={styles.foundLogo} />
        <i className={styles.foundBar} style={{ width: '70%' }} />
        <i className={styles.foundBar} style={{ width: '90%' }} />
      </div>
    </div>
  );
}

/**
 * The panel (frames 1–2): the head with what it looked at or found, `rows` rows of four cards (dashed places fill
 * them while the first scan looks), then where to connect them and Not now once it's done.
 */
export function FoundPanel({ found, appUrl, now, latest, onDismiss, rows }: FoundProps & { rows: number }) {
  const t = useT();
  const FOUND = foundCopy(t);

  const looking = found.progress !== null;
  const places = rows * FIT.perRow;
  const items = found.items.slice(0, places);
  const share = found.progress ? Math.min(1, found.progress.done / found.progress.total) : 0;
  return (
    <section className={`${styles.card} ${styles.found}`} aria-label={FOUND.title}>
      <div className={styles.foundHead}>
        <span className={styles.foundIcon}>
          <Icon name="radar" />
        </span>
        <b className={styles.foundTitle}>{FOUND.title}</b>
        <div className={styles.spacer} />
        <span className={styles.foundMeta}>{foundHead(found, now, t)}</span>
        {looking && (
          <span className={styles.foundProgress} aria-hidden="true">
            <i style={{ width: `${share * 100}%` }} />
          </span>
        )}
      </div>
      <div className={styles.foundGrid} data-rows={rows}>
        {items.map((i) => {
          const k = foundKey(i);
          return <Card key={k} item={i} fresh={latest.has(k)} edge={looking && latest.has(k)} />;
        })}
        {looking &&
          Array.from({ length: places - items.length }, (_, n) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the empty places are positions
            <Place key={n} />
          ))}
      </div>
      {!looking && (appUrl || onDismiss) && (
        <div className={styles.foundFoot}>
          {appUrl && (
            <>
              <Icon name="laptop" className={styles.foundFootIcon} />
              <Connect words={found.count === 1 ? FOUND.connectOne : FOUND.connectMany} appUrl={appUrl} />
            </>
          )}
          <div className={styles.spacer} />
          {onDismiss && <NotNow onDismiss={onDismiss} className={styles.foundButton} />}
        </div>
      )}
    </section>
  );
}

/**
 * How many chips fit in the strip's room, leaving room for “+k more” when some (or ones Whombat didn't name) are left
 * out. Measured on a hidden row of every chip, in the same (zoomed) px as the room, before the browser paints.
 */
function useChipFit(names: number, count: number) {
  const room = useRef<HTMLDivElement>(null);
  const probe = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(names);
  const read = useCallback(() => {
    const r = room.current;
    const p = probe.current;
    if (!r || !p) return;
    const avail = r.getBoundingClientRect().width;
    const chips = [...p.children].slice(0, names).map((c) => c.getBoundingClientRect());
    const more = p.children[names]?.getBoundingClientRect();
    const left = p.getBoundingClientRect().left;
    const gap = more && chips.length > 0 ? more.left - (chips.at(-1)?.right ?? more.left) : 0;
    let n = chips.length;
    for (; n > 0; n--) {
      const need = (chips[n - 1]?.right ?? left) - left + (count > n && more ? gap + more.width : 0);
      if (need <= avail + 0.5) break;
    }
    setFit((f) => (f === n ? f : n));
  }, [names, count]);
  useLayoutEffect(read);
  useLayoutEffect(() => {
    const r = room.current;
    if (!r) return;
    const ro = new ResizeObserver(() => flushSync(read));
    ro.observe(r);
    return () => ro.disconnect();
  }, [read]);
  return { room, probe, fit };
}

function Chip({ item, fresh }: { item: DeskFoundItem; fresh?: boolean }) {
  return (
    <span className={styles.chipFound} data-new={fresh || undefined}>
      <FoundMark item={item} size={18} />
      {item.name}
    </span>
  );
}

/**
 * The strip (frame 3): “Still on your network” beside servers and tiles (“Found on your network” where it stands in
 * for the panel, `alone`), the marks and names as chips, “+k more” for the ones that don't fit, where to connect them
 * and Not now; while the first scan looks, what it looked at instead.
 */
export function FoundStrip({
  found,
  appUrl,
  now,
  latest,
  onDismiss,
  alone,
}: FoundProps & { alone: boolean }) {
  const t = useT();
  const FOUND = foundCopy(t);

  const looking = found.progress !== null;
  const { room, probe, fit } = useChipFit(found.items.length, found.count);
  const shown = found.items.slice(0, fit);
  const rest = found.count - shown.length;
  const title = alone ? FOUND.title : FOUND.stripTitle;
  return (
    <section className={`${styles.card} ${styles.strip}`} aria-label={title}>
      <span className={styles.label}>{title}</span>
      <div className={styles.stripRoom} ref={room}>
        {shown.map((i) => {
          const k = foundKey(i);
          return <Chip key={k} item={i} fresh={latest.has(k)} />;
        })}
        {rest > 0 && <span className={styles.stripMore}>{fill(FOUND.stripMore, { k: rest })}</span>}
      </div>
      {/* Every chip and the widest “+k more”, unseen: what `useChipFit` measures. */}
      <div className={styles.stripProbe} ref={probe} aria-hidden="true">
        {found.items.map((i) => (
          <Chip key={foundKey(i)} item={i} />
        ))}
        <span className={styles.stripMore}>{fill(FOUND.stripMore, { k: found.count })}</span>
      </div>
      {looking ? (
        <span className={styles.stripGo}>{foundHead(found, now, t)}</span>
      ) : (
        <>
          {appUrl && (
            <span className={styles.stripGo}>
              <Connect words={FOUND.stripConnect} appUrl={appUrl} />
            </span>
          )}
          {onDismiss && <NotNow onDismiss={onDismiss} className={styles.stripButton} />}
        </>
      )}
    </section>
  );
}
