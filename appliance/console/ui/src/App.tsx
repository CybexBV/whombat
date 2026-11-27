import { WhombatLogo } from '@whombat/brand/react';
import { type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BluetoothInitial } from './bluetooth/BluetoothLayer';
import { Console } from './console/Console';
import type { DeskInitial } from './desk/Desk';
import type { RemoteHelpInitial } from './desk/RemoteHelp';
import { browserLocale, DEFAULT_LOCALE, formatLocale, type InstallerLocale } from './i18n/locale';
import { Translation } from './i18n/react';
import { translator } from './i18n/translate';
import { Installer } from './installer/Installer';
import type { ConsoleState } from './lib/api';
import type { Client } from './lib/client';
import { consoleCopy } from './lib/copy';

import type { DeskState } from './lib/desk';
import {
  type DeskHold,
  heldDesk,
  holdDesk,
  lockedDesk,
  NO_HOLD,
  type ShownDesk,
  shownDesk,
  unlockLapsed,
} from './lib/deskHold';
import { DESK_STAGE, deskActive } from './lib/deskScene';
import type { Wizard } from './lib/installer';
import { type KioskOutput, placeOutputs } from './lib/outputs';
import styles from './ui/app.module.css';
import { useServer, useWindowSize } from './ui/hooks';
import { OutputsFrame } from './ui/Outputs';
import { Stage } from './ui/Stage';
import type { WifiInitial } from './wifi/WifiLayer';

export interface AppProps {
  client: Client;
  /** Fixtures only. */
  wizard?: Partial<Wizard>;
  idleMs?: number;
  desk?: DeskInitial;
  wifi?: WifiInitial;
  bluetooth?: BluetoothInitial;
  remoteHelp?: RemoteHelpInitial;
  /** The box's outputs as the kiosk names them (the URL's `o=`); null: the whole window is one. */
  outputs?: KioskOutput[] | null;
}

/**
 * One page, two modes, chosen by the server's `mode` (CG-02); the console turns into the desk display when Whombat
 * paired its screen (CG-37), on the desk's 1280×800 stage (CG-38), keeps it through a runtime restart (CG-49), and
 * locks an unlocked desk it can't vouch for: the polls failing or Whombat's `until` passed (CG-51).
 */
export function App(props: AppProps) {
  const { width, height } = useWindowSize();
  const outputs = props.outputs ?? null;
  // One screen per output: the page in the main one's rectangle, the monitors' screens beside it.
  const placed = useMemo(() => placeOutputs({ width, height }, outputs), [width, height, outputs]);
  return (
    <OutputsFrame placed={placed}>
      <Page {...props} />
    </OutputsFrame>
  );
}

function Page({ client, wizard, idleMs, desk, wifi, bluetooth, remoteHelp }: AppProps): ReactNode {
  const { state, offset, connection, refresh } = useServer(client);
  const [browser] = useState(() => browserLocale(navigator.languages));
  const [choice, setChoice] = useState<InstallerLocale | undefined>(readInstallerLocale);
  const save = useRef(Promise.resolve());
  const chooseLocale = (locale: InstallerLocale) => {
    setChoice(locale);
    try {
      localStorage.setItem(INSTALLER_LOCALE_KEY, locale);
    } catch {
      // The installer may run with browser storage disabled.
    }
    save.current = save.current.then(async () => {
      await client.post('/api/locale', { locale }).catch(() => null);
    });
  };
  // The last paired desk, kept locked for up to 10 minutes while Whombat sends none (it restarts). The page re-renders
  // after every poll, so the memory and the 10 minutes follow each answer.
  const hold = useRef<DeskHold>(NO_HOLD);
  const locale =
    state?.mode === 'installer'
      ? (choice ?? state.locale ?? browser)
      : (state?.desk?.paired?.locale ??
        state?.locale ??
        (state?.claim?.state === 'claimed'
          ? ((!state.desk?.paired ? hold.current.last?.paired?.locale : undefined) ?? DEFAULT_LOCALE)
          : browser));
  const t = useMemo(() => translator(locale), [locale]);
  useLayoutEffect(() => {
    document.documentElement.lang = formatLocale(t.locale);
  }, [t]);
  const CONSOLE = consoleCopy(t);
  const locked = useRef<{ from: DeskState | null; desk: DeskState | null }>({ from: null, desk: null });
  const lapsed = useRef<{ from: DeskState | null; desk: DeskState | null }>({ from: null, desk: null });
  let shown: ShownDesk | null = null;
  if (state?.mode === 'console') {
    const now = Date.now();
    hold.current = holdDesk(hold.current, state, now);
    const last = hold.current.last;
    if (locked.current.from !== last) locked.current = { from: last, desk: last ? heldDesk(last, t) : null };
    shown = shownDesk(hold.current, state, now, locked.current.desk, t);
    // The last state says unlocked, but the polls fail (Whombat may have locked it since) or its time ran out: the
    // screen shows it locked and trimmed, as through a restart, until Whombat answers again.
    const d = shown.desk;
    if (d && unlockLapsed(d.lock, now + offset, connection !== 'ok')) {
      if (lapsed.current.from !== d) lapsed.current = { from: d, desk: lockedDesk(d, t) };
      shown = { ...shown, desk: lapsed.current.desk };
    }
  }
  const lost = connection === 'lost' || shown?.reconnecting === true;
  if (!state) {
    return (
      <Stage>
        <div className={styles.blank}>
          <WhombatLogo variant="symbol" height={72} label="Whombat" />
          <p className={styles.blankText} style={{ visibility: lost ? 'visible' : 'hidden' }} role="status">
            {CONSOLE.connecting}
          </p>
        </div>
      </Stage>
    );
  }
  const con: ConsoleState | null =
    state.mode === 'console'
      ? shown && shown.desk !== state.desk
        ? { ...state, desk: shown.desk }
        : state
      : null;
  const onDesk = con !== null && deskActive(con);
  return (
    <Translation.Provider value={t}>
      <Stage base={onDesk ? DESK_STAGE : undefined}>
        {state.mode === 'installer' ? (
          <Installer
            state={state}
            client={client}
            refresh={refresh}
            initial={wizard}
            wifi={wifi}
            onLocale={chooseLocale}
          />
        ) : (
          con && (
            <Console
              state={con}
              held={shown?.held ?? false}
              offset={offset}
              idleMs={idleMs}
              client={client}
              refresh={refresh}
              desk={desk}
              wifi={wifi}
              bluetooth={bluetooth}
              remoteHelp={remoteHelp}
            />
          )
        )}
        {con?.alert && (
          <div className={styles.alert} role="alert">
            <strong className={styles.alertTitle}>{CONSOLE.alertForeignTitle}</strong>
            <span>{CONSOLE.alertForeign}</span>
          </div>
        )}
        {lost && (
          <p className={styles.away} role="status">
            {CONSOLE.reconnecting}
          </p>
        )}
      </Stage>
    </Translation.Provider>
  );
}

const INSTALLER_LOCALE_KEY = 'whombat-installer-locale';

function readInstallerLocale(): InstallerLocale | undefined {
  try {
    const locale = localStorage.getItem(INSTALLER_LOCALE_KEY);
    if (locale === 'en-GB' || locale === 'nl-NL') return locale;
  } catch {
    // The installer may run with browser storage disabled.
  }
}
