/**
 * A gallery (contracts 0.121 `gallery`, CT-1004; Whombat service-dashboards.md SD-20…SD-24, SD-32, SD-55, SD-56;
 * service-dashboards.md AP-4564): pictures in rows that fill the card — posters 2:3 (Recently added, requests waiting
 * for approval), wide snapshots 16:9 (cameras), square thumbnails (photos, documents) — each with its title, `sub`, a
 * badge on the picture, a progress bar with its note, and its buttons under it. The picture and its words lead to the
 * app's page for it (`href`) or the service's own page in a new tab (`url`); the buttons stay outside that link. A muted
 * item (an offline camera) is greyed. Two looks of a service's slots (service-slots.md SLT-02, SLT-04): `rows`, one line
 * per item with a small picture, its words, who it is about and a wide progress bar (what plays now); `shelf`, one row
 * of pictures that holds as many as fit and never starts a second.
 */
import {
  type ThingGalleryPanel as GalleryPanel,
  itemWhen,
  thingGalleryWords,
  thingItemLink,
  thingProgressPct,
} from '@whombat/client';
import type { ThingGalleryItem } from '@whombat/core';
import { ExternalLink } from 'lucide-react';
import { type CSSProperties, type ReactNode, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { AppLink, Card, Dot } from '../parts';
import { ThingButtonRow } from './Buttons';
import { type DashboardContext, PanelHead } from './Panels';
import { Picture } from './Picture';
import styles from './Service.module.css';
import slots from './Slots.module.css';
import { personInitial, personTone, SHELF_GAP, SHELF_MIN, shelfFit, shelfTag } from './slots';

/** The smallest a picture gets in its row, by shape: the row holds as many as fit. */
const SHAPES: Record<GalleryPanel['shape'], string | undefined> = {
  poster: styles.galleryPoster,
  wide: styles.galleryWide,
  square: styles.gallerySquare,
};

const MIN_WIDTH: Record<GalleryPanel['shape'], number> = { poster: 100, wide: 200, square: 100 };

export function GalleryPanelView({ panel, ctx }: { panel: GalleryPanel; ctx: DashboardContext }) {
  if (!panel.items.length && !panel.empty) return null;
  if (panel.look === 'rows') return <RowsView panel={panel} ctx={ctx} />;
  if (panel.look === 'shelf') return <ShelfView panel={panel} ctx={ctx} />;
  return (
    <Card
      title={panel.title}
      meta={panel.meta}
      link={<PanelHead panel={panel} ctx={ctx} />}
      className={styles.galleryCard}
    >
      {panel.items.length ? (
        <ul
          className={cx(styles.gallery, SHAPES[panel.shape])}
          style={{ '--g-min': `${MIN_WIDTH[panel.shape]}px` } as CSSProperties}
        >
          {panel.items.map((item) => (
            <GalleryItem key={item.id} item={item} shape={panel.shape} ctx={ctx} />
          ))}
        </ul>
      ) : (
        <p className={styles.quiet}>{panel.empty}</p>
      )}
    </Card>
  );
}

/** A badge on a picture: solid, so it reads over any poster; its dot says the tone (fine is a quiet grey). */
const BADGE_TONES = { ok: 'mut', warn: 'warn', bad: 'bad' } as const;
const BADGE_TEXT = { ok: undefined, warn: styles.gBadgeWarn, bad: styles.gBadgeBad } as const;

function GalleryItem({
  item,
  shape,
  ctx,
}: {
  item: ThingGalleryItem;
  shape: GalleryPanel['shape'];
  ctx: DashboardContext;
}) {
  const link = thingItemLink(item);
  const pct = thingProgressPct(item.progress);
  const when = !item.sub && item.at ? itemWhen(item.at, ctx.now, ctx.timeZone) : null;
  const body: ReactNode = (
    <>
      <span className={styles.gPic}>
        <Picture
          burrow={ctx.burrow}
          thing={ctx.thing.id}
          image={item.image}
          shape={shape}
          title={item.title}
          muted={item.muted}
        />
        {item.badge ? (
          <span className={cx(styles.gBadge, BADGE_TEXT[item.badge.tone])}>
            <Dot tone={BADGE_TONES[item.badge.tone]} />
            <span className={styles.gBadgeText}>{item.badge.text}</span>
          </span>
        ) : null}
        {link?.kind === 'url' ? (
          <span className={styles.gOut} aria-hidden="true">
            <Icon icon={ExternalLink} size={12} />
          </span>
        ) : null}
      </span>
      <span className={styles.gTitle}>{item.title}</span>
      {item.sub ? <span className={styles.gSub}>{item.sub}</span> : null}
      {when && item.at ? (
        <time className={styles.gSub} dateTime={item.at}>
          {when}
        </time>
      ) : null}
    </>
  );
  // A link is named by its words in order (title · sub · badge · note); its picture's alt is the picture's own.
  const named = { 'aria-label': thingGalleryWords(item) };
  return (
    <li className={cx(styles.gItem, item.muted && styles.gMuted)} data-item={item.id}>
      {link?.kind === 'href' ? (
        <AppLink href={link.href} className={styles.gLink} {...named}>
          {body}
        </AppLink>
      ) : link?.kind === 'url' ? (
        <a href={link.url} target="_blank" rel="noreferrer" className={styles.gLink} {...named}>
          {body}
        </a>
      ) : (
        <div className={styles.gBody}>{body}</div>
      )}
      {pct !== null ? (
        <span
          className={styles.gProgress}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
          aria-label={item.title}
          aria-valuetext={item.note ?? `${pct} %`}
        >
          <i style={{ width: `${pct}%` }} />
        </span>
      ) : null}
      {item.note ? (
        <span className={styles.gNote} aria-hidden={pct !== null || undefined}>
          {item.note}
        </span>
      ) : null}
      <ThingButtonRow
        items={item.actions}
        buttons={ctx.buttons}
        className={styles.gActs}
        label={item.title}
      />
    </li>
  );
}

/* Live rows (SLT-02) and the shelf (SLT-04) */

/** A person's initial on one of the five avatar tones, named by their name for a screen reader when it stands alone. */
export function PersonInitial({
  name,
  size,
  label = false,
}: {
  name: string;
  size: number;
  label?: boolean;
}) {
  return (
    <span
      className={slots.av}
      style={
        {
          width: size,
          height: size,
          fontSize: Math.round(size * 0.42),
          background: `var(--tone-${personTone(name)})`,
        } as CSSProperties
      }
      {...(label ? { role: 'img', 'aria-label': name } : { 'aria-hidden': true })}
    >
      {personInitial(name)}
    </span>
  );
}

const CHIP_TONES = { ok: slots.chipOk, warn: slots.chipWarn, bad: slots.chipBad } as const;

/** “1:10:12 of 2:46:00”: the part played set in the ink, the rest quiet. */
function NoteStart({ note }: { note: string }) {
  const at = note.indexOf(' of ');
  if (at <= 0) return <span>{note}</span>;
  return (
    <span>
      <b>{note.slice(0, at)}</b>
      {note.slice(at)}
    </span>
  );
}

function RowsView({ panel, ctx }: { panel: GalleryPanel; ctx: DashboardContext }) {
  return (
    <Card
      title={panel.title}
      meta={panel.meta}
      link={<PanelHead panel={panel} ctx={ctx} />}
      className={styles.galleryCard}
    >
      {panel.items.length ? (
        <ul className={slots.rows}>
          {panel.items.map((item) => (
            <LiveRow key={item.id} item={item} shape={panel.shape} ctx={ctx} />
          ))}
        </ul>
      ) : (
        <p className={styles.quiet}>{panel.empty}</p>
      )}
    </Card>
  );
}

function LiveRow({
  item,
  shape,
  ctx,
}: {
  item: ThingGalleryItem;
  shape: GalleryPanel['shape'];
  ctx: DashboardContext;
}) {
  const link = thingItemLink(item);
  const pct = thingProgressPct(item.progress);
  const title =
    link?.kind === 'href' ? (
      <AppLink href={link.href} className={slots.rowLink}>
        {item.title}
      </AppLink>
    ) : link?.kind === 'url' ? (
      <a href={link.url} target="_blank" rel="noreferrer" className={slots.rowLink}>
        {item.title}
        <Icon icon={ExternalLink} size={12} className={slots.rowOut} />
      </a>
    ) : (
      item.title
    );
  // A paused stream's tag is quiet whatever its tone: nothing is wrong, it only stands still.
  const chip = item.badge ? (
    <span className={cx(slots.chip, item.paused ? slots.chipMute : CHIP_TONES[item.badge.tone])}>
      {item.badge.text}
    </span>
  ) : null;
  return (
    <li className={cx(slots.row, item.muted && styles.gMuted)} data-item={item.id}>
      <Picture
        burrow={ctx.burrow}
        thing={ctx.thing.id}
        image={item.image}
        shape={shape}
        title={item.title}
        muted={item.muted}
        className={slots.rowPic}
      />
      <div className={slots.rowWords}>
        <b className={slots.rowTitle}>{title}</b>
        {item.sub ? <span className={slots.rowSub}>{item.sub}</span> : null}
        {item.person || chip ? (
          <span className={slots.rowWho}>
            {item.person ? (
              <>
                <PersonInitial name={item.person.name} size={20} />
                <span>{item.person.name}</span>
                {item.person.note ? (
                  <>
                    <span className={slots.dot} aria-hidden="true">
                      ·
                    </span>
                    <span>{item.person.note}</span>
                  </>
                ) : null}
              </>
            ) : null}
            {chip}
          </span>
        ) : null}
      </div>
      <div className={slots.rowProgress}>
        {pct !== null ? (
          <span
            className={cx(slots.bar, item.paused && slots.barPaused)}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            aria-label={item.title}
            aria-valuetext={[item.note, item.noteEnd].filter(Boolean).join(' · ') || `${pct} %`}
          >
            <i style={{ width: `${pct}%` }} />
          </span>
        ) : null}
        {item.note || item.noteEnd ? (
          <span className={slots.times} aria-hidden={pct !== null || undefined}>
            {item.note ? <NoteStart note={item.note} /> : <span />}
            {item.noteEnd ? <span>{item.noteEnd}</span> : null}
          </span>
        ) : null}
        <ThingButtonRow
          items={item.actions}
          buttons={ctx.buttons}
          className={slots.rowActs}
          label={item.title}
        />
      </div>
    </li>
  );
}

/** The width a box has (0 until measured, and where nothing measures: tests). */
function useBoxWidth<E extends HTMLElement>(): [RefObject<E | null>, number] {
  const ref = useRef<E>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

function ShelfView({ panel, ctx }: { panel: GalleryPanel; ctx: DashboardContext }) {
  const [box, width] = useBoxWidth<HTMLDivElement>();
  // The row's inner width: the card's padding is the list's.
  const n = shelfFit(width - 40, panel.items.length);
  return (
    <Card
      title={panel.title}
      meta={panel.meta}
      link={<PanelHead panel={panel} ctx={ctx} />}
      className={styles.galleryCard}
    >
      <div ref={box}>
        {panel.items.length ? (
          <ul
            className={slots.shelf}
            style={
              {
                '--shelf-n': n,
                '--shelf-gap': `${SHELF_GAP}px`,
                '--shelf-min': `${SHELF_MIN}px`,
              } as CSSProperties
            }
          >
            {panel.items.slice(0, n).map((item) => (
              <ShelfItem key={item.id} item={item} shape={panel.shape} ctx={ctx} />
            ))}
          </ul>
        ) : (
          <p className={styles.quiet}>{panel.empty}</p>
        )}
      </div>
    </Card>
  );
}

function ShelfItem({
  item,
  shape,
  ctx,
}: {
  item: ThingGalleryItem;
  shape: GalleryPanel['shape'];
  ctx: DashboardContext;
}) {
  const link = thingItemLink(item);
  const when = !item.sub && item.at ? itemWhen(item.at, ctx.now, ctx.timeZone) : null;
  const tag = item.person ? shelfTag(item.person) : null;
  const body: ReactNode = (
    <>
      <span className={styles.gPic}>
        <Picture
          burrow={ctx.burrow}
          thing={ctx.thing.id}
          image={item.image}
          shape={shape}
          title={item.title}
          muted={item.muted}
          className={slots.shelfPic}
        />
        {item.person && tag ? (
          <span className={slots.tag}>
            <PersonInitial name={item.person.name} size={15} />
            {tag}
          </span>
        ) : null}
        {link?.kind === 'url' ? (
          <span className={styles.gOut} aria-hidden="true">
            <Icon icon={ExternalLink} size={12} />
          </span>
        ) : null}
      </span>
      <span className={slots.shelfTitle}>{item.title}</span>
      {item.sub ? <span className={slots.shelfSub}>{item.sub}</span> : null}
      {when && item.at ? (
        <time className={slots.shelfSub} dateTime={item.at}>
          {when}
        </time>
      ) : null}
    </>
  );
  const named = { 'aria-label': [thingGalleryWords(item), tag].filter(Boolean).join(' · ') };
  return (
    <li className={cx(slots.shelfItem, item.muted && styles.gMuted)} data-item={item.id}>
      {link?.kind === 'href' ? (
        <AppLink href={link.href} className={styles.gLink} {...named}>
          {body}
        </AppLink>
      ) : link?.kind === 'url' ? (
        <a href={link.url} target="_blank" rel="noreferrer" className={styles.gLink} {...named}>
          {body}
        </a>
      ) : (
        <div className={styles.gBody}>{body}</div>
      )}
      <ThingButtonRow
        items={item.actions}
        buttons={ctx.buttons}
        className={styles.gActs}
        label={item.title}
      />
    </li>
  );
}
