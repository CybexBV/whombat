/**
 * The gear's panel (docs/decisions/overview-arranged.md OVA-04): from the right (a sheet from the bottom on a narrow
 * page), for a tile — a live preview, what it shows (its main figures or one panel of its page), its time span, its
 * size, its place and Remove; for a figure at the top — Whombat's own and every thing's figures; for a pinned chart —
 * its width, its place and Remove; and *Add to Overview* — what was removed. Every choice applies and is saved at once.
 */
import { type ArrangedTile, arrangeWords, type OverviewTile, showId, topKey } from '@whombat/client';
import { useOverviewFigures } from '@whombat/client/react';
import {
  type DeskWidgetView,
  OVERVIEW_OWN_FIGURES,
  type OverviewLayoutTop,
  type OverviewPinSize,
  type OverviewRange,
  type OverviewShow,
  type OverviewTileSize,
} from '@whombat/core';
import { Plus, X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../components/Icon';
import { paneFocus } from '../../components/SidePane';
import { useLocaleWords } from '../../i18n/words';
import s from './Arranged.module.css';
import { TileCard, TileLogo } from './ArrangedTiles';

export type PanelTarget =
  | { kind: 'tile'; thing: string }
  | { kind: 'top'; index: number }
  | { kind: 'pin'; id: string }
  | { kind: 'add' };

export interface PanelPin {
  id: string;
  title: string;
  size: OverviewPinSize;
}

export interface ArrangePanelProps {
  burrow: string;
  target: PanelTarget;
  tiles: readonly ArrangedTile<OverviewTile>[];
  removedTiles: readonly ArrangedTile<OverviewTile>[];
  pins: readonly PanelPin[];
  removedPins: readonly { id: string; title: string }[];
  top: readonly OverviewLayoutTop[];
  views: ReadonlyMap<string, DeskWidgetView> | undefined;
  /** Names and logos of the things, for a figure's picker. */
  thingName: (thing: string) => string;
  thingLogo: (thing: string) => ReactNode;
  problem: string | null;
  onShow: (thing: string, show: OverviewShow) => void;
  onRange: (thing: string, range: OverviewRange) => void;
  onSize: (thing: string, size: OverviewTileSize) => void;
  onMoveTile: (thing: string, by: -1 | 1) => void;
  onRemoveTile: (thing: string) => void;
  onAddTile: (thing: string) => void;
  onTop: (index: number, top: OverviewLayoutTop) => void;
  onPinSize: (id: string, size: OverviewPinSize) => void;
  onMovePin: (id: string, by: -1 | 1) => void;
  onRemovePin: (id: string) => void;
  onAddPin: (id: string) => void;
  onClose: () => void;
}

const SHAPES: Record<OverviewTileSize, number[]> = { s: [0], w: [0, 1], l: [0, 1, 2, 3] };

function Shape({ cells }: { cells: number[] }) {
  return (
    <span className={s.shape} aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <i key={i} data-on={cells.includes(i)} />
      ))}
    </span>
  );
}

function Seg<V extends string>({
  label,
  value,
  items,
  onPick,
}: {
  label: string;
  value: V;
  items: readonly { v: V; text: string; glyph?: ReactNode }[];
  onPick: (v: V) => void;
}) {
  return (
    <fieldset className={s.dseg} aria-label={label}>
      {items.map((it) => (
        <button key={it.v} type="button" aria-pressed={value === it.v} onClick={() => onPick(it.v)}>
          {it.glyph}
          <span>{it.text}</span>
        </button>
      ))}
    </fieldset>
  );
}

function Head({
  logo,
  title,
  sub,
  onClose,
}: {
  logo: ReactNode;
  title: string;
  sub: string;
  onClose: () => void;
}) {
  const words = useLocaleWords(arrangeWords);
  return (
    <header className={s.drh}>
      <span className={s.tlogo} aria-hidden="true">
        {logo}
      </span>
      <div>
        <h2 id="arrange-panel-title">{title}</h2>
        <small>{sub}</small>
      </div>
      <button type="button" className={s.x} aria-label={words.close} onClick={onClose}>
        <Icon icon={X} size={18} />
      </button>
    </header>
  );
}

function Moves({ index, count, onMove }: { index: number; count: number; onMove: (by: -1 | 1) => void }) {
  const words = useLocaleWords(arrangeWords);
  return (
    <>
      <h3>{words.place}</h3>
      <div className={s.moves}>
        <button type="button" className={s.ghost} disabled={index <= 0} onClick={() => onMove(-1)}>
          {words.earlier}
        </button>
        <button type="button" className={s.ghost} disabled={index >= count - 1} onClick={() => onMove(1)}>
          {words.later}
        </button>
      </div>
    </>
  );
}

/** Whether what a view shows has a line over time, so its time span means something. */
const hasTime = (v: DeskWidgetView | undefined) =>
  !!v && (v.kind === 'chart' || ((v.kind === 'figures' || v.kind === 'server') && !!v.spark?.length));

function TileBody(p: ArrangePanelProps & { target: { kind: 'tile'; thing: string } }) {
  const words = useLocaleWords(arrangeWords);
  const index = p.tiles.findIndex((t) => t.tile.thing === p.target.thing);
  const entry = p.tiles[index];
  const figures = useOverviewFigures(p.burrow, p.target.thing, !!entry);
  if (!entry) return null;
  const { tile, item } = entry;
  const view = p.views?.get(showId(tile));
  const items = (figures.data?.groups ?? [])
    .flatMap((g) => g.items)
    .filter((i) => i.type === 'figures' || i.type === 'panel');
  return (
    <>
      <Head
        logo={<TileLogo row={item.row} size={22} />}
        title={item.row.name}
        sub={words.changeTile(item.row.name)}
        onClose={p.onClose}
      />
      <div className={s.prev}>
        <div className={s.bento}>
          <TileCard entry={entry} view={view} editing preview />
        </div>
      </div>
      <h3>{words.shows}</h3>
      <div className={s.opts}>
        {figures.isPending ? (
          <p className={s.empty}>{words.reading}</p>
        ) : figures.isError ? (
          <p className={s.empty}>{words.couldntRead}</p>
        ) : (
          (items.length
            ? items
            : [{ type: 'figures' as const, opts: {}, name: words.mainFigures, line: '' }]
          ).map((it) => {
            const panel = it.type === 'panel' ? it.opts.panel : undefined;
            const on = (tile.panel ?? undefined) === panel;
            return (
              <button
                key={`${it.type}:${panel ?? ''}`}
                type="button"
                className={s.opt}
                aria-pressed={on}
                onClick={() =>
                  p.onShow(tile.thing, {
                    ...(panel ? { panel } : {}),
                    ...(tile.range ? { range: tile.range } : {}),
                  })
                }
              >
                <span>
                  {it.name}
                  {it.line ? <small>{it.line}</small> : null}
                </span>
              </button>
            );
          })
        )}
      </div>
      {hasTime(view) ? (
        <>
          <h3>{words.span}</h3>
          <Seg
            label={words.span}
            value={tile.range ?? '24h'}
            items={(['1h', '24h', '7d'] as const).map((v) => ({ v, text: words.ranges[v] }))}
            onPick={(v) => p.onRange(tile.thing, v)}
          />
        </>
      ) : null}
      <h3>{words.size}</h3>
      <Seg
        label={words.size}
        value={tile.size}
        items={(['s', 'w', 'l'] as const).map((v) => ({
          v,
          text: words.sizes[v],
          glyph: <Shape cells={SHAPES[v]} />,
        }))}
        onPick={(v) => p.onSize(tile.thing, v)}
      />
      <Moves index={index} count={p.tiles.length} onMove={(by) => p.onMoveTile(tile.thing, by)} />
      <Foot {...p} remove={() => p.onRemoveTile(tile.thing)} />
    </>
  );
}

function TopBody(p: ArrangePanelProps & { target: { kind: 'top'; index: number } }) {
  const words = useLocaleWords(arrangeWords);
  const figures = useOverviewFigures(p.burrow, null);
  const current = p.top[p.target.index];
  const taken = new Set(p.top.filter((_, i) => i !== p.target.index).map(topKey));
  const option = (top: OverviewLayoutTop, name: string, line: string | null) => {
    const key = topKey(top);
    const on = current ? topKey(current) === key : false;
    return (
      <button
        key={key}
        type="button"
        className={s.opt}
        aria-pressed={on}
        disabled={taken.has(key)}
        onClick={() => p.onTop(p.target.index, top)}
      >
        <span>
          {name}
          {taken.has(key) ? <small>{words.shownAlready}</small> : line ? <small>{line}</small> : null}
        </span>
      </button>
    );
  };
  return (
    <>
      <Head
        logo={<Icon icon={Plus} size={20} />}
        title={words.figureTitle}
        sub={words.figureSub(p.target.index + 1)}
        onClose={p.onClose}
      />
      <h3>{words.shows}</h3>
      <div className={s.grp}>{words.own}</div>
      <div className={s.opts}>
        {OVERVIEW_OWN_FIGURES.map((own) => option({ own }, words.ownNames[own], null))}
      </div>
      {figures.isPending ? <p className={s.empty}>{words.reading}</p> : null}
      {figures.isError ? <p className={s.empty}>{words.couldntRead}</p> : null}
      {(figures.data?.groups ?? [])
        .filter((g) => g.thing)
        .map((g) => {
          const thing = g.thing as string;
          const items = g.items.filter((i) => i.type === 'figures' || i.type === 'panel');
          if (!items.length) return null;
          return (
            <div key={g.key} className={s.opts}>
              <div className={s.grp}>
                <span className={s.mini} aria-hidden="true">
                  {p.thingLogo(thing)}
                </span>
                {g.label || p.thingName(thing)}
              </div>
              {items.map((it) =>
                option(
                  { thing, ...(it.type === 'panel' && it.opts.panel ? { panel: it.opts.panel } : {}) },
                  it.name,
                  it.line,
                ),
              )}
            </div>
          );
        })}
      <Foot {...p} />
    </>
  );
}

function PinBody(p: ArrangePanelProps & { target: { kind: 'pin'; id: string } }) {
  const words = useLocaleWords(arrangeWords);
  const index = p.pins.findIndex((x) => x.id === p.target.id);
  const pin = p.pins[index];
  if (!pin) return null;
  return (
    <>
      <Head logo={<Icon icon={Plus} size={20} />} title={pin.title} sub={words.pinSub} onClose={p.onClose} />
      <h3>{words.width}</h3>
      <Seg
        label={words.width}
        value={pin.size}
        items={(['half', 'full'] as const).map((v) => ({
          v,
          text: words.pinSizes[v],
          glyph: <Shape cells={v === 'half' ? [0] : [0, 1]} />,
        }))}
        onPick={(v) => p.onPinSize(pin.id, v)}
      />
      <Moves index={index} count={p.pins.length} onMove={(by) => p.onMovePin(pin.id, by)} />
      <Foot {...p} remove={() => p.onRemovePin(pin.id)} />
    </>
  );
}

function AddBody(p: ArrangePanelProps) {
  const words = useLocaleWords(arrangeWords);
  const none = !p.removedTiles.length && !p.removedPins.length;
  return (
    <>
      <Head logo={<Icon icon={Plus} size={20} />} title={words.add} sub={words.same} onClose={p.onClose} />
      {none ? <p className={s.empty}>{words.addEmpty}</p> : null}
      {p.removedTiles.length ? (
        <>
          <h3>{words.addTiles}</h3>
          <div className={s.opts}>
            {p.removedTiles.map(({ item }) => (
              <button
                key={item.row.id}
                type="button"
                className={s.opt}
                onClick={() => p.onAddTile(item.row.id)}
              >
                <span className={s.grp}>
                  <span className={s.mini} aria-hidden="true">
                    <TileLogo row={item.row} size={14} />
                  </span>
                  {item.row.name}
                </span>
                <Icon icon={Plus} size={16} />
              </button>
            ))}
          </div>
        </>
      ) : null}
      {p.removedPins.length ? (
        <>
          <h3>{words.addPins}</h3>
          <div className={s.opts}>
            {p.removedPins.map((pin) => (
              <button key={pin.id} type="button" className={s.opt} onClick={() => p.onAddPin(pin.id)}>
                <span>{pin.title}</span>
                <Icon icon={Plus} size={16} />
              </button>
            ))}
          </div>
        </>
      ) : null}
      <Foot {...p} />
    </>
  );
}

function Foot({
  onClose,
  problem,
  remove,
}: Pick<ArrangePanelProps, 'onClose' | 'problem'> & { remove?: () => void }) {
  const words = useLocaleWords(arrangeWords);
  return (
    <>
      <div className={s.foot}>
        {remove ? (
          <button type="button" className={s.danger} onClick={remove}>
            {words.remove}
          </button>
        ) : null}
        <button type="button" className={s.btn} onClick={onClose}>
          {words.done}
        </button>
      </div>
      {problem ? (
        <p className={`${s.fine} ${s.problem}`} role="alert">
          {problem}
        </p>
      ) : (
        <p className={s.fine}>{words.same}</p>
      )}
    </>
  );
}

export function ArrangePanel(props: ArrangePanelProps) {
  const ref = useRef<HTMLElement>(null);
  const { target } = props;
  // Focus moves into the panel when it opens and back to the gear when it closes.
  useEffect(() => {
    const pane = ref.current;
    return pane ? paneFocus(pane) : undefined;
  }, []);
  const body =
    target.kind === 'tile' ? (
      <TileBody {...props} target={target} />
    ) : target.kind === 'top' ? (
      <TopBody {...props} target={target} />
    ) : target.kind === 'pin' ? (
      <PinBody {...props} target={target} />
    ) : (
      <AddBody {...props} />
    );
  return createPortal(
    <>
      <div className={s.scrim} onClick={props.onClose} aria-hidden="true" />
      <aside
        ref={ref}
        className={s.drawer}
        role="dialog"
        aria-modal="true"
        aria-labelledby="arrange-panel-title"
        data-arrange-panel={target.kind}
      >
        {body}
      </aside>
    </>,
    document.body,
  );
}
