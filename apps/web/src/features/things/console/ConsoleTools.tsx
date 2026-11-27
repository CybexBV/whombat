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
import { currentLocale, useWebI18n } from '../../../i18n/provider';
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
  const { t } = useWebI18n();
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
        {t('console.sendKeys')}
      </Button>
      {open ? (
        <div
          ref={menu}
          id={id}
          className={styles.menu}
          role="menu"
          aria-label={t('console.sendKeys')}
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
              <div className={styles.fkeys} role="group" aria-label={t('console.fkeysLabel')}>
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
  const { t } = useWebI18n();
  return (
    <div className={styles.keyRow} role="toolbar" aria-label={t('console.keysFor', { name })}>
      {KEY_ROW.map((k) =>
        'mod' in k ? (
          <button
            key={k.mod}
            type="button"
            className={cx(styles.rowKey, sticky[k.mod] && styles.rowKeyOn)}
            aria-pressed={sticky[k.mod]}
            aria-label={t('console.hold', { key: k.name })}
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
  const { t } = useWebI18n();
  const s = Math.max(0, Math.ceil(leftMs / 1000));
  return (
    <div className={styles.idle} role="alert">
      <Icon icon={Clock} size={15} className={styles.idleIcon} />
      <span className={styles.idleText}>{t(s > 0 ? 'console.idleSoon' : 'console.idleClosing')}</span>
      {s > 0 ? (
        <span className={styles.idleLeft} aria-hidden="true">
          0:{String(s).padStart(2, '0')}
        </span>
      ) : null}
      <Button size="sm" onClick={onStay}>
        {t('console.stay')}
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
  const { t, tp } = useWebI18n();
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
            ? tp('console.paste.lines', a.lines, { n: formatCount(a.lines), name })
            : tp('console.paste.chars', a.chars, { n: formatCount(a.chars), name })}
        </ModalTitle>
        <div className={things.dialogBody}>
          {t(a.lines > 1 ? 'console.paste.eachLine' : 'console.paste.asTyped')}
          {a.controlCount > 0
            ? ` ${tp('console.paste.controls', a.controlCount, { n: formatCount(a.controlCount), names })}`
            : ''}
        </div>
        <pre className={styles.preview}>
          {preview}
          {more ? '\n…' : ''}
        </pre>
        <div className={things.dialogActions}>
          <Button onClick={onCancel}>{t('common.cancel')}</Button>
          {a.controlCount > 0 ? (
            <Button onClick={() => onSend(a.normalized)}>{t('console.paste.alsoControls')}</Button>
          ) : null}
          <Button variant="primary" onClick={() => onSend(a.sanitized)}>
            {t('console.paste.paste')}
          </Button>
        </div>
      </Modal>
    );
  }

  const cur = text ? analyzePaste(text) : null;
  const limit = formatBytes(PASTE_LIMIT_BYTES, currentLocale());
  const tooLarge = cur?.tooLarge ?? false;
  return (
    <Modal open onOpenChange={(o) => !o && onCancel()}>
      <ModalTitle className={things.dialogTitle}>{t('console.paste.into', { name })}</ModalTitle>
      <p className={things.dialogBody}>{t('console.paste.noClipboard')}</p>
      <div className={styles.pasteField}>
        <label htmlFor={areaId} className={styles.pasteLabel}>
          {t('console.paste.textLabel')}
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
            ? t('console.paste.tooLarge', { size: formatBytes(cur?.bytes ?? 0, currentLocale()), limit })
            : cur?.controlCount
              ? t('console.paste.ofLimitControls', { size: formatBytes(cur.bytes, currentLocale()), limit })
              : t('console.paste.upTo', { limit })}
        </div>
      </div>
      <div className={things.dialogActions}>
        <Button onClick={onCancel}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={!cur?.sanitized || tooLarge}
          onClick={() => cur && onSend(cur.sanitized)}
        >
          {t('console.paste.sendTo', { name })}
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
  const { t } = useWebI18n();
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
    <nav id={id} className={styles.side} aria-label={t('console.list.label', { server: serverId })}>
      <div className={styles.sideLabel}>{t('console.list.on', { server: serverId })}</div>
      <ul ref={ref} className={styles.rails}>
        {hostShell ? row('host', serverId, t('console.list.server'), 'ok') : null}
        {guests.map((g) =>
          row(g.id, g.name, guestKindText(g), guestStateTone(g.state), GUEST_STATE_WORDS[g.state]),
        )}
      </ul>
    </nav>
  );
}
