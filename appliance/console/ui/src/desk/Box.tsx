/**
 * This Whombat (DK-22, DK-39, DK-87, mockup `new-box.html`, CG-57…, CG-138, CG-259): the box's own figures as the panel
 * under the servers and tiles when it fits, else as a card first among the servers; either opens its own screen. The runtime writes every figure and unit;
 * the page draws them. A short panel (Working on or Done today showing too) keeps the figures and drops the chart
 * (CG-59).
 */
import { WhombatLogo } from '@whombat/brand/react';
import { type ReactNode, useId } from 'react';
import type { DeskBox } from '../lib/desk';
import {
  CHART_H,
  CHART_W,
  chartLine,
  chartTop,
  storageBar,
  TEMP_MAX,
  TEMP_SEGMENTS,
  tempLit,
} from '../lib/deskBox';
import { DESK_WORDS, degrees, fill } from '../lib/deskCopy';
import styles from './desk.module.css';
import { Icon } from './icons';
import { CardLines, cardLabel, OpenCard, PageHead } from './parts';

const W = DESK_WORDS.box;

/** A figure drawn big with its small unit (“812” “GB free”). */
function Figure({ value, unit }: { value: string | number; unit: string }) {
  return (
    <div className={styles.figValue}>
      {value}
      <small className={styles.figUnit}>{unit}</small>
    </div>
  );
}

/**
 * The processor's and the memory's lines against `top` (CG-58), over `spanS` ending now: This Whombat's last hour, and a
 * server's hour, day or week (DK-83, CG-260).
 */
export function SeriesChart({
  cpu,
  memory,
  stepS,
  spanS = 3600,
  top,
}: {
  cpu: (number | null)[];
  memory: (number | null)[];
  stepS: number;
  spanS?: number;
  top: number;
}) {
  const id = useId().replace(/[^A-Za-z0-9_-]/g, '');
  const series = [
    { key: 'cpu', points: cpu, className: styles.lineCpu },
    { key: 'memory', points: memory, className: styles.lineMemory },
  ] as const;
  return (
    <div className={styles.chart} aria-hidden="true">
      <svg
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {[0.25, 0.5, 0.75, 1].map((q) => (
          <line
            key={q}
            className={styles.chartGrid}
            x1="0"
            x2={CHART_W}
            y1={CHART_H - q * CHART_H}
            y2={CHART_H - q * CHART_H}
          />
        ))}
        {series.map((s) => {
          const { line, area } = chartLine(s.points, stepS, top, spanS);
          return (
            <g key={s.key} className={s.className}>
              <defs>
                <linearGradient id={`${id}${s.key}`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" className={styles.fadeTop} />
                  <stop offset="1" className={styles.fadeBottom} />
                </linearGradient>
              </defs>
              {area && <path d={area} fill={`url(#${id}${s.key})`} />}
              {line && <path d={line} className={styles.chartLine} />}
            </g>
          );
        })}
      </svg>
      <span className={styles.chartScale} style={{ top: 0 }}>
        {fill(W.scale, { n: top })}
      </span>
      <span className={styles.chartScale} style={{ top: '50%' }}>
        {fill(W.scale, { n: top / 2 })}
      </span>
    </div>
  );
}

/** The last hour of the processor and the memory, against the smallest top that holds it (CG-58). */
function Chart({ box }: { box: DeskBox }) {
  return (
    <SeriesChart
      cpu={box.history.cpu}
      memory={box.history.memory}
      stepS={box.history.stepS}
      top={chartTop(box)}
    />
  );
}

function LastHour({ box }: { box: DeskBox }) {
  return (
    <div className={`${styles.fig} ${styles.figHour}`}>
      <span className={styles.figKey}>{W.lastHour}</span>
      <div className={styles.duo}>
        {/* A busy processor or full memory shows in the figure's colour, as the server cards' meters (DK-24). */}
        <div data-tone={box.cpu.tone}>
          <Figure value={box.cpu.percent} unit="%" />
          <span className={styles.figNote}>
            <i className={styles.swatch} data-line="cpu" />
            {fill(W.processor, { n: box.cpu.cores })}
          </span>
        </div>
        <div data-tone={box.memory.tone}>
          <Figure value={box.memory.used.value} unit={box.memory.used.unit} />
          <span className={styles.figNote}>
            <i className={styles.swatch} data-line="memory" />
            {fill(W.memory, { total: box.memory.total })}
          </span>
        </div>
      </div>
      <Chart box={box} />
      <div className={`${styles.figFoot} ${styles.chartFoot}`}>
        <span>{W.hourAgo}</span>
        <span>{W.now}</span>
      </div>
    </div>
  );
}

function Storage({ storage, assistant }: { storage: DeskBox['storage']; assistant: string }) {
  return (
    <div className={styles.fig} data-tone={storage.tone}>
      <div className={styles.figRow}>
        <span className={styles.figKey}>{W.storage}</span>
        <span className={styles.figNote} data-tone={storage.tone}>
          {fill(W.used, { n: storage.percent })}
        </span>
      </div>
      <Figure value={storage.free.value} unit={fill(W.free, { unit: storage.free.unit })} />
      <div className={styles.stack} aria-hidden="true">
        {storageBar(storage).map((p) => (
          <i key={p.key} data-part={p.key} style={{ width: `${p.percent}%` }} />
        ))}
      </div>
      <div className={styles.figFoot}>
        <span>
          {storage.parts.map((p, i) => (
            <span key={p.key}>
              {i > 0 && ' · '}
              <b>{fill(W.parts[p.key], { assistant })}</b> {p.value}
            </span>
          ))}
        </span>
        <span>{fill(W.ofTotal, { total: storage.total })}</span>
      </div>
    </div>
  );
}

function Temperature({ temp }: { temp: NonNullable<DeskBox['temp']> }) {
  const lit = tempLit(temp.value);
  return (
    <div className={styles.fig} data-tone={temp.tone}>
      <div className={styles.figRow}>
        <span className={styles.figKey}>{W.temperature}</span>
        <span className={styles.figNote} data-tone={temp.tone}>
          {fill(W.tempNote, { tone: W.tones[temp.tone] })}
        </span>
      </div>
      <Figure value={temp.value} unit="°C" />
      <div className={`${styles.seg} ${styles.figSeg}`} data-tone={temp.tone} aria-hidden="true">
        {Array.from({ length: TEMP_SEGMENTS }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: thirty fixed segments
          <i key={i} data-on={i < lit || undefined} />
        ))}
      </div>
      <div className={styles.figFoot}>
        <span>{degrees(0)}</span>
        <span>{degrees(TEMP_MAX)}</span>
      </div>
    </div>
  );
}

/**
 * This Whombat's panel. `assistant`: the agent's name, its storage part's. `hint`: the new box's “Your servers and home
 * show here once you connect them.” (not beside servers or tiles). `onOpen`: touching it opens This Whombat's own
 * screen (DK-87), through a button over the whole panel. `page`: the panel on that screen, without its head (the page's
 * header has it).
 */
export function Box({
  box,
  assistant,
  hint = true,
  onOpen,
  page = false,
}: {
  box: DeskBox;
  assistant: string;
  hint?: boolean;
  onOpen?: () => void;
  page?: boolean;
}) {
  return (
    <section className={`${styles.card} ${styles.box}`} aria-label={W.title} data-page={page || undefined}>
      {!page && (
        <div className={styles.boxHead}>
          <span className={styles.boxLogo}>
            {/* 18 layout px, 36 on the Z13: the brand's full face, as the top bar's (CG-41). */}
            <WhombatLogo variant="symbol" height={36} style={{ width: 22, height: 18 }} />
          </span>
          <b className={styles.boxTitle}>{W.title}</b>
          <div className={styles.spacer} />
          {box.up && <span className={styles.boxUp}>{box.up}</span>}
        </div>
      )}
      <div className={styles.figsBox}>
        <div className={styles.figs}>
          <LastHour box={box} />
          <div className={styles.side}>
            <Storage storage={box.storage} assistant={assistant} />
            {box.temp && <Temperature temp={box.temp} />}
          </div>
        </div>
      </div>
      <div className={styles.boxFoot}>
        {box.network && (
          <div className={styles.boxNet}>
            <Icon name="updown" />
            {fill(W.network, { down: box.network.down, up: box.network.up })}
          </div>
        )}
        {hint && <div className={styles.boxHint}>{W.hint}</div>}
      </div>
      {onOpen && (
        <button
          type="button"
          className={styles.boxOpen}
          aria-label={fill(DESK_WORDS.card.open, { name: W.title })}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
        />
      )}
    </section>
  );
}

/**
 * This Whombat as a card (DK-39, DK-87): a server card's head and its three lines, the logo in the mark tile, how long
 * it has been up, the processor, the memory and the data disk; it opens This Whombat's own screen.
 */
export function BoxCard({ box, onOpen }: { box: DeskBox; onOpen?: () => void }) {
  const figures = {
    cpu: { value: box.cpu.percent, tone: box.cpu.tone },
    memory: { value: box.memory.percent, tone: box.memory.tone },
    disk: { value: box.storage.percent, tone: box.storage.tone },
  };
  return (
    <OpenCard
      className={`${styles.card} ${styles.server} ${styles.self}`}
      label={cardLabel(W.title, box.up, figures)}
      onOpen={onOpen}
    >
      <span className={styles.serverHead}>
        <span className={styles.markTile}>
          {/* The panel's full face (CG-57), at the mockup's 20×16. */}
          <WhombatLogo variant="symbol" height={36} style={{ width: 20, height: 16 }} />
        </span>
        <b className={styles.serverName}>{W.title}</b>
        {box.up && <span className={styles.serverNote}>{box.up}</span>}
      </span>
      <CardLines {...figures} />
    </OpenCard>
  );
}

/** This Whombat's own screen (DK-87, CG-259): its panel at full size, under a page's header with Back. */
export function SelfScreen({
  box,
  assistant,
  lock,
  onBack,
}: {
  box: DeskBox;
  assistant: string;
  lock: ReactNode;
  onBack: () => void;
}) {
  return (
    <div className={styles.page} data-page="self">
      <div className={styles.pageBody}>
        <PageHead
          mark={<WhombatLogo variant="symbol" height={48} style={{ width: 30, height: 24 }} />}
          title={W.title}
          sub={box.up}
          onBack={onBack}
        >
          {lock}
        </PageHead>
        <Box box={box} assistant={assistant} hint={false} page />
      </div>
    </div>
  );
}
