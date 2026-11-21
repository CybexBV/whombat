/**
 * “Ask” on a card's head (Whombat service-settings.md SST-08): a small button that opens “Ask {assistant} about
 * {title}” with the card's few questions as chips and “Or ask something else…”; each opens the Ask pane with that
 * question (the last with an empty box). The card clips what overflows it, so the popover is drawn over the page,
 * under the button (right edges together), and follows it while the page scrolls. Escape, a click elsewhere or
 * picking one closes it; focus goes into it when it opens and back to the button when it closes.
 */
import { useTheAgent } from '@whombat/client/react';
import type { ThingPanelAsk } from '@whombat/core';
import { ArrowUp, MessageCircle } from 'lucide-react';
import { type CSSProperties, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { PrincipalAvatar } from '../../messaging/PrincipalAvatar';
import type { DashboardContext } from './Panels';
import styles from './Settings.module.css';

/** The popover's width, and its gap under the button. */
const POP_W = 340;
const POP_GAP = 8;

export function AskAbout({
  title,
  ask,
  ctx,
}: {
  title: string;
  ask: ThingPanelAsk;
  ctx: Pick<DashboardContext, 'burrow' | 'onAsk'>;
}) {
  const { agent, words } = useTheAgent(ctx.burrow);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<CSSProperties | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const id = useId();
  const headId = `${id}-h`;

  const place = useCallback(() => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const left = Math.max(8, Math.min(r.right - POP_W, window.innerWidth - POP_W - 8));
    setAt({ top: r.bottom + POP_GAP, left, width: POP_W });
  }, []);

  const close = useCallback((back = true) => {
    setOpen(false);
    setAt(null);
    if (back) button.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // Into the popover once it is placed: its first question.
  const placed = open && at !== null;
  useEffect(() => {
    if (placed) pop.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [placed]);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !button.current?.contains(t)) close(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', place);
    // The page scrolls inside its own column: any scroll moves the button.
    document.addEventListener('scroll', place, true);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', place);
      document.removeEventListener('scroll', place, true);
    };
  }, [open, close, place]);

  const pick = (question?: string) => {
    close(false);
    ctx.onAsk(question);
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className={cx(styles.ask, open && styles.askOpen)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={open ? id : undefined}
        aria-label={`Ask ${words.Name} about ${title}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Icon icon={MessageCircle} size={14} />
        Ask
      </button>
      {open && at
        ? createPortal(
            <div
              ref={pop}
              id={id}
              role="dialog"
              aria-labelledby={headId}
              className={styles.pop}
              style={at}
              data-ask-about={title}
            >
              <div className={styles.popHead}>
                {agent ? <PrincipalAvatar principal={agent} size={22} /> : null}
                <b id={headId}>
                  Ask {words.Name} about {title}
                </b>
              </div>
              <ul className={styles.popList}>
                {ask.questions.map((q) => (
                  <li key={q}>
                    <button type="button" className={styles.popChip} onClick={() => pick(q)}>
                      {q}
                    </button>
                  </li>
                ))}
              </ul>
              <button type="button" className={styles.popElse} onClick={() => pick()}>
                Or ask something else…
                <Icon icon={ArrowUp} size={16} />
              </button>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
