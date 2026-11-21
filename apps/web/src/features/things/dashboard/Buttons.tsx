/**
 * A thing page's buttons (contracts 0.121 `ThingPageButton`, CT-1001…CT-1003, CT-1014; Whombat service-dashboards.md
 * SD-07; service-dashboards.md AP-4560, AP-4561): small buttons with their icon on a panel's head, in a table's cell,
 * on a list line, under a gallery item and on a control. One the viewer may not press stays in place, greyed, and says
 * why — the server's reason as its tooltip and its description, still reachable with the keyboard (`aria-disabled`, not
 * `disabled`). A running one is busy until its answer. Pressing asks the page's one question dialog first (Restart's
 * dialog) when the button has a question, then runs `things.action`; the page's toast says how it went.
 */
import { thingButtonView } from '@whombat/client';
import type { ThingButtons } from '@whombat/client/react';
import type { ThingPageButton } from '@whombat/core';
import type { ReactNode } from 'react';
import { useId, useRef } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { ConfirmDialog } from '../parts';
import things from '../Things.module.css';
import { BUTTON_ICONS } from '../thingIcons';
import styles from './Service.module.css';

export function ThingButton({
  button,
  buttons,
  value,
  look = 'small',
  className,
}: {
  button: ThingPageButton;
  /** The page's runner; none (a server's page): drawn disabled. */
  buttons: ThingButtons | null | undefined;
  /** What it sends instead of its own value (a stepper's figure). */
  value?: ThingPageButton['value'];
  /**
   * `small` in panels, rows and tiles; `head` in a page's head, like Restart; `icon` its glyph alone, named by its
   * label (a count's Scan, service-slots.md SLT-03).
   */
  look?: 'small' | 'head' | 'icon';
  className?: string;
}) {
  const view = thingButtonView(button);
  const reasonId = useId();
  const busy = buttons?.running(button, value) ?? false;
  const off = view.disabled || !buttons;
  const glyph = view.icon ? BUTTON_ICONS[view.icon] : undefined;
  if (look === 'icon' && glyph)
    return (
      <>
        <Button
          size="sm"
          variant="ghost"
          className={cx(styles.tbtnIcon, busy && styles.tbtnBusy, className)}
          aria-label={view.label}
          aria-disabled={off || busy || undefined}
          aria-busy={busy || undefined}
          aria-describedby={view.reason ? reasonId : undefined}
          aria-haspopup={view.confirm && !off ? 'dialog' : undefined}
          title={view.reason ?? view.label}
          onClick={() => {
            if (!off && !busy) buttons.press(button, value !== undefined ? { value } : {});
          }}
        >
          <Icon icon={glyph} size={15} />
        </Button>
        {view.reason ? (
          <span id={reasonId} className={things.srOnly}>
            {view.reason}
          </span>
        ) : null}
      </>
    );
  return (
    <>
      <Button
        size={look === 'head' ? 'md' : 'sm'}
        variant={view.tone === 'primary' ? 'primary' : 'secondary'}
        className={cx(
          look === 'head' ? things.btn : styles.tbtn,
          look !== 'head' && view.tone !== 'primary' && styles.tbtnPlain,
          view.tone === 'danger' && styles.tbtnDanger,
          busy && styles.tbtnBusy,
          className,
        )}
        aria-disabled={off || busy || undefined}
        aria-busy={busy || undefined}
        aria-describedby={view.reason ? reasonId : undefined}
        aria-haspopup={view.confirm && !off ? 'dialog' : undefined}
        title={view.reason ?? undefined}
        iconStart={glyph ? <Icon icon={glyph} size={look === 'head' ? 15 : 14} /> : undefined}
        onClick={() => {
          if (!off && !busy) buttons.press(button, value !== undefined ? { value } : {});
        }}
      >
        {view.label}
      </Button>
      {view.reason ? (
        <span id={reasonId} className={things.srOnly}>
          {view.reason}
        </span>
      ) : null}
    </>
  );
}

/** A row of buttons (a gallery item's, a list line's, a control's, a panel head's). */
export function ThingButtonRow({
  items,
  buttons,
  className,
  label,
  look,
}: {
  items: readonly ThingPageButton[] | undefined;
  buttons: ThingButtons | null | undefined;
  className?: string;
  /** How each is drawn (`ThingButton`'s `look`). */
  look?: 'small' | 'icon';
  /** Names the group when its buttons alone don't say what they act on (“Dune: Part Two”). */
  label?: string;
}): ReactNode {
  if (!items?.length) return null;
  const row = items.map((b) => (
    <ThingButton
      key={`${b.action}|${b.target ?? ''}|${String(b.value ?? '')}`}
      button={b}
      buttons={buttons}
      {...(look ? { look } : {})}
    />
  ));
  if (!label) return <div className={cx(styles.btnRow, className)}>{row}</div>;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a fieldset of inputs
    <div className={cx(styles.btnRow, className)} role="group" aria-label={label}>
      {row}
    </div>
  );
}

/**
 * The page's one question before a button runs (Restart's dialog): its title, its sentences and its button, busy while
 * it runs; it closes when the answer came (the toast says how it went).
 */
export function ThingButtonQuestion({ buttons }: { buttons: ThingButtons }) {
  const asking = buttons.asking;
  // Keep the last words while the dialog closes.
  const last = useRef(asking);
  if (asking) last.current = asking;
  const shown = asking ?? last.current;
  return (
    <ConfirmDialog
      open={!!asking}
      title={shown?.confirm.title ?? ''}
      body={shown?.confirm.body}
      confirm={shown?.confirm.button ?? ''}
      serious={shown?.view.tone === 'danger'}
      busy={asking?.busy ?? false}
      onConfirm={buttons.confirm}
      onClose={buttons.cancel}
    />
  );
}
