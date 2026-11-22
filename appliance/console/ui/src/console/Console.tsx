import { WhombatLogo } from '@whombat/brand/react';
import { useEffect, useRef, useState } from 'react';
import {
  BluetoothChip,
  type BluetoothInitial,
  BluetoothLayer,
  useBluetoothChip,
} from '../bluetooth/BluetoothLayer';
import btStyles from '../bluetooth/bluetooth.module.css';
import { Desk, type DeskInitial } from '../desk/Desk';
import deskStyles from '../desk/desk.module.css';
import {
  RemoteHelpChip,
  type RemoteHelpInitial,
  RemoteHelpLayer,
  useRemoteHelpChip,
} from '../desk/RemoteHelp';
import type { ConsoleState } from '../lib/api';
import { burnIn } from '../lib/burnin';
import type { Client } from '../lib/client';
import {
  type ConsoleScene,
  consoleScene,
  justClaimed,
  linkScreen,
  noAddressLine,
  reachNotes,
  waitingInApp,
} from '../lib/console';
import { deskActive } from '../lib/deskScene';
import { useLastInput, useNow } from '../ui/hooks';
import { headerClass, NetworkChip, type WifiInitial, WifiLayer } from '../wifi/WifiLayer';
import { Celebration, Claimable, Claimed, LinkStarting, ReachNotes, Waking } from './Claim';
import styles from './console.module.css';
import { SignInLayer } from './SignIn';

export const CELEBRATE_MS = 5000;

interface Props {
  state: ConsoleState;
  /** Server clock minus page clock. */
  offset: number;
  /** Fixtures only: the last key press was this long ago. */
  idleMs?: number;
  client: Client;
  refresh: () => void;
  /** The desk is the last one, kept locked while Whombat restarts (CG-49). */
  held?: boolean;
  /** Fixtures only: the desk's own state at the start. */
  desk?: DeskInitial;
  /** Fixtures only: the Wi-Fi sheet at the start. */
  wifi?: WifiInitial;
  /** Fixtures only: the Bluetooth sheet at the start. */
  bluetooth?: BluetoothInitial;
  /** Fixtures only: the remote help sheet at the start. */
  remoteHelp?: RemoteHelpInitial;
}

/**
 * The console: the claim screens, or the desk display once Whombat paired this screen (CG-37); either can open the
 * Wi-Fi sheet (CG-104), the Bluetooth sheet (CG-204) or the remote help sheet (CG-296) over it, and a device waiting to
 * sign in shows its panel over all of it (CG-150).
 */
export function Console(props: Props) {
  return (
    <SignInLayer claim={props.state.claim} offset={props.offset}>
      <WifiLayer client={props.client} summary={props.state.network ?? null} initial={props.wifi}>
        <BluetoothLayer
          client={props.client}
          summary={props.state.bluetooth ?? null}
          initial={props.bluetooth}
        >
          <RemoteHelpLayer
            help={props.state.desk?.remoteHelp}
            offset={props.offset}
            timeZone={props.state.desk?.paired?.timeZone ?? LOCAL_ZONE}
            client={props.client}
            refresh={props.refresh}
            held={props.held ?? false}
            initial={props.remoteHelp}
          >
            <Screens {...props} />
          </RemoteHelpLayer>
        </BluetoothLayer>
      </WifiLayer>
    </SignInLayer>
  );
}

function Screens(props: Props) {
  const { state } = props;
  if (state.desk && deskActive(state)) {
    return (
      <Desk
        state={state}
        desk={state.desk}
        offset={props.offset}
        client={props.client}
        refresh={props.refresh}
        idleMs={props.idleMs}
        held={props.held ?? false}
        initial={props.desk}
      />
    );
  }
  return (
    <ClaimScreens
      state={state}
      offset={props.offset}
      idleMs={props.idleMs}
      client={props.client}
      refresh={props.refresh}
    />
  );
}

/** The kiosk's own time zone, for a screen nobody paired (remote help's sheet, CG-292). */
const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function ClaimScreens({
  state,
  offset,
  idleMs = 0,
  client,
  refresh,
}: Pick<Props, 'state' | 'offset' | 'idleMs' | 'client' | 'refresh'>) {
  const scene = consoleScene(state);
  const now = useNow(1000);
  const serverNow = now + offset;

  // The celebration: only when the claim happens while this page watches (CG-07).
  const prev = useRef<ConsoleScene | null>(null);
  const [celebrateUntil, setCelebrateUntil] = useState(0);
  useEffect(() => {
    if (justClaimed(prev.current, scene)) setCelebrateUntil(Date.now() + CELEBRATE_MS);
    prev.current = scene;
  }, [scene]);
  const celebrating = now < celebrateUntil;

  // Burn-in (CG-09): every console screen except the celebration.
  const lastInput = useLastInput(idleMs);
  const b = burnIn(now - lastInput, !celebrating);

  const claim = state.claim;
  // Whombat Link starting takes the claim's place; the notes sit above every claim screen (CG-404).
  const link = linkScreen(state, serverNow);
  const notes = reachNotes(state);
  const noteQr = notes.some((n) => n.kind === 'tailscaleLogin' && n.qr.length > 0);
  const headQr = link
    ? link === 'code' && (state.reach?.link?.qr.length ?? 0) > 0
    : scene === 'claimable' && (claim?.qr?.length ?? 0) > 0;
  const tight = noteQr || (notes.length > 0 && headQr);
  // The chips' touch areas reach past their words: a separator between them, as on the desk's top bar.
  const bluetoothChip = useBluetoothChip();
  const remoteChip = useRemoteHelpChip();
  return (
    <div className={styles.page} data-dimmed={b.dimmed || undefined}>
      <div
        className={styles.drift}
        data-overflow-ok={b.dimmed || undefined}
        style={{ transform: `translate(${b.x}px, ${b.y}px)` }}
      >
        <header className={`${styles.header} ${headerClass}`}>
          <WhombatLogo variant="lockup" height={26} label="Whombat" />
          {!celebrating && (
            <span className={btStyles.chips}>
              <NetworkChip after={(bluetoothChip || remoteChip) && <span className={deskStyles.sep} />} />
              <BluetoothChip after={remoteChip && <span className={deskStyles.sep} />} />
              {/* Remote help on a box nobody paired a screen of (CG-292, CG-295): the chip, its sheet with Stop. */}
              <RemoteHelpChip />
            </span>
          )}
        </header>
        <main
          className={styles.main}
          data-notes={notes.length || undefined}
          // A QR code makes a note or the title taller: the sign gets a little smaller so all of it fits.
          data-tight={tight || undefined}
        >
          {!celebrating && <ReachNotes notes={notes} />}
          {link && state.reach?.link ? (
            <LinkStarting screen={link} link={state.reach.link} now={serverNow} inApp={waitingInApp(state)} />
          ) : (
            <>
              {(scene === 'starting' || scene === 'waiting') && <Waking scene={scene} start={claim?.start} />}
              {(scene === 'claimable' || scene === 'backoff') && claim && (
                <Claimable
                  claim={claim}
                  backoff={scene === 'backoff'}
                  now={serverNow}
                  line={noAddressLine(state)}
                  client={client}
                  refresh={refresh}
                />
              )}
              {scene === 'claimed' && claim && !celebrating && (
                <Claimed claim={claim} noted={notes.length > 0} />
              )}
            </>
          )}
        </main>
        {state.footer && <footer className={styles.footer}>{state.footer}</footer>}
      </div>
      {celebrating && claim && <Celebration claim={claim} />}
      {/* Dims the whole screen, background included, to about 40 % (CG-09). */}
      <div className={styles.dim} style={{ opacity: b.dimmed ? 1 : 0 }} aria-hidden="true" />
    </div>
  );
}
