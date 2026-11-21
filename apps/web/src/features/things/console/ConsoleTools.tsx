/**
 * The console's tools around the screen (ported from Rackoon's `ConsolePanel` and `ConsoleDialogs`): **Send keys**
 * (AP-1475), the **key row** for narrow screens with sticky Ctrl and Alt (AP-1476), the **paste** question (AP-1477),
 * the **“Stay connected”** warning a minute before an idle close (AP-1481) and the **side list** of the server's guests
 * (AP-1483). Buttons are real buttons with names; the menu moves with the arrow keys and gives focus back.
 */
import { GUEST_STATE_WORDS, guestKindText, guestStateTone } from '@whombat/client/hosts';
import type { HostGuest } from '@whombat/core/domain';
import { formatBytes } from '@whombat/core/text';
import { ChevronDown, Clock, Keyboard } from 'lucide-react';
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Button } from '../../../components/Button';
import { cx } from '../../../components/cx';
import { Icon } from '../../../components/Icon';
import { Modal, ModalTitle } from '../../../components/Modal';
import { Dot } from '../parts';
import things from '../Things.module.css';
import styles from './Console.module.css';
import {
  KEY_ROW,
  type KeyCombo,
  type Modifiers,
  type RowKey,
  SCREEN_FKEYS,
  SCREEN_KEYS,
  SHELL_KEYS,
  type ShellKey,
} from './keyCombos';
import { analyzePaste, formatCount, PASTE_LIMIT_BYTES, type PasteAnalysis } from './paste';

/* Send keys ------------------------------------------------------------------------------------------ */

export function SendKeysMenu({
  kind,
  disabled,
  onCombo,
  onShellKey,
}: {
  kind: 'screen' | 'shell';
  disabled?: boolean;
  onCombo: (c: KeyCombo) => void;
  onShellKey: (k: ShellKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(at + 1);
    else if (e.key === 'ArrowUp') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(items.length - 1);
    else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <div ref={wrap} className={styles.menuWrap}>
      <Button
        ref={button}
        size="sm"
        iconStart={<Icon icon={Keyboard} size={15} />}
        iconEnd={<Icon icon={ChevronDown} size={14} />}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        Send keys
      </Button>
      {open ? (
        <div
          ref={menu}
          id={id}
          className={styles.menu}
          role="menu"
          aria-label="Send keys"
          tabIndex={-1}
          onKeyDown={onMenuKey}
        >
          {kind === 'screen' ? (
            <>
              {SCREEN_KEYS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={() => {
                    setOpen(false);
                    onCombo(c);
                  }}
                >
                  {c.label}
                </button>
              ))}
              <div className={styles.menuLabel} aria-hidden="true">
                Ctrl+Alt+
              </div>
              {/* biome-ignore lint/a11y/useSemanticElements: a group of menu items */}
              <div className={styles.fkeys} role="group" aria-label="Ctrl+Alt and a function key">
                {SCREEN_FKEYS.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    aria-label={c.label}
                    className={styles.fkey}
                    onClick={() => {
                      setOpen(false);
                      onCombo(c);
                    }}
                  >
                    F{i + 1}
                  </button>
                ))}
              </div>
            </>
          ) : (
            SHELL_KEYS.map((k) => (
              <button
                key={k.id}
                type="button"
                role="menuitem"
                className={styles.menuItem}
                onClick={() => {
                  setOpen(false);
                  onShellKey(k);
                }}
              >
                {k.label}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

/* The key row ---------------------------------------------------------------------------------------- */

/** Esc, Tab, Ctrl, Alt and the arrows for a phone (narrow screens only, by CSS); Ctrl and Alt stay down for one key. */
export function KeyRow({
  name,
  sticky,
  onSticky,
  onKey,
}: {
  name: string;
  sticky: Modifiers;
  onSticky: (m: Modifiers) => void;
  onKey: (k: RowKey) => void;
}) {
  return (
    <div className={styles.keyRow} role="toolbar" aria-label={`Keys for ${name}`}>
      {KEY_ROW.map((k) =>
        'mod' in k ? (
          <button
            key={k.mod}
            type="button"
            className={cx(styles.rowKey, sticky[k.mod] && styles.rowKeyOn)}
            aria-pressed={sticky[k.mod]}
            aria-label={`Hold ${k.name} for the next key`}
            // Keep the keyboard (and a phone's keyboard) on the console.
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onSticky({ ...sticky, [k.mod]: !sticky[k.mod] })}
          >
            {k.label}
          </button>
        ) : (
          <button
            key={k.key}
            type="button"
            className={styles.rowKey}
            aria-label={k.name}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onKey(k.key)}
          >
            {k.label}
          </button>
        ),
      )}
    </div>
  );
}

/* Stay connected ------------------------------------------------------------------------------------- */

/** A minute before the service closes an idle console: the time left and a way to stay. */
export function IdleWarning({ leftMs, onStay }: { leftMs: number; onStay: () => void }) {
  const s = Math.max(0, Math.ceil(leftMs / 1000));
  return (
    <div className={styles.idle} role="alert">
      <Icon icon={Clock} size={15} className={styles.idleIcon} />
      <span className={styles.idleText}>
        {s > 0
          ? 'Nothing’s been typed for a while, so this console closes in a minute.'
          : 'This console is closing because nothing was typed.'}
      </span>
      {s > 0 ? (
        <span className={styles.idleLeft} aria-hidden="true">
          0:{String(s).padStart(2, '0')}
        </span>
      ) : null}
      <Button size="sm" onClick={onStay}>
        Stay connected
      </Button>
    </div>
  );
}

/* Paste ---------------------------------------------------------------------------------------------- */

export type PasteAsk =
  /** The browser didn't give the clipboard: a box to paste into. */
  | { mode: 'input' }
  /** A long or many-line paste into a shell, or one with control characters. */
  | { mode: 'confirm'; analysis: PasteAnalysis };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${formatCount(n)} ${n === 1 ? one : many}`;
}

export function PasteDialog({
  ask,
  name,
  onCancel,
  onSend,
}: {
  ask: PasteAsk | null;
  name: string;
  onCancel: () => void;
  /** Send this text (already sanitised unless the person kept the control characters). */
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState('');
  const areaId = useId();
  const infoId = useId();
  useEffect(() => {
    if (ask) setText('');
  }, [ask]);
  if (!ask) return null;

  if (ask.mode === 'confirm') {
    const a = ask.analysis;
    const preview = a.sanitized.split('\n').slice(0, 8).join('\n');
    const more = a.lines > 8;
    const names = `${a.controlNames.join(', ')}${a.controlCount > a.controlNames.length ? ', …' : ''}`;
    return (
      <Modal open onOpenChange={(o) => !o && onCancel()}>
        <ModalTitle className={things.dialogTitle}>
          {a.lines > 1
            ? `Paste ${plural(a.lines, 'line')} into ${name}?`
            : `Paste ${plural(a.chars, 'character')} into ${name}?`}
        </ModalTitle>
        <div className={things.dialogBody}>
          {a.lines > 1
            ? 'Each line runs as a command as soon as it arrives.'
            : 'It arrives as if you typed it.'}
          {a.controlCount > 0
            ? ` It also holds ${plural(a.controlCount, 'control character')} (${names}) that can act on their own; they’re left out.`
            : ''}
        </div>
        <pre className={styles.preview}>
          {preview}
          {more ? '\n…' : ''}
        </pre>
        <div className={things.dialogActions}>
          <Button onClick={onCancel}>Cancel</Button>
          {a.controlCount > 0 ? <Button onClick={() => onSend(a.normalized)}>Paste them too</Button> : null}
          <Button variant="primary" onClick={() => onSend(a.sanitized)}>
            Paste
          </Button>
        </div>
      </Modal>
    );
  }

  const cur = text ? analyzePaste(text) : null;
  const tooLarge = cur?.tooLarge ?? false;
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()}>
      <ModalTitle className={things.dialogTitle}>Paste into {name}</ModalTitle>
      <p className={things.dialogBody}>
        The browser didn’t let Whombat read the clipboard. Paste the text here, then send it.
      </p>
      <div className={styles.pasteField}>
        <label htmlFor={areaId} className={styles.pasteLabel}>
          Text to send
        </label>
        <textarea
          id={areaId}
          className={styles.pasteArea}
          // biome-ignore lint/a11y/noAutofocus: the dialog exists to take this text
          autoFocus
          spellCheck={false}
          value={text}
          aria-describedby={infoId}
          aria-invalid={tooLarge || undefined}
          onChange={(e) => setText(e.target.value)}
        />
        <div id={infoId} className={cx(styles.pasteHint, tooLarge && styles.pasteHintBad)} aria-live="polite">
          {tooLarge
            ? `That’s ${formatBytes(cur?.bytes ?? 0)}; up to ${formatBytes(PASTE_LIMIT_BYTES)} can be pasted.`
            : cur?.controlCount
              ? `${formatBytes(cur.bytes)} of ${formatBytes(PASTE_LIMIT_BYTES)} · control characters are left out`
              : `Up to ${formatBytes(PASTE_LIMIT_BYTES)} of text.`}
        </div>
      </div>
      <div className={things.dialogActions}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          disabled={!cur?.sanitized || tooLarge}
          onClick={() => cur && onSend(cur.sanitized)}
        >
          Send to {name}
        </Button>
      </div>
    </Modal>
  );
}

/* The side list -------------------------------------------------------------------------------------- */

export function GuestList({
  id,
  serverId,
  guests,
  current,
  hostShell,
  onSelect,
}: {
  id: string;
  serverId: string;
  guests: readonly HostGuest[];
  /** `host` or a guest id. */
  current: string;
  /** The server's own shell is on the list. */
  hostShell: boolean;
  onSelect: (target: string) => void;
}) {
  const ref = useRef<HTMLUListElement>(null);
  // The open console's row in view.
  useEffect(() => {
    ref.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' });
  }, []);
  const row = (
    target: string,
    name: string,
    kind: string,
    tone: Parameters<typeof Dot>[0]['tone'],
    state?: string,
  ) => {
    const on = target === current;
    return (
      <li key={target}>
        <button
          type="button"
          className={cx(styles.rail, on && styles.railOn)}
          aria-current={on ? 'true' : undefined}
          onClick={() => !on && onSelect(target)}
        >
          <Dot tone={tone} label={state} />
          <span className={styles.railName}>{name}</span>
          <span className={styles.railKind}>{kind}</span>
        </button>
      </li>
    );
  };
  return (
    <nav id={id} className={styles.side} aria-label={`Consoles on ${serverId}`}>
      <div className={styles.sideLabel}>On {serverId}</div>
      <ul ref={ref} className={styles.rails}>
        {hostShell ? row('host', serverId, 'Server', 'ok') : null}
        {guests.map((g) =>
          row(g.id, g.name, guestKindText(g), guestStateTone(g.state), GUEST_STATE_WORDS[g.state]),
        )}
      </ul>
    </nav>
  );
}
