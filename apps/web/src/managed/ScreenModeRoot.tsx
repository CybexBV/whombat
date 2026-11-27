/**
 * *Use as a screen* on a device that isn't let in (Whombat desk-display.md DK-146; desk-display-web.md AP-5960, AP-5961):
 * the screen page with its own endpoint key (the `screen` slot, so this browser can also be a person's device), its
 * sessions to the Whombat made by the page that offers it (the box's own page, or the hosted app's pairing), and what it
 * keeps per Whombat in this browser (that it's in screen mode, and its screen once added).
 */
import { displayEnrolApi, screenApi } from '@whombat/client/desk';
import type { ApplianceSession } from '@whombat/client/session';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../components/Button';
import { screenDeviceLabel } from '../features/screens/screenMode/model';
import {
  type ScreenModeDeps,
  ScreenModePage,
  type ScreenRecord,
} from '../features/screens/screenMode/ScreenMode';
import { COPY } from '../i18n/managed';
import {
  deleteEndpointKey,
  type EndpointKey,
  EndpointKeyUnavailableError,
  type EndpointKeyUnavailableReason,
  loadOrCreateEndpointKey,
} from './keys';
import { ConnectionGate } from './screens';

/** Where this browser keeps a Whombat's screen mode: on, and the screen it became. */
const storeKey = (whombat: string) => `whombat:screen-mode:${whombat}`;

type Stored = { on: true; screen: ScreenRecord | null };

function read(whombat: string): Stored | null {
  try {
    const raw = localStorage.getItem(storeKey(whombat));
    const v = raw ? (JSON.parse(raw) as Stored) : null;
    return v?.on === true ? v : null;
  } catch {
    return null;
  }
}

function write(whombat: string, value: Stored | null) {
  try {
    if (value) localStorage.setItem(storeKey(whombat), JSON.stringify(value));
    else localStorage.removeItem(storeKey(whombat));
  } catch {
    // A browser that keeps nothing asks for the letters again after a reload.
  }
}

/** Whether this browser was left showing a Whombat's screen (a reload opens it again). */
export function screenModeOn(whombat: string): boolean {
  return read(whombat) !== null;
}

/** Turns screen mode on for a Whombat (its letters next). */
export function startScreenMode(whombat: string) {
  write(whombat, { on: true, screen: read(whombat)?.screen ?? null });
}

export function ScreenModeRoot({
  whombat,
  connect,
  onLeave,
}: {
  /** The Whombat's id in this browser (its PeerId on the box's page, its device on the hosted app). */
  whombat: string;
  /** A session to the Whombat with this key: `enrol` while it waits for the letters, `screen` once it's a screen. */
  connect: (key: EndpointKey, as: 'enrol' | 'screen') => ApplianceSession;
  onLeave: () => void;
}) {
  const [key, setKey] = useState<EndpointKey | null>(null);
  const [noKey, setNoKey] = useState<EndpointKeyUnavailableReason | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    void round;
    let live = true;
    setNoKey(null);
    loadOrCreateEndpointKey({ slot: 'screen' }).then(
      (k) => live && setKey(k),
      (e) => live && setNoKey(e instanceof EndpointKeyUnavailableError ? e.reason : 'unsupported'),
    );
    return () => {
      live = false;
    };
  }, [round]);
  const deps = useMemo<ScreenModeDeps | null>(() => {
    if (!key) return null;
    const open = (as: 'enrol' | 'screen') => {
      const session = connect(key, as);
      session.connect();
      return session;
    };
    return {
      enrol() {
        const s = open('enrol');
        return { api: displayEnrolApi(s), close: () => s.close() };
      },
      screen() {
        const s = open('screen');
        return { api: screenApi(s), close: () => s.close() };
      },
      load: () => read(whombat)?.screen ?? null,
      save: (screen) => write(whombat, { on: true, screen }),
      label: screenDeviceLabel(navigator.userAgent, navigator.maxTouchPoints > 1),
      onLeave: () => {
        write(whombat, null);
        onLeave();
      },
      // A removed screen's key was revoked: a new one to become a screen again.
      onRemoved: () => {
        setKey(null);
        void deleteEndpointKey('screen').then(() => setRound((n) => n + 1));
      },
    };
  }, [key, connect, whombat, onLeave]);
  // Said, as on the person's own sign-in: an older software key isn't used here, and the screen starts again only when
  // someone chooses to forget it.
  if (noKey === 'weakKey')
    return (
      <ConnectionGate
        title={COPY.connection.weakKeyTitle}
        text={COPY.connection.weakKey}
        actions={
          <Button
            variant="primary"
            size="lg"
            onClick={() => void deleteEndpointKey('screen').then(() => setRound((n) => n + 1))}
          >
            {COPY.connection.weakKeyForget}
          </Button>
        }
      />
    );
  if (noKey)
    return (
      <ConnectionGate
        title={COPY.connection.signedOutTitle}
        text={COPY.connection.unsupported}
        actions={null}
      />
    );
  if (!deps) return null;
  return <ScreenModePage deps={deps} />;
}
