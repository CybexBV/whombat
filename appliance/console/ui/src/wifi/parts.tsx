/**
 * The Wi-Fi sheet's pieces, shared by the box's screen (WifiSheet) and the installer's Wi-Fi step (HD-08: “the same
 * sheet's list, password and keyboard”): the list of networks, the password and name fields with the keyboard under
 * them, the security choice, an outcome.
 */
import { type ReactNode, type RefObject, useId, useRef, useState } from 'react';
import { joinable, sortNetworks, type WifiNetwork } from '../lib/network';
import { rowLabel, rowMeta, WIFI } from '../lib/wifiCopy';
import { Bars, Icon } from './icons';
import { Keyboard } from './Keyboard';
import styles from './wifi.module.css';

/** The scan as the list shows it: looking (nothing yet), found, nothing found, or the scan failed. */
export type ListState = 'looking' | 'ready' | 'failed';

export interface NetworkListProps {
  networks: readonly WifiNetwork[];
  state: ListState;
  /** A network was chosen; null: the list is read-only (HD-07), rows aren't buttons. */
  onPick: ((n: WifiNetwork) => void) | null;
  /** Forget on a saved network (absent: no Forget). */
  onForget?: (n: WifiNetwork) => void;
  mayForget?: (n: WifiNetwork) => boolean;
  /** Fill the space it has (the installer's column). */
  tall?: boolean;
}

export function NetworkList(p: NetworkListProps) {
  const rows = sortNetworks(p.networks);
  return (
    // The list scrolls: rows below its end are not outside the screen (the shots' check).
    <ul className={styles.list} data-tall={p.tall || undefined} aria-label={WIFI.title} data-overflow-ok>
      {rows.length === 0 && (
        <li className={styles.rowEmpty} aria-live="polite">
          {p.state === 'looking' ? (
            <>
              <span className={styles.looking} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              {WIFI.looking}
            </>
          ) : p.state === 'failed' ? (
            WIFI.couldNotLook
          ) : (
            WIFI.none
          )}
        </li>
      )}
      {rows.map((n) => (
        <NetworkRow
          key={n.ssid}
          network={n}
          onPick={p.onPick}
          onForget={p.onForget && n.saved && (p.mayForget?.(n) ?? true) ? p.onForget : undefined}
        />
      ))}
    </ul>
  );
}

function NetworkRow({
  network: n,
  onPick,
  onForget,
}: {
  network: WifiNetwork;
  onPick: ((n: WifiNetwork) => void) | null;
  onForget?: (n: WifiNetwork) => void;
}) {
  const meta = rowMeta(n);
  const can = joinable(n.security) && !n.connected;
  const body = (
    <>
      <Bars signal={n.signal} />
      <span className={styles.rowText}>
        <span className={styles.rowName}>{n.ssid}</span>
        {meta && (
          <span className={styles.rowMeta} data-connected={n.connected || undefined}>
            {meta}
          </span>
        )}
      </span>
      {n.security !== 'open' && <Icon name="lock" className={styles.rowLock} />}
    </>
  );
  // Read-only, the network in use, or one that can't be joined: a row, not a button.
  return (
    <li className={styles.row} data-off={(!joinable(n.security) && !n.connected) || undefined}>
      {onPick && can ? (
        <button type="button" className={styles.rowMain} aria-label={rowLabel(n)} onClick={() => onPick(n)}>
          {body}
        </button>
      ) : (
        <div className={styles.rowMain}>{body}</div>
      )}
      {onPick && onForget && (
        <button type="button" className={styles.rowAction} onClick={() => onForget(n)}>
          {WIFI.forget}
        </button>
      )}
    </li>
  );
}

export interface TextFieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** A password: hidden, with Show/Hide. */
  secret?: boolean;
  max: number;
  error?: string | null;
  disabled?: boolean;
  onEnter?: () => void;
  input: RefObject<HTMLInputElement | null>;
  /** Fixtures: the password shown at the start. */
  initiallyShown?: boolean;
}

/** One text field (a real input: a real keyboard types into it) with Show/Hide for a password. */
export function TextField(p: TextFieldProps) {
  const [shown, setShown] = useState(p.initiallyShown ?? false);
  const id = useId();
  return (
    <div className={styles.field}>
      <label className={styles.fieldLabel} htmlFor={id}>
        {p.label}
      </label>
      <div className={styles.inputRow} data-error={p.error ? '' : undefined}>
        <input
          ref={p.input}
          id={id}
          className={styles.input}
          type={p.secret && !shown ? 'password' : 'text'}
          value={p.value}
          disabled={p.disabled}
          maxLength={p.max}
          // The screen's keyboard types here; no other keyboard should open over it.
          inputMode="none"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={p.error ? true : undefined}
          onChange={(e) => p.onChange(e.target.value.slice(0, p.max))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              p.onEnter?.();
            }
          }}
          autoFocus
        />
        {p.secret && (
          <button
            type="button"
            className={styles.reveal}
            aria-pressed={shown}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => setShown((s) => !s)}
          >
            <Icon name={shown ? 'eyeOff' : 'eye'} />
            {shown ? WIFI.hide : WIFI.show}
          </button>
        )}
      </div>
      {p.error && (
        <p className={styles.error} role="alert">
          {p.error}
        </p>
      )}
    </div>
  );
}

/** A field with the screen's keyboard under it. */
export function TypedField(p: Omit<TextFieldProps, 'input'>) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <TextField {...p} input={input} />
      <Keyboard input={input} value={p.value} onChange={p.onChange} max={p.max} />
    </>
  );
}

/** Password or none, for a network that doesn't show its name. */
export function SecurityChoice({
  value,
  onChange,
}: {
  value: 'psk' | 'open';
  onChange: (v: 'psk' | 'open') => void;
}) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel} id="wifi-security">
        {WIFI.security}
      </span>
      <div className={styles.segments} role="radiogroup" aria-labelledby="wifi-security">
        {(['psk', 'open'] as const).map((s) => (
          // biome-ignore lint/a11y/useSemanticElements: two big touch segments, not radio dots
          <button
            key={s}
            type="button"
            role="radio"
            aria-checked={value === s}
            className={styles.segment}
            onPointerDown={(e) => e.preventDefault()}
            onClick={() => onChange(s)}
          >
            {WIFI.securities[s]}
          </button>
        ))}
      </div>
    </div>
  );
}

/** How a join or a forget went: a mark, the title, the line. */
export function Outcome({
  title,
  line,
  tone,
  running,
}: {
  title: string;
  line: string | null;
  tone: 'mut' | 'ok' | 'warn' | 'bad';
  running: boolean;
}) {
  return (
    <div className={styles.outcome} role="status" aria-live="polite">
      <span className={styles.mark} data-tone={tone}>
        {running ? (
          <span className={styles.looking} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        ) : (
          <Icon name={tone === 'ok' ? 'check' : 'alert'} />
        )}
      </span>
      <div className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {line && <p className={styles.line}>{line}</p>}
      </div>
    </div>
  );
}

export function Buttons({ children }: { children: ReactNode }) {
  return <div className={styles.buttons}>{children}</div>;
}
