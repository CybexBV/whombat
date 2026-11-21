/**
 * Remote help on the box's screen (Whombat RH-04, RH-12; CG-290…CG-292, CG-295…CG-297): while an owner lets Whombat
 * support in, a small “Remote” chip in the top bar's row, beside the network and Bluetooth chips (the glance, *Only the
 * time*, the claim screens' header). Touched, locked or not, it opens a sheet: “Remote help is on · until 14:00”, the
 * level, who is connected, and Stop, which needs no PIN: stopping only ever takes access away.
 *
 * `RemoteHelpLayer` wraps the console once, inside the Bluetooth layer (CG-204's way): it holds the grant shown and
 * whether the sheet is open, and draws the sheet over the whole stage, so the scenes only place a chip.
 */
import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { SHEET_IDLE_MS } from '../lib/bluetooth';
import type { Client } from '../lib/client';
import {
  REMOTE_HELP_DESK_WORDS,
  REMOTE_HELP_PAGE_WORDS,
  type RemoteHelp,
  remoteHelpChipLabel,
  remoteHelpConnected,
  remoteHelpLevel,
  remoteHelpLine,
} from '../lib/remoteHelp';
import { useHoldFocus, useLastInput, useNow } from '../ui/hooks';
import wifiStyles from '../wifi/wifi.module.css';
import deskStyles from './desk.module.css';
import { Icon } from './icons';

interface RemoteHelpContext {
  /** The grant shown: null while off, or once Stop was touched until Whombat answers. */
  help: RemoteHelp | null;
  /** Server clock minus page clock, and the zone the times are in. */
  offset: number;
  timeZone: string;
  open: () => void;
}

const Context = createContext<RemoteHelpContext>({
  help: null,
  offset: 0,
  timeZone: 'UTC',
  open: () => {},
});

/** Fixtures only: the sheet open at the start. */
export interface RemoteHelpInitial {
  open?: boolean;
}

/**
 * Stop goes to the console server (`/api/desk/remote-help/stop`, CG-291) at once: the chip and the sheet go, and come
 * back only when Whombat refused or didn't answer; a new grant (another level or end) shows again.
 */
export function RemoteHelpLayer({
  help,
  offset,
  timeZone,
  client,
  refresh,
  held,
  initial,
  children,
}: {
  help: RemoteHelp | null | undefined;
  offset: number;
  timeZone: string;
  client: Client;
  refresh: () => void;
  /** Whombat is away (CG-49): the chip and the sheet show, Stop doesn't. */
  held: boolean;
  initial?: RemoteHelpInitial;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(initial?.open ?? false);
  const [gone, setGone] = useState(false);
  const grant = help ? `${help.level} ${help.until}` : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new grant is exactly a new `grant`
  useEffect(() => setGone(false), [grant]);
  const shown = help && !gone ? help : null;
  // When it ends, the sheet doesn't open again by itself with the next grant.
  useEffect(() => {
    if (!shown) setOpen(false);
  }, [shown]);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const stop = () => {
    setGone(true);
    setOpen(false);
    void client.post('/api/desk/remote-help/stop', {}).then(
      (res) => {
        if (res.status !== 200) setGone(false);
        refresh();
      },
      () => setGone(false),
    );
  };
  const sheet = open && shown !== null;
  return (
    <Context.Provider value={{ help: shown, offset, timeZone, open: show }}>
      {/* Behind the sheet the screen is only a picture: no focus, no touches, not read out. */}
      <div className={wifiStyles.behind} inert={sheet}>
        {children}
      </div>
      {sheet && (
        <RemoteHelpSheet
          help={shown}
          offset={offset}
          timeZone={timeZone}
          onStop={held ? undefined : stop}
          onClose={close}
        />
      )}
    </Context.Provider>
  );
}

/** The chip: a headset in the warn colour and “Remote”; its label is the whole line. */
export function RemoteHelpChip({ after }: { after?: ReactNode }) {
  const { help, offset, timeZone, open } = useContext(Context);
  if (!help) return null;
  return (
    <>
      <button
        type="button"
        className={`${deskStyles.chip} ${deskStyles.chipButton}`}
        data-tone="warn"
        aria-label={remoteHelpChipLabel(help, Date.now() + offset, timeZone)}
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
        <Icon name="headset" className={`${deskStyles.chipIcon} ${deskStyles.chipWarn}`} />
        {REMOTE_HELP_PAGE_WORDS.chip}
      </button>
      {after}
    </>
  );
}

/** Remote help now and its sheet, for the calm glance's own chip (CG-353): null while it is off. */
export function useRemoteHelp(): { help: RemoteHelp | null; open: () => void } {
  const { help, open } = useContext(Context);
  return { help, open };
}

/** Whether the chip shows (the claim screens' header places a separator before it). */
export function useRemoteHelpChip(): boolean {
  return useContext(Context).help !== null;
}

/** The sheet (the Wi-Fi sheet's card): the line, who is connected, the level and what it lets support do; Stop, Close. */
function RemoteHelpSheet({
  help,
  offset,
  timeZone,
  onStop,
  onClose,
}: {
  help: RemoteHelp;
  offset: number;
  timeZone: string;
  /** Absent while Whombat is away: nothing can be sent (CG-49). */
  onStop?: () => void;
  onClose: () => void;
}) {
  const card = useRef<HTMLElement>(null);
  useHoldFocus(card);
  const now = useNow(1000);
  // Untouched for 2 minutes the sheet closes (CG-108's rule).
  const lastInput = useLastInput();
  useEffect(() => {
    if (now - lastInput >= SHEET_IDLE_MS) onClose();
  }, [now, lastInput, onClose]);
  const connected = remoteHelpConnected(help);
  const level = remoteHelpLevel(help);
  return (
    // The sheet's own keys stay here: the desk's (Talk, the PIN pad) don't see them (CG-109).
    // biome-ignore lint/a11y/noStaticElementInteractions: catches bubbling keys and clicks, nothing of its own
    <div
      className={wifiStyles.layer}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') onClose();
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className={wifiStyles.scrim}
        aria-label={REMOTE_HELP_PAGE_WORDS.close}
        tabIndex={-1}
        onClick={onClose}
      />
      <div className={wifiStyles.sheet}>
        <section
          ref={card}
          className={wifiStyles.card}
          role="dialog"
          aria-modal="true"
          aria-label={REMOTE_HELP_PAGE_WORDS.title}
          tabIndex={-1}
        >
          <div className={wifiStyles.head}>
            <span className={wifiStyles.kicker}>{REMOTE_HELP_PAGE_WORDS.title}</span>
            <h2 className={wifiStyles.title}>{remoteHelpLine(help, now + offset, timeZone)}</h2>
            {connected && (
              <p className={wifiStyles.line} data-tone="warn">
                {connected}
              </p>
            )}
          </div>
          <div className={wifiStyles.head}>
            <p className={wifiStyles.line}>
              <b>{level.label}</b>
            </p>
            <p className={wifiStyles.note}>{level.hint}</p>
          </div>
          <div className={wifiStyles.buttons}>
            {onStop && (
              <button
                type="button"
                className={`${deskStyles.btn} ${deskStyles.btnPrimary}`}
                aria-label={REMOTE_HELP_PAGE_WORDS.stopLabel}
                onClick={onStop}
              >
                {REMOTE_HELP_DESK_WORDS.stop}
              </button>
            )}
            <span className={wifiStyles.grow} />
            <button type="button" className={deskStyles.btn} onClick={onClose}>
              {REMOTE_HELP_PAGE_WORDS.close}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
