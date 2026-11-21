/**
 * The Bluetooth sheet's pieces: the paired devices with Connect or Disconnect and Remove, the devices found nearby, and
 * a pairing's code in very large digits (CG-205…CG-207). Rows, actions and the list are the Wi-Fi sheet's (64 px rows,
 * 44 px actions), so both sheets feel the same.
 */
import { type BluetoothDevice, typedDigits } from '../lib/bluetooth';
import { BT, deviceLine, foundLabel } from '../lib/bluetoothCopy';
import wifiStyles from '../wifi/wifi.module.css';
import styles from './bluetooth.module.css';
import { Icon, KIND_ICON, SignalBars } from './icons';

function Looking({ text }: { text: string }) {
  return (
    <li className={wifiStyles.rowEmpty} aria-live="polite">
      <span className={wifiStyles.looking} aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {text}
    </li>
  );
}

/** The paired devices; `onConnect` etc. null: read-only (BT-02), rows without buttons. */
export function PairedList({
  devices,
  loading,
  busy,
  onToggle,
  onRemove,
}: {
  devices: readonly BluetoothDevice[];
  /** Nothing read yet. */
  loading: boolean;
  /** The device whose connect or disconnect runs. */
  busy: string | null;
  onToggle: ((d: BluetoothDevice) => void) | null;
  onRemove: ((d: BluetoothDevice) => void) | null;
}) {
  return (
    // The list scrolls: rows below its end are not outside the screen (the shots' check).
    <ul className={`${wifiStyles.list} ${styles.list}`} aria-label={BT.yourDevices} data-overflow-ok>
      {devices.length === 0 &&
        (loading ? <Looking text="" /> : <li className={wifiStyles.rowEmpty}>{BT.none}</li>)}
      {devices.map((d) => {
        const running = busy === d.address;
        return (
          <li key={d.address} className={wifiStyles.row}>
            <div className={wifiStyles.rowMain}>
              <Icon name={KIND_ICON[d.kind]} />
              <span className={wifiStyles.rowText}>
                <span className={wifiStyles.rowName}>{d.name}</span>
                <span className={wifiStyles.rowMeta} data-connected={d.connected || undefined}>
                  {running ? (d.connected ? BT.disconnecting : BT.connecting) : deviceLine(d)}
                </span>
              </span>
            </div>
            {onToggle && (
              <button
                type="button"
                className={wifiStyles.rowAction}
                aria-disabled={busy !== null}
                aria-label={`${d.connected ? BT.disconnect : BT.connect} ${d.name}`}
                data-busy={running || undefined}
                onClick={() => busy === null && onToggle(d)}
              >
                {d.connected ? BT.disconnect : BT.connect}
              </button>
            )}
            {onRemove && (
              <button
                type="button"
                className={wifiStyles.rowAction}
                aria-disabled={busy !== null}
                aria-label={`${BT.remove} ${d.name}`}
                onClick={() => busy === null && onRemove(d)}
              >
                {BT.remove}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The devices found nearby, strongest first; the list ends with “Looking for devices…” while the box looks. */
export function FoundList({
  devices,
  looking,
  onPick,
}: {
  devices: readonly BluetoothDevice[];
  looking: boolean;
  /** null: nothing may be chosen now (a pairing is starting). */
  onPick: ((d: BluetoothDevice) => void) | null;
}) {
  return (
    <ul className={`${wifiStyles.list} ${styles.found}`} aria-label={BT.add} data-overflow-ok>
      {devices.map((d) => {
        const body = (
          <>
            <Icon name={KIND_ICON[d.kind]} />
            <span className={wifiStyles.rowText}>
              <span className={wifiStyles.rowName}>{d.name}</span>
              <span className={wifiStyles.rowMeta}>{BT.kinds[d.kind]}</span>
            </span>
            {d.signal !== undefined && <SignalBars signal={d.signal} className={styles.signal} />}
          </>
        );
        return (
          <li key={d.address} className={wifiStyles.row}>
            {onPick ? (
              <button
                type="button"
                className={wifiStyles.rowMain}
                aria-label={foundLabel(d)}
                onClick={() => onPick(d)}
              >
                {body}
              </button>
            ) : (
              <div className={wifiStyles.rowMain}>{body}</div>
            )}
          </li>
        );
      })}
      {looking ? (
        <Looking text={BT.looking} />
      ) : (
        devices.length === 0 && <li className={wifiStyles.rowEmpty}>{BT.nothingFound}</li>
      )}
    </ul>
  );
}

/**
 * A pairing's code in very large digits (BT-04): the ones the keyboard says are typed marked, the next one ringed. The
 * sentence above it says the code; the digits are a picture of it.
 */
export function CodeDigits({ code, typed }: { code: string; typed?: number }) {
  const done = typed === undefined ? 0 : typedDigits({ code, typed });
  return (
    <div className={styles.code} aria-hidden="true" data-length={code.length}>
      {[...code].map((digit, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a digit's place is its identity
          key={i}
          className={styles.digit}
          data-typed={(typed !== undefined && i < done) || undefined}
          data-next={(typed !== undefined && i === done) || undefined}
        >
          {digit}
        </span>
      ))}
    </div>
  );
}
