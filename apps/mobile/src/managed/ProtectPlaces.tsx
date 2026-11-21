/**
 * Protect your Whombat's places on the phone, what is there first (Whombat first-day.md): a NAS the network scan found,
 * where “Let {assistant} set it up” is the person's yes (`backup.letAssistantSetUp`, backup-options.md BKO-30: the
 * assistant sets it up once the AI is connected and says when the first backup is done), then a USB disk named
 * WHOMBAT-BACKUP in one tap; a bucket, SFTP and a restic REST server fold under Other places.
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
import { View } from 'react-native';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { BackupDestinationForm } from './BackupDestination';
import { Card, ErrorLine, Note } from './ui';

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
  /** On (Skip, or a Whombat from before that can't keep the yes). */
  onDone: () => void;
}) {
  const theme = useTheme();
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

  const place = (title: string, body: string, meta: string | null, action: React.ReactNode) => (
    <Card>
      <View style={{ padding: 16, gap: 8 }}>
        {meta ? (
          <Text size={11} weight={500} mono color={theme.colors.mut}>
            {meta.toUpperCase()}
          </Text>
        ) : null}
        <Text size={17} weight={700}>
          {title}
        </Text>
        <Text size={14} lh={1.45} color={theme.colors.ink2}>
          {body}
        </Text>
        {action}
      </View>
    </Card>
  );

  return (
    <>
      {nas
        ? place(
            nas.title,
            P.foundBody(words.Name),
            P.foundMeta,
            <Button
              label={P.letAssistant(words.Name)}
              size="lg"
              busy={busy}
              onPress={() => void letAssistant()}
            />,
          )
        : null}
      {place(
        P.diskTitle,
        P.diskMeta,
        null,
        <>
          <ErrorLine text={error} />
          <Button
            label={busy ? P.usingDisk : P.useDisk}
            variant={nas ? 'secondary' : 'primary'}
            size="lg"
            busy={busy}
            onPress={() => void chooseDisk()}
          />
        </>,
      )}
      <Button
        label={`${other ? '▾' : '▸'} ${P.other}`}
        variant="quiet"
        accessibilityHint={P.otherMeta}
        onPress={() => setOther((open) => !open)}
      />
      {other ? (
        <BackupDestinationForm session={session} kinds={PROTECT_OTHER_KINDS} onSaved={onSaved} />
      ) : null}
      <Button label={T.skip} variant="secondary" size="lg" onPress={onDone} />
      {/* The found place's card says it already. */}
      {nas ? null : <Note text={P.later(words.Name)} />}
    </>
  );
}
