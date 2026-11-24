/**
 * Overview's Connections as the person arranged them (docs/decisions/overview-arranged.md OVA-05, OVA-06): a tile a
 * thing in the layout's order, small, wide or large, its figure large with a line and a chart from its widget's view,
 * else its line from Home as before. Outside arranging a tile is one link to its page; while arranging it has a gear,
 * it can be dragged onto another, and the last tile is *Add to Overview*.
 */
import { BrandMark } from '@whombat/brand/react';
import {
  ARRANGE_WORDS,
  type ArrangedTile,
  type OverviewTile,
  STATUS_LEVEL_WORDS,
  viewFace,
} from '@whombat/client';
import type { DeskWidgetView } from '@whombat/core';
import { Plus, Settings } from 'lucide-react';
import { type DragEvent, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { StatusMark } from '../../components/StatusMark';
import { AppLink } from '../things/parts';
import type { ThingLinkProps } from '../things/prefetch';
import { THING_ICONS } from '../things/thingIcons';
import s from './Arranged.module.css';
import { Spark } from './Spark';

const CHARTS = ['var(--chart1)', 'var(--chart2)', 'var(--chart3)', 'var(--chart4)'] as const;

/** A thing's own colour among the chart colours, the same on every device. */
export function thingColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return CHARTS[h % CHARTS.length] as string;
}

/** “Power now” beside a figure reads “power now”; a name or an abbreviation (“CPU”) keeps its capital. */
const lowerFirst = (t: string) => (/^[A-Z][a-z]/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t);

/** The tile's edge: amber when it needs a look, red when it isn't working. */
function edgeOf(tile: OverviewTile): 'warn' | 'bad' | undefined {
  if (tile.line.tone === 'warn') return 'warn';
  if (tile.line.tone === 'bad') return 'bad';
  return undefined;
}

export function TileLogo({ row, size = 19 }: { row: OverviewTile['row']; size?: number }) {
  return row.mark ? (
    <BrandMark mark={row.mark} size={size} />
  ) : (
    <Icon icon={THING_ICONS[row.glyph]} size={size} />
  );
}

export interface TileCardProps {
  entry: ArrangedTile<OverviewTile>;
  view: DeskWidgetView | undefined;
  editing: boolean;
  /** Drawn in the gear's panel: no link, no gear. */
  preview?: boolean;
  linkProps?: ThingLinkProps;
  onGear?: () => void;
  drag?: {
    over: boolean;
    dragging: boolean;
    onDragStart: (e: DragEvent) => void;
    onDragOver: (e: DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: DragEvent) => void;
    onDragEnd: () => void;
  };
}

export function TileCard({ entry, view, editing, preview = false, linkProps, onGear, drag }: TileCardProps) {
  const { tile, item } = entry;
  const r = item.row;
  // A view that only says it has nothing to show leaves the tile its own line.
  const face = view && !(view.kind === 'text' && !view.problem) ? viewFace(view) : null;
  const shown = face && (face.value || face.line) ? face : null;
  // What isn't fine is said in its colour wherever the tile sits; otherwise the view's own line.
  const notFine = item.line.tone === 'warn' || item.line.tone === 'bad';
  const line =
    notFine || !shown?.line
      ? item.line
      : { text: shown.line, tone: shown.tone === 'warn' ? 'warn' : 'plain' };
  const rows =
    view?.kind === 'list' && tile.size !== 's' ? view.rows.slice(0, tile.size === 'l' ? 6 : 3) : [];
  const own = {
    className: cx(s.tile, drag?.dragging && s.dragging, drag?.over && s.over),
    style: { ['--c' as string]: thingColor(r.id) },
    'data-size': tile.size,
    'data-edge': edgeOf(item),
    'data-thing': r.id,
  };
  const body = (
    <>
      <div className={s.th}>
        <span className={s.tlogo} aria-hidden="true">
          <TileLogo row={r} />
        </span>
        <b>{r.name}</b>
        <span className={s.st}>
          {r.level === 'connected' ? (
            <span className={s.okDot} role="img" aria-label={STATUS_LEVEL_WORDS.connected} />
          ) : (
            <StatusMark level={r.level} label={r.word} />
          )}
        </span>
        {editing && !preview ? (
          <button
            type="button"
            className={s.gear}
            aria-label={ARRANGE_WORDS.changeTile(r.name)}
            onClick={onGear}
          >
            <Icon icon={Settings} size={17} />
          </button>
        ) : null}
      </div>
      {shown?.value ? (
        <div className={s.tv}>
          <span className={s.val} data-tone={shown.tone ?? undefined}>
            {shown.value}
            {shown.unit ? <small>{shown.unit}</small> : null}
          </span>
          <span className={s.what}>{lowerFirst(shown.label)}</span>
        </div>
      ) : null}
      <div className={s.tline} data-tone={line.tone}>
        {line.text}
      </div>
      {rows.length ? (
        <ul className={s.rows}>
          {rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a view's rows in their order
            <li key={i}>
              <span>{row.title}</span>
              {row.time || row.meta ? <span>{row.time ?? row.meta}</span> : null}
            </li>
          ))}
        </ul>
      ) : shown?.spark ? (
        <Spark points={shown.spark} />
      ) : null}
      {item.what || item.used ? (
        <div className={s.tfoot}>
          <span>{item.what ?? ''}</span>
          {item.used ? <span>{item.used}</span> : null}
        </div>
      ) : null}
    </>
  );
  // Outside arranging the whole tile is one link to its page; while arranging it can be picked up and has its gear.
  if (!editing && !preview)
    return (
      <AppLink href={r.href} {...linkProps} {...own} aria-label={item.label}>
        {body}
      </AppLink>
    );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: dragging is for a pointer; the gear's Move earlier and Move later are the keyboard's way
    <div
      {...own}
      draggable={editing && !preview ? true : undefined}
      onDragStart={drag?.onDragStart}
      onDragOver={drag?.onDragOver}
      onDragLeave={drag?.onDragLeave}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onDragEnd}
    >
      {body}
    </div>
  );
}

export interface ArrangedTilesProps {
  shown: readonly ArrangedTile<OverviewTile>[];
  removed: number;
  views: ReadonlyMap<string, DeskWidgetView> | undefined;
  viewId: (tile: ArrangedTile<OverviewTile>['tile']) => string;
  editing: boolean;
  linkProps: (href: string) => ThingLinkProps;
  onGear: (thing: string) => void;
  onAdd: () => void;
  /** A tile dropped on another (or on Add to Overview: `null`, last). */
  onDrop: (thing: string, onto: string | null) => void;
}

export function ArrangedTiles({
  shown,
  removed,
  views,
  viewId,
  editing,
  linkProps,
  onGear,
  onAdd,
  onDrop,
}: ArrangedTilesProps) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const end = () => {
    setDragging(null);
    setOver(null);
  };
  const dropOn = (onto: string | null) => (e: DragEvent) => {
    e.preventDefault();
    const thing = dragging ?? e.dataTransfer.getData('text/plain');
    end();
    if (thing && thing !== onto) onDrop(thing, onto);
  };
  return (
    <div className={s.bento}>
      {shown.map((entry) => {
        const thing = entry.tile.thing;
        return (
          <TileCard
            key={thing}
            entry={entry}
            view={views?.get(viewId(entry.tile))}
            editing={editing}
            linkProps={linkProps(entry.item.row.href)}
            onGear={() => onGear(thing)}
            drag={
              editing
                ? {
                    over: over === thing && dragging !== thing,
                    dragging: dragging === thing,
                    onDragStart: (e) => {
                      setDragging(thing);
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', thing);
                    },
                    onDragOver: (e) => {
                      if (!dragging) return;
                      e.preventDefault();
                      if (over !== thing) setOver(thing);
                    },
                    onDragLeave: () => setOver((o) => (o === thing ? null : o)),
                    onDrop: dropOn(thing),
                    onDragEnd: end,
                  }
                : undefined
            }
          />
        );
      })}
      {editing ? (
        <button
          type="button"
          className={cx(s.add, over === '' && s.over)}
          onClick={onAdd}
          onDragOver={(e) => {
            if (!dragging) return;
            e.preventDefault();
            setOver('');
          }}
          onDragLeave={() => setOver((o) => (o === '' ? null : o))}
          onDrop={dropOn(null)}
        >
          <Icon icon={Plus} size={18} />
          <span>{ARRANGE_WORDS.add}</span>
          <small>{ARRANGE_WORDS.addLine(removed)}</small>
        </button>
      ) : null}
    </div>
  );
}
