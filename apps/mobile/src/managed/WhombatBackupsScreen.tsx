/**
 * This Whombat → Backups. On a Whombat that lists its backups (Whombat backup-options.md; backup-options-android.md
 * AP-6850; app backup-v2.md AP-6880…): the top card, NEEDS YOU, BACKUPS · N, the line about asking the assistant and
 * Details (`BackupsOverview`), then ON YOUR NETWORK, “Bring back a Whombat you had” while it started fresh and MOVE TO
 * ANOTHER WHOMBAT (the backup file); one backup opens its page and Options the options screen. In the demo world the
 * same parts over the demo's box (AP-6864). While the backup service isn't answering the same page says so on the top
 * card and keeps what it knows (`backupPageShown`). A box from before (`unknown_op`), or one without a destination yet,
 * shows what it showed before:
 *
 * This Whombat → Backups (managed only; this-whombat-sections-android.md AP-1246), the web's Backups part (Whombat
 * this-whombat-sections.md AP-1228) on its own screen: BACKUPS — where they stand (“Unprotected” without a
 * destination; the NAS or server that keeps them), what they cover and what they don't, choosing where they go (every
 * kind the Whombat takes, AP-260) or backing up now — then ON YOUR NETWORK (the places that can keep them,
 * backup-places.md AP-6717), on a Whombat from before the passkey RECOVERY KIT (made from here; none is a quiet row,
 * BX-01, AP-3527), then the backup file (its own screen, backup-file-android.md AP-1211). Opened from the Overview;
 * its “Set up backups” opens it with the destination form open (`setUp`, dropped once read); a link that says a bring
 * back waits (`bringBack`, the Inbox's Finish and Try again) opens the bring back flow where it stands.
 */

import { useNavigation } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { backupFileText } from '@whombat/client';
import {
  accountsText,
  ago,
  BACKUP_KINDS,
  backupBlocksText,
  backupDetailLines,
  backupFixText,
  backupHero,
  backupOptionsText,
  backupPageShown,
  bringBackLaterOffered,
  coverageGaps,
  earlierPlacesLine,
  scopeLabels,
  thisWhombatText,
} from '@whombat/client/managed';
import {
  useBackupCheckpoints,
  useBackupPageNotes,
  useBackupPolicy,
  useCheckBackup,
  useReloadBackupOptions,
  useStartChat,
} from '@whombat/client/react';
import { type ApplianceSession, sessionOps } from '@whombat/client/session';
import { type ReactNode, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { startedChatRoute } from '../data/chatRoom';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import { navigateTo } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { BackupDestinationForm, backupErrorText, savedNotes } from './BackupDestination';
import { BackupPlacesCard, CurrentPlaceRow } from './BackupPlaces';
import {
  BackupDetailsCard,
  BackupDustyLine,
  BackupEarlierLine,
  BackupHeroCard,
  BackupList,
  BackupNeedsYou,
  type HeroPasskey,
} from './BackupsOverview';
import { useBackupPasskeyTap } from './backupPasskey';
import { useManaged, useManagedOrThrow } from './context';
import { managedCopy, managedText } from './copy';
import { sharePaperCopy } from './paperCopy';
import { Card, type Dot, Note, Row } from './ui';
import { useApplianceStatus } from './useApplianceStatus';
import { useBackupPlaceName, useBackupServiceStatus, useBackupSession } from './useBackups';

type Props = NativeStackScreenProps<RootStackParamList, 'WhombatBackups'>;

/** How long “Backed up just now” stands after Back up now. */
const JUST_NOW_MS = 90_000;

export function WhombatBackupsScreen(props: Props) {
  return useManaged() ? <ManagedBackups {...props} /> : <DemoBackups {...props} />;
}

/**
 * The top card, NEEDS YOU, the list, the assistant's line and Details (AP-6851); `children` (the places, bringing one
 * back later, the backup file) under them.
 */
function BackupsParts({
  session,
  passkey,
  paper,
  lastKnownAt = null,
  onChanged,
  children,
}: {
  session: ApplianceSession;
  /** The passkey's touch here (null: this phone can't, the line says where). */
  passkey: HeroPasskey['tap'];
  /** The paper copy's way out (null: the demo world has none). */
  paper: ((way: 'print' | 'file') => Promise<void>) | null;
  /** When the Whombat last said a backup finished (`appliance.status`), for while the backup service can't say. */
  lastKnownAt?: string | null;
  onChanged?: () => void;
  children?: ReactNode;
}) {
  const { rawLocale } = useI18n();
  const navigation = useNavigation<Props['navigation']>();
  const agent = useAgentWords();
  const { slug } = useBurrowBase();
  const checkpoints = useBackupCheckpoints(session);
  const policy = useBackupPolicy(session);
  const service = useBackupServiceStatus(session);
  const notes = useBackupPageNotes(session);
  const placeName = useBackupPlaceName(session);
  const reload = useReloadBackupOptions();
  const check = useCheckBackup(session);
  const start = useStartChat(slug);
  const [busy, setBusy] = useState(false);
  const [justNowAt, setJustNowAt] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const [paperBusy, setPaperBusy] = useState(false);
  const [paperError, setPaperError] = useState<string | null>(null);
  const list = checkpoints.data ?? null;
  const hero = backupHero({
    locale: rawLocale,
    status: service.data?.status ?? null,
    summary: service.data?.summary ?? null,
    policy: policy.data?.policy ?? null,
    list,
    placeName,
    running: busy,
    justNow: justNowAt !== null && Date.now() - justNowAt < JUST_NOW_MS,
    notice: notes.data?.notice ?? null,
    lastKnownAt,
  });
  // `backup.runNow` answers once the backup is made: the card says so then, not that it started.
  const runNow = async () => {
    setBusy(true);
    setNote(null);
    setJustNowAt(null);
    try {
      await sessionOps.backupRunNow(session);
      setJustNowAt(Date.now());
      await reload();
      onChanged?.();
    } catch (error) {
      setNote(backupErrorText(error, rawLocale));
    } finally {
      setBusy(false);
    }
  };
  // *Ask {assistant} to fix it*: what is wrong goes to the assistant in its own thread, as the Inbox's button does.
  const askFix = async () => {
    setNote(null);
    const result = await start.mutateAsync({ text: backupFixText(hero, rawLocale) }).catch(() => null);
    if (result?.status === 'ok')
      navigateTo(
        navigation as never,
        startedChatRoute(result.data, thisWhombatText(rawLocale).parts.backups),
      );
    else setNote(backupErrorText(null, rawLocale));
  };
  const makePaper = async (way: 'print' | 'file') => {
    if (!paper) return;
    setPaperBusy(true);
    setPaperError(null);
    try {
      await paper(way);
      await reload();
    } catch {
      setPaperError(backupOptionsText(rawLocale).paper.failed);
    } finally {
      setPaperBusy(false);
    }
  };
  const newest = list?.checkpoints[0] ?? null;
  return (
    <>
      <BackupHeroCard
        hero={hero}
        busy={busy}
        note={note}
        onBackUpNow={() => void runNow()}
        onOptions={policy.data ? () => navigation.navigate('BackupOptions') : null}
        askFix={{
          label: backupOptionsText(rawLocale).askFix(agent.name),
          busy: start.isPending,
          onPress: () => void askFix(),
        }}
        passkey={{
          tap: passkey,
          onArmed: () => {
            void reload();
            onChanged?.();
          },
        }}
      />
      <BackupNeedsYou session={session} local={list?.local ?? null} placeName={placeName} />
      {list ? (
        <BackupList
          list={list}
          keep={policy.data?.policy.keep ?? null}
          onOpen={(checkpointId) => navigation.navigate('BackupDetail', { checkpointId })}
        />
      ) : null}
      {list ? <BackupEarlierLine text={earlierPlacesLine(notes.data?.earlierPlaces, rawLocale)} /> : null}
      <BackupDustyLine agent={agent.name} />
      <BackupDetailsCard
        lines={backupDetailLines({
          locale: rawLocale,
          status: service.data?.status ?? null,
          clearedBy: policy.data?.clearedBy ?? null,
          placeName,
        })}
        checking={check.isPending}
        checkNote={checkNote}
        onCheckNewest={
          newest
            ? () =>
                check.mutate(newest.id, {
                  onSuccess: () => setCheckNote(backupOptionsText(rawLocale).detail.checkQueued),
                  onError: (e) => setCheckNote(backupErrorText(e, rawLocale)),
                })
            : null
        }
        paper={
          paper
            ? {
                paperAt: service.data?.summary.bringBack?.paperAt ?? null,
                busy: paperBusy,
                error: paperError,
                onPrint: () => void makePaper('print'),
                onFile: () => void makePaper('file'),
              }
            : null
        }
      />
      {children}
    </>
  );
}

/** The demo world's Backups (AP-6864): the new parts over the demo's box; places, kit and file are a Whombat's. */
function DemoBackups({ navigation }: Props) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);
  const managedTextHere = managedText(rawLocale);

  const bottomRoom = useBottomRoom();
  const session = useBackupSession();
  return (
    <Screen>
      <BackBar label={managedCopyHere.whombat.title} onPress={() => navigation.goBack()} />
      <ScrollView contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}>
        <LargeTitle title={thisWhombatText(rawLocale).parts.backups} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }}>
          {session ? (
            <BackupsParts session={session} passkey={null} paper={null} />
          ) : (
            <ErrorState text={managedTextHere.loadError} />
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

function ManagedBackups({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);
  const managedTextHere = managedText(rawLocale);

  const scopeLabelsHere = scopeLabels(rawLocale);

  const bottomRoom = useBottomRoom();
  const managed = useManagedOrThrow();
  const { status, error, reload } = useApplianceStatus({ follow: false });
  const checkpoints = useBackupCheckpoints(managed.session);
  const policy = useBackupPolicy(managed.session);
  const notes = useBackupPageNotes(managed.session);
  const tap = useBackupPasskeyTap();
  const shown = backupPageShown({
    list: { pending: checkpoints.isPending, failed: checkpoints.isError },
    policy: { pending: policy.isPending, failed: policy.isError },
    notice: notes.isPending ? undefined : (notes.data?.notice ?? null),
  });
  // “Set up backups” on the Overview: the destination form opens at once; the param goes, so a restored screen doesn't.
  const [setUp] = useState(route.params?.setUp === true);
  useEffect(() => {
    if (route.params?.setUp) navigation.setParams({ setUp: undefined });
  }, [route.params?.setUp, navigation]);
  // The Inbox's Finish and Try again (and a push about it): the bring back flow, where the restore stands.
  const bringBack = route.params?.bringBack;
  const onBringBack = managed.onBringBack;
  useEffect(() => {
    if (!bringBack) return;
    navigation.setParams({ bringBack: undefined });
    onBringBack?.(false);
  }, [bringBack, navigation, onBringBack]);
  const back = (
    <BackBar
      label={managedCopyHere.whombat.title}
      onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Whombat'))}
    />
  );
  if (error)
    return (
      <Screen>
        {back}
        <ErrorState text={managedTextHere.loadError} onRetry={reload} />
      </Screen>
    );
  if (!status || shown === 'loading')
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const b = status.backup;
  // A Whombat that knows the passkey (it says `bringBack`) needs no recovery kit for its backups.
  const onKit = b.bringBack ? undefined : managed.onKit;
  const laterOffered =
    !!onBringBack &&
    b.bringBack !== undefined &&
    bringBackLaterOffered({ list: checkpoints.data ?? null, unprotected: b.state === 'unprotected' });
  const later = laterOffered && onBringBack ? <BringBackLaterCard onPress={() => onBringBack(true)} /> : null;
  const name = managed.applianceName ?? managed.applianceId;
  // The new page where the box lists its backups and has a place for them, also while its backup service isn't
  // answering (it says so and keeps what it knows); else what it showed before.
  if ((shown === 'yes' || shown === 'down') && b.state !== 'unprotected') {
    return (
      <Screen>
        {back}
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}
        >
          <LargeTitle title={thisWhombatText(rawLocale).parts.backups} />
          <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }}>
            <BackupsParts
              session={managed.session}
              passkey={tap}
              paper={(way) =>
                sharePaperCopy({
                  locale: rawLocale,
                  session: managed.session,
                  way,
                  name,
                  peerId: managed.appliancePeerId,
                  device: managed.applianceId,
                })
              }
              lastKnownAt={b.lastSuccessAt}
              onChanged={reload}
            >
              <BackupPlacesCard onChanged={reload} onKit={onKit} />
              <Card>
                <BackupActions
                  unprotected={false}
                  openAtFirst={setUp}
                  onKit={onKit}
                  onChanged={reload}
                  where
                />
              </Card>
              {later}
              <BackupFileCard onOpen={() => navigation.navigate('BackupFile')} />
            </BackupsParts>
          </View>
        </ScrollView>
      </Screen>
    );
  }
  const { gaps, onPurpose } = coverageGaps(b.unprotected);
  const backupDot: Dot =
    b.state === 'protected' ? 'ok' : b.state === 'pending' ? 'mut' : b.state === 'stale' ? 'warn' : 'bad';
  return (
    <Screen>
      {back}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}
      >
        <LargeTitle title={thisWhombatText(rawLocale).parts.backups} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }}>
          <Card label={managedTextHere.backups}>
            <Row
              first
              dot={backupDot}
              title={managedTextHere.backup[b.state]}
              meta={
                b.state === 'unprotected'
                  ? `${managedTextHere.backup.unprotectedMeta} ${backupBlocksText(status, rawLocale) ?? ''}`.trim()
                  : [
                      b.lastSuccessAt
                        ? managedTextHere.backup.last(ago(b.lastSuccessAt, rawLocale))
                        : managedTextHere.backup.none,
                      b.lastFailure?.reason,
                      b.recoverable ? managedTextHere.backup.recoverable : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')
              }
            />
            {/* The NAS or server that keeps them, when one does (backup-places.md AP-6718). */}
            <CurrentPlaceRow />
            {b.coverage.length > 0 ? (
              <Row
                title={managedTextHere.backup.covers}
                meta={`${b.coverage.map((c) => scopeLabelsHere[c] ?? c).join(', ')}${b.relogin.length ? `. ${managedTextHere.backup.relogin}` : ''}`}
              />
            ) : null}
            {/* A real gap warns; what the backup leaves out by design is a quiet line that says why. */}
            {gaps.length > 0 ? (
              <Row
                dot="warn"
                title={managedTextHere.backup.notCovered}
                meta={gaps.map((c) => scopeLabelsHere[c] ?? c).join(', ')}
              />
            ) : null}
            {onPurpose.length > 0 ? (
              <Row
                title={managedTextHere.backup.onPurpose}
                meta={managedTextHere.backup.onPurposeMeta(
                  onPurpose.map((c) => scopeLabelsHere[c] ?? c).join(', '),
                )}
              />
            ) : null}
            <BackupActions
              unprotected={b.state === 'unprotected'}
              openAtFirst={setUp}
              onKit={onKit}
              onChanged={reload}
            />
          </Card>

          <BackupPlacesCard onChanged={reload} onKit={onKit} />

          {later}

          {onKit ? (
            <Card label={managedTextHere.kit}>
              {status.recovery.kitVerified ? (
                <Row first dot="ok" title={managedTextHere.kitSaved} meta={managedTextHere.kitSavedMeta} />
              ) : (
                // No kit isn't a warning (BX-01, AP-3527): the box's screen lets a device back in.
                <Row
                  first
                  dot="mut"
                  title={managedTextHere.kitMissing}
                  meta={
                    status.recovery.rotationPending
                      ? managedTextHere.kitRotationPending
                      : managedTextHere.kitMissingMeta
                  }
                  action={<Button label={managedTextHere.kitMake} variant="secondary" onPress={onKit} />}
                />
              )}
            </Card>
          ) : null}

          <BackupFileCard onOpen={() => navigation.navigate('BackupFile')} />
        </View>
      </ScrollView>
    </Screen>
  );
}

/** “Bring back a Whombat you had”, while this one started fresh (backup-options.md BKO-29): its flow asks first. */
function BringBackLaterCard({ onPress }: { onPress: () => void }) {
  const { rawLocale } = useI18n();
  const L = backupOptionsText(rawLocale).later;
  return (
    <Card label={backupOptionsText(rawLocale).bringBack.kicker}>
      <Row
        first
        title={L.title}
        meta={L.meta}
        action={<Button label={L.button} variant="secondary" onPress={onPress} />}
      />
    </Card>
  );
}

/**
 * Next to the automatic backups: a file of what you choose, downloaded or restored (AP-1211), for moving to another
 * Whombat (one line says when; the backups keep this one safe already).
 */
function BackupFileCard({ onOpen }: { onOpen: () => void }) {
  const { rawLocale } = useI18n();
  const backupFileTextHere = backupFileText(rawLocale);
  const managedCopyHere = managedCopy(rawLocale);

  return (
    <Card label={backupFileTextHere.section}>
      <Row
        first
        title={managedCopyHere.backupFile.title}
        meta={backupFileTextHere.when}
        action={
          <Button
            label={managedCopyHere.backupFile.open}
            variant="secondary"
            accessibilityHint={managedCopyHere.backupFile.openHint}
            onPress={onOpen}
          />
        }
      />
    </Card>
  );
}

/**
 * Choose where backups go (every kind the Whombat takes, AP-260), or run a backup now. `openAtFirst` opens the
 * destination form at once (the Overview's “Set up backups”).
 */
function BackupActions({
  unprotected,
  openAtFirst,
  onKit,
  onChanged,
  where = false,
}: {
  unprotected: boolean;
  openAtFirst: boolean;
  /** A Whombat from before the passkey: a new place needs a new recovery kit. Absent: nothing to save. */
  onKit?: (() => void) | undefined;
  onChanged: () => void;
  /** Only choosing where they go (the new page has Back up now in its top card). */
  where?: boolean;
}) {
  const { rawLocale } = useI18n();
  const { session } = useManagedOrThrow();
  const kinds = BACKUP_KINDS;
  const [open, setOpen] = useState(openAtFirst);
  const [notes, setNotes] = useState<string[]>([]);
  const [kitNeeded, setKitNeeded] = useState(false);
  const [busy, setBusy] = useState(false);

  const runNow = async () => {
    setBusy(true);
    setNotes([]);
    try {
      await sessionOps.backupRunNow(session);
      setNotes([accountsText(rawLocale).backedUp]);
    } catch (error) {
      setNotes([backupErrorText(error, rawLocale)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={{ padding: 16, gap: 12, borderTopWidth: 1, borderTopColor: 'transparent' }}>
      {open ? (
        <BackupDestinationForm
          session={session}
          kinds={kinds}
          onSaved={(result) => {
            setOpen(false);
            setNotes(savedNotes(result, rawLocale));
            setKitNeeded(!!onKit);
            onChanged();
          }}
          extraActions={
            <Button
              label={accountsText(rawLocale).cancel}
              variant="secondary"
              onPress={() => setOpen(false)}
            />
          }
        />
      ) : (
        <>
          {notes.map((note) => (
            <Note key={note} text={note} />
          ))}
          {kitNeeded && onKit ? (
            <>
              <Note text={accountsText(rawLocale).newKit} />
              <Button label={accountsText(rawLocale).saveKit} variant="secondary" onPress={onKit} />
            </>
          ) : null}
          <Button label={accountsText(rawLocale).setUp} variant="secondary" onPress={() => setOpen(true)} />
          {!unprotected && !where ? (
            <Button
              label={accountsText(rawLocale).runNow}
              variant="secondary"
              busy={busy}
              onPress={() => void runNow()}
            />
          ) : null}
        </>
      )}
    </View>
  );
}
