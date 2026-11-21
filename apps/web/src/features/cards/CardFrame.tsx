import {
  CARD_FRAME_WORDS,
  type CardFrame as CardFrameData,
  type CardMark,
  MOVED_CARD_WORDS,
} from '@whombat/client';
import { formatClock } from '@whombat/core';
import { ArrowUpRight, Check, ChevronDown } from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { RichText } from '../messaging/RichText';
import styles from './Card.module.css';
import f from './CardFrame.module.css';
import { useCardStill, useCardTimeZone } from './cardLook';

/** Where cards start folded: a phone's width (the body opens in place with Show more). */
const FOLDS_AT = '(max-width: 640px)';

function startsFolded(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.(FOLDS_AT).matches;
  } catch {
    return false;
  }
}

/**
 * The status line's mark, by shape (colour never says it alone): a filled dot waiting for the person, an open ring at
 * work, the branch arrow handed over, a tick done, a square stopped, a ring with a bar where it didn't finish, a hollow
 * circle not started.
 */
export function CardStatusMark({ mark }: { mark: CardMark }) {
  if (mark === 'handedOver') return <Icon icon={ArrowUpRight} size={13} className={f.markIcon} />;
  if (mark === 'done') return <Icon icon={Check} size={13} className={f.markIcon} />;
  return <span className={f.mark} data-mark={mark} aria-hidden="true" />;
}

export interface CardFrameProps {
  /** `data-card` of the section (“plan”, “council”, …). */
  card: string;
  frame: CardFrameData;
  /** Show “ · Council” after the status word; a plan's title says what it is. */
  showKind?: boolean;
  /** What always shows between the sentence and the buttons (a checklist's ticks, a run's bar). */
  content?: ReactNode;
  /** The main button first, then at most two others, always in this place under the sentence. */
  actions?: ReactNode;
  /** What opens in place under the actions (a plan's steps); folded at a phone's width at first. */
  body?: ReactNode;
  /** Every technical word, under one Details at the card's end. */
  details?: ReactNode;
  /** Details opened from outside (“Read the answers”, “Open tasks”). */
  detailsOpen?: boolean;
  /** False: the main button is Details' only way open and shut (a finished council's “Read the answers”). */
  detailsToggle?: boolean;
  onDetailsToggle?: (open: boolean) => void;
  /** Under everything, outside Details (a press that didn't go through, a confirmation). */
  after?: ReactNode;
  /** Under the title, before the sentence: where the work is (a council's five steps). */
  track?: ReactNode;
  /** At the status line's end, after the time: the card's ⋯ menu. */
  menu?: ReactNode;
  /** The quiet end of the card's last line, across from Details: a rare action (Stop) that stays out of the way. */
  foot?: ReactNode;
  className?: string;
  /** Extra attributes of the section (`data-stage`, `data-status`). */
  data?: Record<`data-${string}`, string | undefined>;
}

/**
 * One layout for the cards in a thread (docs/decisions/chat-threads-cards.md): a status line (mark, word, time), a plain
 * title, a headline and one sentence, the main button with at most two others in a fixed place, what opens in place
 * (folded on a phone, with Show more / Show less), and the technical words under one Details.
 */
export function CardFrame({
  card,
  frame,
  showKind = true,
  content,
  actions: ownActions,
  body,
  details: ownDetailsBody,
  detailsOpen,
  detailsToggle = true,
  onDetailsToggle,
  after: ownAfter,
  track,
  menu: ownMenu,
  foot: ownFoot,
  className,
  data,
}: CardFrameProps) {
  const timeZone = useCardTimeZone();
  // The card as it was earlier: what it said, without anything to press.
  const still = useCardStill();
  const actions = still ? undefined : ownActions;
  const menu = still ? undefined : ownMenu;
  const foot = still ? undefined : ownFoot;
  const after = still ? undefined : ownAfter;
  const details = still ? undefined : ownDetailsBody;
  const bodyId = useId();
  const detailsId = useId();
  const [folded, setFolded] = useState(startsFolded);
  const [ownDetails, setOwnDetails] = useState(false);
  const open = detailsOpen ?? ownDetails;
  return (
    <section
      className={cx(styles.card, f.card, className)}
      aria-label={frame.label}
      data-card={card}
      data-mark={frame.mark}
      data-folded={(!!body && folded && !still) || undefined}
      data-still={still || undefined}
      {...data}
    >
      <div className={f.status}>
        {!still && <CardStatusMark mark={frame.mark} />}
        <span className={f.word} data-mark={still ? undefined : frame.mark}>
          {still ? MOVED_CARD_WORDS.earlierWord : frame.word}
          {showKind && <span className={f.kind}> · {frame.kind}</span>}
        </span>
        {frame.at && (
          <time className={f.time} dateTime={frame.at}>
            {formatClock(frame.at, timeZone)}
          </time>
        )}
        {menu && <span className={cx(f.menu, !frame.at && f.menuAlone)}>{menu}</span>}
      </div>
      <h3 className={f.title}>{frame.title}</h3>
      {frame.changed && (
        <p className={f.changed} data-card-changed="">
          {frame.changed}
        </p>
      )}
      {track}
      {frame.headline && <p className={f.headline}>{frame.headline}</p>}
      {frame.sentence && (
        <RichText text={frame.sentence} className={cx(f.sentence, !!body && folded && f.clamp)} />
      )}
      {content}
      {actions && <div className={f.actions}>{actions}</div>}
      {body && still ? (
        <div className={f.body}>{body}</div>
      ) : body ? (
        <>
          <button
            type="button"
            className={f.fold}
            aria-expanded={!folded}
            aria-controls={bodyId}
            onClick={() => setFolded((v) => !v)}
            data-card-fold=""
          >
            <Icon icon={ChevronDown} size={14} className={cx(f.chevron, !folded && f.chevronOpen)} />
            {folded ? CARD_FRAME_WORDS.showMore : CARD_FRAME_WORDS.showLess}
          </button>
          <div id={bodyId} className={f.body} hidden={folded}>
            {!folded && body}
          </div>
        </>
      ) : null}
      {details && (!body || !folded) ? (
        <div className={f.details} data-card-details="" data-open={open || undefined}>
          {!detailsToggle ? (
            foot ? (
              <div className={f.footRow}>
                <span className={f.foot}>{foot}</span>
              </div>
            ) : null
          ) : (
            <div className={f.footRow}>
              {/* Its own state, so a button elsewhere (Read the answers, Open tasks) can open it too. */}
              <button
                type="button"
                className={f.summary}
                aria-expanded={open}
                aria-controls={detailsId}
                onClick={() => {
                  setOwnDetails(!open);
                  onDetailsToggle?.(!open);
                }}
              >
                <Icon icon={ChevronDown} size={14} className={cx(f.chevron, open && f.chevronOpen)} />
                {CARD_FRAME_WORDS.details}
              </button>
              {foot && <span className={f.foot}>{foot}</span>}
            </div>
          )}
          <div id={detailsId} className={f.detailsBody} hidden={!open}>
            {open && details}
          </div>
        </div>
      ) : foot ? (
        <div className={f.footRow}>
          <span className={f.foot}>{foot}</span>
        </div>
      ) : null}
      {after}
    </section>
  );
}

/** A card's button: the main one filled, the others outlined; 44px tall at a phone's width. */
export function FrameButton({
  main = false,
  className,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { main?: boolean }) {
  return <button type="button" className={cx(f.button, main ? f.main : f.other, className)} {...rest} />;
}

/** A live card's ⋯ menu, named after its card so two cards in a thread aren't both “More”. */
export const cardMenuLabel = (title: string) => `More for “${title}”`;

/**
 * A quiet action at the card's foot (Stop): a small square and the word, in the card's quiet colour; it still asks first
 * where it stops something.
 */
export function FootButton({ className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" className={cx(f.footButton, className)} {...rest}>
      <span className={f.footSquare} aria-hidden="true" />
      {children}
    </button>
  );
}

/** A heading inside Details (“The answers”, “Task records and pull requests”). */
export function DetailsHeading({ children }: { children: ReactNode }) {
  return <p className={f.detailsHeading}>{children}</p>;
}

export { f as frameStyles };
