/**
 * Where the Bluetooth sheet opens from on the box's screen (CG-202, CG-204): the Bluetooth chip beside the network chip,
 * on the claim screens' header and the desk's top bar. `BluetoothLayer` wraps the console once, inside the Wi-Fi layer
 * (CG-104): it holds whether the sheet is open and draws it over the whole stage, so the scenes only place a chip.
 * Without a Bluetooth summary (no desk socket, an older runtime, no adapter) nothing of it shows.
 */

import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import deskStyles from '../desk/desk.module.css';
import { useT } from '../i18n/react';
import type { BluetoothSummary } from '../lib/bluetooth';
import { chipView } from '../lib/bluetoothCopy';
import type { Client } from '../lib/client';
import wifiStyles from '../wifi/wifi.module.css';
import { BluetoothSheet, type BluetoothSheetInitial } from './BluetoothSheet';
import styles from './bluetooth.module.css';
import { Icon } from './icons';

interface BluetoothContext {
  summary: BluetoothSummary | null;
  open: () => void;
}

const Context = createContext<BluetoothContext>({ summary: null, open: () => {} });

/** Fixtures only: the sheet open at the start, and where. */
export interface BluetoothInitial extends BluetoothSheetInitial {
  open?: boolean;
}

export function BluetoothLayer({
  client,
  summary,
  initial,
  children,
}: {
  client: Client;
  summary: BluetoothSummary | null;
  initial?: BluetoothInitial;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial?.open ?? false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  // Opened only with a summary; once open it stays until closed (a poll without an answer mustn't drop a pairing's
  // code from the screen, CG-204).
  return (
    <Context.Provider value={{ summary, open: show }}>
      {/* Behind the sheet the screen is only a picture: no focus, no touches, not read out. */}
      <div className={wifiStyles.behind} inert={open}>
        {children}
      </div>
      {open && <BluetoothSheet client={client} onClose={close} initial={initial} />}
    </Context.Provider>
  );
}

/** The Bluetooth chip: the mark, and what is connected; the mark struck through when it can't be used. */
export function BluetoothChip({ after }: { after?: ReactNode }) {
  const t = useT();

  const { summary, open } = useContext(Context);
  if (!summary) return null;
  const v = chipView(summary, t);
  return (
    <>
      <button
        type="button"
        className={`${deskStyles.chip} ${deskStyles.chipButton} ${styles.chip}`}
        data-off={v.off || undefined}
        aria-label={v.label}
        onClick={(e) => {
          // Not the locked glance's “touch to unlock”.
          e.stopPropagation();
          open();
        }}
        // Nor its keys: Enter or Space on the chip opens the sheet only (no PIN pad, no Talk).
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
        }}
      >
        <Icon name={v.off ? 'bluetoothOff' : 'bluetooth'} className={styles.chipIcon} />
        {v.text && <span className={styles.chipText}>{v.text}</span>}
      </button>
      {after}
    </>
  );
}

/** Whether the chip shows (the claim screens' header places a separator before it). */
export function useBluetoothChip(): boolean {
  return useContext(Context).summary !== null;
}
