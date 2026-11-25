/**
 * Worth a look as a slim strip on top of a service's Summary (Whombat service-slots.md SLT-08; app
 * service-slots-web.md; docs/decisions/ui-refresh-chat.md): a `notices` panel placed `top`. A quiet header band with its
 * label, then plain rows: what is wrong now first (the worst first), then quiet lines (greyed, with Undo), and the
 * heads-ups — what comes later or is advice — folded behind their own “Show N heads-ups”, not counted with the problems
 * (docs/decisions/overview-server-connection-final.md). One row is its icon on a tile of its tone, the title with its
 * detail, at most one way forward — “Ask {assistant}” or “Show” — its own button and the quiet ⋯ menu. Five of now
 * show, the rest behind “Show N more”. Two or more lines that ask get the one button that hands them to the assistant.
 * A strip with no line draws nothing: the server leaves it out then.
 */
import {
  handleTheseView,
  KEEP_QUIET_WORDS,
  NEEDS_YOU_WORDS,
  noticeLink,
  quietLineText,
} from '@whombat/client';
import { useTheAgent } from '@whombat/client/react';
import type { ThingPageLink, ThingPageNotice, ThingPagePanel } from '@whombat/core';
import { Info } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { NoticeMenu, QuietUndo } from '../quiet/NoticeMenu';
import things from '../Things.module.css';
import { NOTICE_ICONS } from '../thingIcons';
import { ThingButton } from './Buttons';
import { type DashboardContext, lineExtras, PageLink } from './Panels';
import styles from './Slots.module.css';
import { stripLines } from './slots';

type NoticesPanel = Extract<ThingPagePanel, { kind: 'notices' }>;

const TILE_TONES: Record<ThingPageNotice['tone'], string | undefined> = {
  bad: styles.tileBad,
  warn: styles.tileWarn,
  info: styles.tileInfo,
};

/** What a screen reader hears before a line's title: how serious it is (the tile's colour says it to the eye). */
const TONE_WORDS: Record<ThingPageNotice['tone'], string> = {
  bad: 'Problem: ',
  warn: 'Needs a look: ',
  info: '',
};

/** The words of a row's way forward: only “Ask {assistant}” or “Show”, whatever the line's own label. */
function rowLink(link: ThingPageLink, ask: string): ThingPageLink {
  return { ...link, label: link.kind === 'ask' ? ask : 'Show' };
}

export function NoticeStrip({ panel, ctx }: { panel: NoticesPanel; ctx: DashboardContext }) {
  const [open, setOpen] = useState(false);
  const [headsUps, setHeadsUps] = useState(false);
  const [kept, setKept] = useState(false);
  const { words } = useTheAgent(ctx.burrow);
  const strip = stripLines(panel.items);
  if (!strip.lines.length) return null;
  const all = handleTheseView(strip.asking, ctx.research, ctx.thing.name, words.name);
  const title = panel.title || 'Worth a look';
  const visible = new Set([
    ...(open ? [...strip.now, ...strip.quiet] : strip.shown),
    ...(headsUps ? strip.soon : []),
  ]);
  const line = (n: ThingPageNotice) => {
    const found = noticeLink(n, words.ask);
    const link = found ? rowLink(found, words.ask) : undefined;
    const quiet = quietLineText(n);
    return (
      <li
        key={n.id}
        className={cx(styles.stripLine, quiet && styles.stripLineQuiet)}
        data-notice={n.id}
        data-quiet={quiet ? n.quiet?.state : undefined}
      >
        <span className={cx(styles.tile, quiet ? styles.tileQuiet : TILE_TONES[n.tone])} aria-hidden="true">
          <Icon icon={NOTICE_ICONS[n.icon] ?? Info} size={18} />
        </span>
        <p className={styles.stripText}>
          <b>
            {!quiet && TONE_WORDS[n.tone] ? (
              <span className={things.srOnly}>{TONE_WORDS[n.tone]}</span>
            ) : null}
            {n.title}
          </b>
          {quiet ? <> {quiet}</> : n.detail ? <> {n.detail}</> : null}
        </p>
        <div className={styles.stripActs}>
          {link && !quiet ? (
            <PageLink link={link} ctx={ctx} look="button" className={styles.stripButton} />
          ) : null}
          {n.action && !quiet ? <ThingButton button={n.action} buttons={ctx.buttons} /> : null}
          {quiet ? (
            <QuietUndo line={n} actions={ctx.quiet} onEnd={ctx.endQuiet} ending={ctx.endingQuiet} />
          ) : (
            <NoticeMenu line={n} actions={ctx.quiet} extra={lineExtras(n, ctx)} />
          )}
        </div>
      </li>
    );
  };
  const now = strip.now.filter((n) => visible.has(n));
  const soon = strip.soon.filter((n) => visible.has(n));
  const quiet = strip.quiet.filter((n) => visible.has(n));
  return (
    <section className={styles.strip} aria-label={title} data-strip={panel.id}>
      {/* The region is named by it already: a band, not a heading of its own. */}
      <div className={styles.stripHead} aria-hidden="true">
        {title}
      </div>
      {now.length ? <ul className={styles.stripLines}>{now.map(line)}</ul> : null}
      {strip.soon.length ? (
        // The heads-ups fold under one row and aren't counted: routine news doesn't bury what needs the person.
        <button
          type="button"
          className={cx(styles.stripMore, styles.stripHeadsUps)}
          aria-expanded={headsUps}
          onClick={() => setHeadsUps((o) => !o)}
        >
          {headsUps ? NEEDS_YOU_WORDS.hideHeadsUps : NEEDS_YOU_WORDS.showHeadsUps(strip.soon.length)}
        </button>
      ) : null}
      {soon.length ? <ul className={styles.stripLines}>{soon.map(line)}</ul> : null}
      {quiet.length ? <ul className={styles.stripLines}>{quiet.map(line)}</ul> : null}
      {strip.held.length ? (
        // Quiet with the whole thing: the line under the page's head says why, so they fold under one row.
        <button
          type="button"
          className={cx(styles.stripMore, styles.stripHeadsUps)}
          aria-expanded={kept}
          onClick={() => setKept((o) => !o)}
        >
          {kept ? KEEP_QUIET_WORDS.hideHeld : KEEP_QUIET_WORDS.showHeld(strip.held.length)}
        </button>
      ) : null}
      {kept && strip.held.length ? <ul className={styles.stripLines}>{strip.held.map(line)}</ul> : null}
      {strip.more > 0 || all?.label || all?.busy ? (
        <div className={styles.stripFoot}>
          {strip.more > 0 ? (
            <button
              type="button"
              className={styles.stripMore}
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Show fewer' : `Show ${strip.more} more`}
            </button>
          ) : null}
          {all?.label ? (
            <Button
              size="sm"
              variant="primary"
              className={styles.stripHandle}
              onClick={() =>
                ctx.onHandle ? ctx.onHandle(all.fallback.question) : ctx.onAsk(all.fallback.question)
              }
            >
              {all.label}
            </Button>
          ) : all?.busy ? (
            <span className={styles.stripBusy} role="status">
              {all.busy}
            </span>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
