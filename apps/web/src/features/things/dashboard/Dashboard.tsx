/**
 * One Summary for every server, connection and device (Whombat dashboards.md DS-01, DS-04; dashboards-web.md
 * AP-2050…; mocks server.png, ha.png, hetzner.png, unraid.png, anatomy.png): the figures and any banner across the
 * width, one or two rows of chart cards (three columns, a wide card spanning two), then a main column (≈ 65 %) and a side
 * column (≈ 35 %) that stack their own panels — nothing stretches beside a long list — then the whole-width panels at
 * the bottom. It follows its own width, not the window's: under 1000 px the side column goes under the main one and
 * chart rows hold two cards, under 640 px one. Where each panel sits is `placePanels` (shared with the phone). A chart a
 * figure names (`figureCharts`, contracts 0.94 CT-449; connections-page.md CN-05, AP-2510) isn't a card: the figure
 * opens it under the figures; a chart no figure names stays a card. A service's settings tab (service-settings.md
 * SST-07, mock service-dash-v2 screen 2) lays its settings cards in two equal columns, between its line of words and
 * its “Something else?”, both across the width.
 */
import { figureCharts, placePanels } from '@whombat/client';
import type { ThingPagePanel } from '@whombat/core';
import { type CSSProperties, useMemo } from 'react';
import { cx } from '../../../components/cx';
import styles from './Dashboard.module.css';
import { chartRowColumns, twoColumnFull } from './layout';
import { type DashboardContext, Panel } from './Panels';

export function Dashboard({ panels, ctx }: { panels: readonly ThingPagePanel[]; ctx: DashboardContext }) {
  // The charts a figure opens are drawn under the figures, not as cards of their own (AP-2510).
  const { open, panels: laid } = useMemo(() => figureCharts(panels), [panels]);
  const placed = useMemo(() => placePanels(laid), [laid]);
  const body = placed.main.length + placed.side.length > 0;
  const settings = laid.some((p) => p.kind === 'settings');
  const look = settings ? ('settings' as const) : undefined;
  return (
    <div className={styles.dash}>
      {placed.top.map((p) => (
        <Panel key={p.id} panel={p} ctx={ctx} charts={open} look={look} />
      ))}
      {placed.chart.map((row) => {
        const spans = row.map((c) => c.span);
        const full = twoColumnFull(spans);
        return (
          <div
            key={row.map((c) => c.panel.id).join(' ')}
            className={styles.row}
            style={{ '--cols': chartRowColumns(spans) } as CSSProperties}
          >
            {row.map((c, i) => (
              <div key={c.panel.id} className={cx(styles.cell, full[i] && styles.cellFull)}>
                <Panel panel={c.panel} ctx={ctx} wide={c.span > 1} />
              </div>
            ))}
          </div>
        );
      })}
      {body ? (
        <div
          className={cx(
            styles.body,
            settings && styles.bodyEven,
            !placed.side.length && styles.bodyMain,
            !placed.main.length && styles.bodySide,
          )}
        >
          {placed.main.length ? (
            <div className={styles.stack}>
              {placed.main.map((p) => (
                <Panel key={p.id} panel={p} ctx={ctx} charts={open} look={look} />
              ))}
            </div>
          ) : null}
          {placed.side.length ? (
            <div className={styles.stack}>
              {placed.side.map((p) => (
                <Panel key={p.id} panel={p} ctx={ctx} charts={open} look={look} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {placed.bottom.map((p) => (
        <Panel key={p.id} panel={p} ctx={ctx} charts={open} look={look} />
      ))}
    </div>
  );
}
