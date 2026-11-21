/**
 * Where the Wi-Fi sheet opens from on the box's screen (CG-104…CG-106): the network chip on the claim screens' header
 * and the desk's top bar (beside the lock), and the waiting scene's *Choose Wi-Fi*. `WifiLayer` wraps the console once:
 * it holds whether the sheet is open and draws it over the whole stage, so the scenes only place a chip or a button.
 * Without a network summary (no desk socket, an older runtime) nothing of it shows and the screens are as before.
 */
import { createContext, type ReactNode, useCallback, useContext, useState } from 'react';
import deskStyles from '../desk/desk.module.css';
import type { Client } from '../lib/client';
import type { NetworkSummary } from '../lib/network';
import { chipLabel, chipView, WIFI } from '../lib/wifiCopy';
import { Bars, Icon } from './icons';
import { type SheetInitial, WifiSheet } from './WifiSheet';
import styles from './wifi.module.css';

interface WifiContext {
  summary: NetworkSummary | null;
  open: () => void;
}

const Context = createContext<WifiContext>({ summary: null, open: () => {} });

/** Fixtures only: the sheet open at the start, and where. */
export interface WifiInitial extends SheetInitial {
  open?: boolean;
}

export function WifiLayer({
  client,
  summary,
  initial,
  children,
}: {
  client: Client;
  summary: NetworkSummary | null;
  initial?: WifiInitial;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial?.open ?? false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const shown = open && summary !== null;
  return (
    <Context.Provider value={{ summary, open: show }}>
      {/* Behind the sheet the screen is only a picture: no focus, no touches, not read out. */}
      <div className={styles.behind} inert={shown}>
        {children}
      </div>
      {shown && <WifiSheet client={client} onClose={close} initial={initial} />}
    </Context.Provider>
  );
}

/** The network now and the Wi-Fi sheet, for the calm glance's own chips (CG-353): null without a summary. */
export function useNetwork(): { summary: NetworkSummary | null; open: () => void } {
  return useContext(Context);
}

/** The network chip: cable, the Wi-Fi network's name, or none; amber while Whombat can't be reached. Opens the sheet. */
export function NetworkChip({ after }: { after?: ReactNode }) {
  const { summary, open } = useContext(Context);
  if (!summary) return null;
  const v = chipView(summary);
  return (
    <>
      <button
        type="button"
        className={`${deskStyles.chip} ${deskStyles.chipButton} ${styles.chip}`}
        data-warn={v.warn || undefined}
        aria-label={chipLabel(summary)}
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
        {v.icon === 'wifi' ? (
          <Bars signal={4} className={styles.chipIcon} />
        ) : (
          <Icon name={v.icon} className={styles.chipIcon} />
        )}
        <span className={styles.chipText}>{v.text}</span>
      </button>
      {after}
    </>
  );
}

/**
 * The waiting scene's hint (CG-106): with a Wi-Fi card that works, “Connect a network cable, or choose a Wi-Fi
 * network.” and *Choose Wi-Fi*; otherwise the text console's words, as before.
 */
export function WaitingHint({ fallback, className }: { fallback: ReactNode; className?: string }) {
  const { summary, open } = useContext(Context);
  if (!summary || summary.wifiMissing) return <>{fallback}</>;
  return (
    <div className={styles.waiting}>
      <p className={className}>{WIFI.waitingHint}</p>
      <button type="button" className={styles.choose} onClick={open}>
        <Bars signal={4} />
        {WIFI.chooseWifi}
      </button>
    </div>
  );
}

/** The claim screens' header class with room for the chip at its right. */
export const headerClass = styles.header;
