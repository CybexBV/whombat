/**
 * Protect your Whombat's places, what is there first (Whombat first-day.md): a NAS the network scan found, where “Let
 * {assistant} set it up” is the person's yes (`backup.letAssistantSetUp`, backup-options.md BKO-30: the assistant sets
 * it up once the AI is connected and says when the first backup is done), then a USB disk named WHOMBAT-BACKUP in one
 * tap; a bucket, SFTP and a restic REST server fold under Other places, as the form Settings has. Skip leads on, and the
 * assistant's proposal comes back in Needs you.
 */
import { agentWords, createClient } from '@whombat/client';
import {
  BACKUP_SETUP_TEXT,
  backupErrorText,
  CLAIM_FOUND_POLL,
  destinationInput,
  emptyBackupForm,
  PROTECT_OTHER_KINDS,
  protectFoundPlace,
  readClaimFound,
  readClaimWorld,
} from '@whombat/client/managed';
import { type ApplianceSession, type BackupDestinationResult, sessionOps } from '@whombat/client/session';
import type { DiscoveredService } from '@whombat/core';
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../components/Button';
import { BackupDestinationForm } from '../features/settings/BackupDestination';
import styles from './ProtectPlaces.module.css';

const T = BACKUP_SETUP_TEXT;
const P = T.places;

export function ProtectPlaces({
  session,
  onSaved,
  onAssistant,
  onDone,
}: {
  session: ApplianceSession;
  onSaved: (result: BackupDestinationResult) => void;
  /** “Let {assistant} set it up” was kept: what to say before going on. */
  onAssistant?: (said: string) => void;
  /** On to the next step (Skip, or a Whombat from before that can't keep the yes). */
  onDone: () => void;
}) {
  const client = useMemo(() => createClient({ session }), [session]);
  const [world, setWorld] = useState<{ assistant: string | null; found: DiscoveredService[] }>({
    assistant: null,
    found: [],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [other, setOther] = useState(false);
  // The first scan runs about a minute after the claim: ask again while it looks, so a NAS shows once it is found.
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = (burrow: string, left: number) => {
      timer = setTimeout(() => {
        void readClaimFound(client, burrow).then((f) => {
          if (!live) return;
          setWorld((w) => ({ ...w, found: f.found }));
          if (f.scanning && left > 1) again(burrow, left - 1);
        });
      }, CLAIM_FOUND_POLL.ms);
    };
    void readClaimWorld(client).then((w) => {
      if (!live) return;
      setWorld({ assistant: w.assistant, found: w.found });
      if (w.burrow && w.scanning) again(w.burrow, CLAIM_FOUND_POLL.times);
    });
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [client]);
  const words = agentWords(world.assistant);
  const nas = protectFoundPlace(world.found);

  // The person's yes: kept on the Whombat, which the assistant carries out once the AI is connected.
  const letAssistant = async () => {
    setBusy(true);
    setError(null);
    try {
      await sessionOps.backupLetAssistantSetUp(session);
      if (onAssistant) onAssistant(P.letAssistantSaid(words.Name));
      else onDone();
    } catch {
      // A Whombat from before the yes: the proposal in the Inbox asks again, as Skip leaves it.
      onDone();
    } finally {
      setBusy(false);
    }
  };

  const chooseDisk = async () => {
    const check = destinationInput(emptyBackupForm('disk'));
    if (!check.ok) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await sessionOps.backupConfigure(session, check.input));
    } catch (err) {
      setError(backupErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.places}>
      {nas ? (
        <section className={styles.place} aria-label={nas.title}>
          <span className={styles.meta}>{P.foundMeta}</span>
          <h2 className={styles.title}>{nas.title}</h2>
          <p className={styles.body}>{P.foundBody(words.Name)}</p>
          <div className={styles.actions}>
            <Button variant="primary" size="lg" disabled={busy} onClick={() => void letAssistant()}>
              {P.letAssistant(words.Name)}
            </Button>
          </div>
        </section>
      ) : null}
      <section className={styles.place} aria-label={P.diskTitle}>
        <h2 className={styles.title}>{P.diskTitle}</h2>
        <p className={styles.body}>{P.diskMeta}</p>
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button
            variant={nas ? 'secondary' : 'primary'}
            size="lg"
            onClick={() => void chooseDisk()}
            disabled={busy}
          >
            {busy ? P.usingDisk : P.useDisk}
          </Button>
        </div>
      </section>
      <section className={styles.other}>
        <button
          type="button"
          className={styles.fold}
          aria-expanded={other}
          onClick={() => setOther((open) => !open)}
        >
          <span className={styles.foldTitle}>{P.other}</span>
          <span className={styles.meta}>{P.otherMeta}</span>
        </button>
        {other ? (
          <BackupDestinationForm session={session} kinds={PROTECT_OTHER_KINDS} size="lg" onSaved={onSaved} />
        ) : null}
      </section>
      <div className={styles.actions}>
        <Button variant="link" onClick={onDone}>
          {T.skip}
        </Button>
      </div>
      {/* The found place's card says it already. */}
      {nas ? null : <p className={styles.note}>{P.later(words.Name)}</p>}
    </div>
  );
}
