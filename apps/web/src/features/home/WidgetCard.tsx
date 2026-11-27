import { Link } from '@tanstack/react-router';
import { widgetChart } from '@whombat/client';
import { useMoveWidget, useRemoveWidget } from '@whombat/client/react';
import type { Widget } from '@whombat/core';
import { Ellipsis, Pin } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useState } from 'react';
import { LineChart } from '../../components/charts';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { useToast } from '../../components/Toast';
import { currentLocale } from '../../i18n/provider';
import { useNow } from '../messaging/useRoom';
import styles from './Home.module.css';

const COLORS = { 1: 'var(--chart1)', 2: 'var(--chart2)', 3: 'var(--chart3)' } as const;

/** The plot's frame and height in mock 1 (`lineChart`: 40 · 10 · 8 · 22, 190px). */
const FRAME = { left: 40, right: 10, top: 8, bottom: 22 } as const;
const HEIGHT = 190;

/**
 * A pinned widget (mock 1; one-whombat.md ONE-09; app one-whombat-shell.md AP-1268): the latest values with their
 * swatches, the day's lines and the line that says it refreshes without the AI. “Open” goes to the chat it was pinned
 * from; the menu (on hover or focus) moves it or unpins it.
 */
export function WidgetCard({
  burrow,
  widget,
  index,
  count,
  timeZone,
  className,
  thing = null,
  now,
}: {
  burrow: string;
  widget: Widget;
  index: number;
  count: number;
  timeZone: string;
  className?: string;
  /** Kept on this thing's page (its thingId; connection-pages.md CP-14): moved and unpinned among that page's. */
  thing?: string | null;
  /** The clock, so the last point says how old it is (“5 min ago · 14:00”), never “Now”. */
  now?: number;
}) {
  const clock = useNow(30_000);
  const at = now ?? clock;
  const model = useMemo(() => widgetChart(widget, timeZone, at, currentLocale()), [widget, timeZone, at]);
  const headId = useId();
  const series = useMemo(
    () =>
      model.lines.map((l) => ({
        key: l.key,
        color: COLORS[l.color],
        values: l.values,
        line: (v: number) => ({
          value: `${Number.isInteger(v) ? v : v.toFixed(1)}`,
          rest: [l.unit, l.label].filter(Boolean).join(' '),
        }),
      })),
    [model],
  );
  const chat = widget.fromConversationId ? `/chats/${widget.fromConversationId}` : null;
  return (
    <section
      className={cx(styles.card, styles.overflowVisible, className)}
      aria-labelledby={headId}
      data-home="widget"
      data-widget={widget.id}
    >
      <header className={styles.head}>
        <h2 id={headId}>{widget.title}</h2>
        {widget.subtitle && <span className={styles.meta}>{widget.subtitle}</span>}
        {chat && (
          <Link to={chat} className={styles.lnk} aria-label={`Open the conversation about ${widget.title}`}>
            Open
          </Link>
        )}
      </header>
      <dl className={styles.widgetHead}>
        {model.lines.map((l) => (
          <div key={l.key} className={styles.wv}>
            <dt className={styles.lbl}>
              <i style={{ background: COLORS[l.color] }} aria-hidden="true" />
              {l.label}
            </dt>
            <dd>
              {l.latest ?? '–'} {l.unit ? <small className={styles.wvUnit}>{l.unit}</small> : null}
            </dd>
          </div>
        ))}
      </dl>
      {widget.problem && <p className={styles.problem}>{widget.problem}</p>}
      <div className={styles.chart}>
        {model.empty ? (
          <p className={styles.quiet}>
            No readings yet. The first come within {Math.ceil(widget.refreshSec / 60)} minutes.
          </p>
        ) : (
          <LineChart
            label={`${widget.title}: ${model.lines.map((l) => `${l.label} ${l.latest ?? 'none'}${l.unit ? ` ${l.unit}` : ''}`).join(', ')}`}
            height={HEIGHT}
            series={series}
            min={model.min}
            max={model.max}
            ticks={model.ticks}
            tickLabel={model.tickLabel}
            timeTicks={model.timeTicks}
            pointLabel={model.pointLabel}
            frame={FRAME}
            look="widget"
          />
        )}
      </div>
      <div className={styles.pinned}>
        <Icon icon={Pin} size={15} />
        <span>{model.footer}</span>
        <WidgetMenu burrow={burrow} widget={widget} index={index} count={count} thing={thing} />
      </div>
    </section>
  );
}

/** Move up, move down, unpin: the widget's menu. */
function WidgetMenu({
  burrow,
  widget,
  index,
  count,
  thing,
}: {
  burrow: string;
  widget: Widget;
  index: number;
  count: number;
  thing: string | null;
}) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const toast = useToast();
  const move = useMoveWidget(burrow, thing);
  const remove = useRemoveWidget(burrow, thing);
  const close = () => setOpen(false);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  const moveTo = (position: number) => {
    close();
    move.mutate({ widgetId: widget.id, position });
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the menu on Esc from inside it
    <div
      className={styles.menuWrap}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        type="button"
        className={styles.menuButton}
        aria-label={`More for ${widget.title}`}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon icon={Ellipsis} size={16} />
      </button>
      {open && (
        <div id={menuId} className={cx(styles.menu, styles.menuUp)}>
          <button
            type="button"
            className={styles.menuItem}
            disabled={index === 0}
            onClick={() => moveTo(index - 1)}
          >
            Move up
          </button>
          <button
            type="button"
            className={styles.menuItem}
            disabled={index >= count - 1}
            onClick={() => moveTo(index + 1)}
          >
            Move down
          </button>
          <button
            type="button"
            className={cx(styles.menuItem, styles.menuItemDanger)}
            onClick={() => {
              close();
              remove.mutate(widget.id, {
                onSuccess: (r) =>
                  toast.show(r.status === 'ok' ? `Unpinned ${widget.title}.` : 'That didn’t work.'),
                onError: () => toast.show('That didn’t work. Try again in a moment.'),
              });
            }}
          >
            {thing ? 'Unpin from this page' : 'Unpin from Connections'}
          </button>
        </div>
      )}
    </div>
  );
}
