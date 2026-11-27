/**
 * Bringing a Whombat back, on the phone (Whombat backup-options.md BKO-11…BKO-13, BKO-21, BKO-29, BKO-34;
 * backup-passkey.md BPK-05, BPK-06; backup-options-android.md AP-6859…AP-6863; app backup-v2.md): right after the claim
 * “Is this a new Whombat?” (Start fresh goes on to where backups go, as before) → the passkey first (the account's
 * locked copy, else Look on my network for the copies next to the backups: it can take a minute), else the paper copy
 * (scanned, its file, or its text pasted) → `backup.adopt` joins the old Whombat's backups → choose one (the newest
 * first) → `backup.restore` → the steps while it works, asked every 3 s and through the box going quiet while its
 * runtime is stopped (the session reconnects by itself) → the one question (gone, or lost or stolen) →
 * `backup.finishRestore` → done, whose last line finishes the same passkey setup for access and backups, Open Chat.
 * A restore that stops says the service's plain words, with Try again and Start over.
 *
 * From the app's Backups (`later`): `resume` opens where a restore stands (finishing it, trying again); `replace` brings
 * one back on a Whombat that started fresh, after saying what's on it now is set aside (`backup.adopt` with `replace`).
 */

import { agentWords, createClient, theAgentOf } from '@whombat/client';
import {
  accountKitsToBringBack,
  type BringBackKit,
  backupOptionsText,
  bringBackName,
  type ControlApi,
  capital,
  kitFromScan,
  kitsFromNetwork,
  longDate,
  oldWhombatDoneLines,
  oldWhombatMeta,
  PasskeyCancelled,
  PasskeyError,
  type PasskeyPlatform,
  passkeyErrorText,
  passkeyName,
  restoreSteps,
  unlockKitWithPasskey,
} from '@whombat/client/managed';
import { useOnePasskeySetup } from '@whombat/client/managed/react';
import { type ApplianceSession, OperationError, sessionOps } from '@whombat/client/session';
import type { BackupCheckpoint, BackupRestoreState } from '@whombat/protocol/session';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { tint } from '../ui/glanceColors';
import { Check, Circle, CircleCheck, KeyRound, UserKey } from '../ui/icons';
import { RowChevron } from '../ui/ListRow';
import { Button } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { backupErrorText } from './BackupDestination';
import { Tag } from './BackupsOverview';
import {
  BACKUP_PHONE_TEXT,
  bringBackResume,
  chooseRows,
  defaultCheckpoint,
  foundKitNote,
  kitWhombatName,
  RESTORE_POLL_MS,
  restoredTime,
  restoreScreen,
} from './backupOptions';
import { phoneLabel } from './env';
import { QrScanner } from './QrScanner';
import type { KitPicker } from './screens';
import { ErrorLine, Field, Frame, Note } from './ui';

type Step =
  | { kind: 'question' }
  | { kind: 'replace' }
  | { kind: 'source' }
  | { kind: 'paste' }
  | { kind: 'opening' }
  | { kind: 'choose'; checkpoints: BackupCheckpoint[] }
  | { kind: 'working' }
  | { kind: 'almost' }
  | { kind: 'done' }
  | { kind: 'failed' };

export interface BringBackProps {
  session: ApplianceSession;
  control: ControlApi | null;
  platform: PasskeyPlatform | null;
  /** This new Whombat's identity: its own envelopes aren't offered, and the last step's passkey is for it. */
  appliancePeerId: string;
  /** This Whombat's name (“what’s on Home now is set aside”). */
  thisName?: string | null;
  email: string;
  pickKit: KitPicker;
  /** From the app's Backups: where a restore stands, or bringing one back on a Whombat that started fresh. */
  later?: 'resume' | 'replace';
  /** Start fresh: on to where backups go. */
  onFresh: () => void;
  /** Open Chat after it is back. */
  onDone: (name: string | null) => void;
  /** Away from the flow without bringing one back (from the app's Backups). */
  onCancel?: () => void;
}

/** One big choice card (Start fresh / Bring back a Whombat), the chosen one with the ink border. */
function ChoiceCard({
  title,
  meta,
  selected,
  onPress,
}: {
  title: string;
  meta: string;
  selected: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      feedback="wash"
      accessibilityRole="radio"
      accessibilityState={{ checked: selected, selected }}
      accessibilityLabel={`${title}. ${meta}`}
      onPress={onPress}
      ringRadius={18}
      style={{
        borderRadius: 18,
        borderWidth: selected ? 1.5 : 1,
        borderColor: selected ? theme.colors.ink : theme.colors.line,
        backgroundColor: theme.colors.sf,
        padding: 16,
        gap: 4,
        minHeight: 64,
      }}
    >
      <Text size={16.5} weight={600}>
        {title}
      </Text>
      <Text size={13.5} lh={1.45} color={theme.colors.mut}>
        {meta}
      </Text>
    </Touchable>
  );
}

function OkNote({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <View style={{ borderRadius: 14, padding: 14, backgroundColor: tint(theme.colors.ok, 0.12) }}>
      <Text size={14} lh={1.45} color={theme.colors.ink}>
        {text}
      </Text>
    </View>
  );
}

function LinkLine({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      feedback="wash"
      accessibilityRole="button"
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 48,
        paddingHorizontal: 14,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <Text size={15} weight={500} color={theme.colors.brand} style={{ flex: 1 }}>
        {label}
      </Text>
      <RowChevron />
    </Touchable>
  );
}

function Hint({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text size={13} lh={1.45} color={theme.colors.mut} style={{ textAlign: 'center', paddingHorizontal: 8 }}>
      {text}
    </Text>
  );
}

export function BringBackFlow(props: BringBackProps) {
  const { rawLocale } = useI18n();
  const B = backupOptionsText(rawLocale).bringBack;
  const { session, control, platform, later } = props;
  const theme = useTheme();
  const [step, setStep] = useState<Step | null>(null);
  const [choice, setChoice] = useState<'fresh' | 'back'>('fresh');
  const [kits, setKits] = useState<BringBackKit[] | null>(null);
  const [looking, setLooking] = useState<'idle' | 'looking' | 'none'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [pasted, setPasted] = useState('');
  const [name, setName] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [allRows, setAllRows] = useState(false);
  const [state, setState] = useState<BackupRestoreState | null>(null);
  const [reachable, setReachable] = useState(true);
  const [oldWhombat, setOldWhombat] = useState<'gone' | 'lost' | null>(null);
  const finished = useRef(false);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A restore under way here resumes; else the question (or, from the app, its own start), with the account's kits for
  // other Whombats (a retired one's included): the found note and the passkey's way in.
  useEffect(() => {
    let on = true;
    // Only kits a passkey the account still has opens: a removed one (a lost phone) isn't offered.
    void Promise.all([
      sessionOps.backupRestoreState(session).catch(() => null),
      accountKitsToBringBack(control, props.appliancePeerId),
    ]).then(([restore, found]) => {
      if (!on) return;
      setKits(found);
      if (found.length) setChoice('back');
      if (restore) setState(restore);
      const resume = bringBackResume(restore, !!later);
      if (resume) setStep({ kind: resume });
      else if (later === 'resume') props.onCancel?.();
      else setStep({ kind: later === 'replace' ? 'replace' : 'question' });
    });
    return () => {
      on = false;
    };
  }, [session, control, props.appliancePeerId, later, props.onCancel]);
  const kit = kits?.[0] ?? null;
  const place = null;

  const go = (next: Step) => {
    setError(null);
    setStep(next);
  };

  const adopt = async (text: string, whombat: string | null) => {
    go({ kind: 'opening' });
    try {
      const r = await sessionOps.backupAdopt(session, text, undefined, { replace: later === 'replace' });
      setName(whombat);
      setPicked(defaultCheckpoint(r.checkpoints));
      setStep({ kind: 'choose', checkpoints: r.checkpoints });
    } catch {
      setStep({ kind: 'source' });
      setError(B.adoptFailed);
    }
  };

  const fromText = (text: string): boolean => {
    const body = kitFromScan(text);
    if (!body) return false;
    void adopt(body, kitWhombatName(text) ?? kit?.whombatName ?? null);
    return true;
  };

  const unlock = async () => {
    if (!kit || !platform) return;
    setBusy(true);
    setError(null);
    try {
      const text = await unlockKitWithPasskey(platform, kit);
      if (!text || !kitFromScan(text)) {
        setError(B.unlockFailed);
        return;
      }
      await adopt(kitFromScan(text) as string, kit.whombatName ?? kitWhombatName(text));
    } catch (e) {
      if (e instanceof PasskeyCancelled) return;
      setError(
        e instanceof PasskeyError && e.code === 'unsupported'
          ? B.noPrf
          : (passkeyErrorText(e) ?? B.unlockFailed),
      );
    } finally {
      setBusy(false);
    }
  };

  /** “Look on my network”: the copies kept next to backups on this network (it can take about a minute). */
  const look = async () => {
    setError(null);
    setLooking('looking');
    const near = await kitsFromNetwork(session, props.appliancePeerId, control);
    if (!live.current) return;
    if (near.length) {
      setKits(near);
      setLooking('idle');
    } else setLooking('none');
  };

  const openFile = async () => {
    setError(null);
    const file = await props.pickKit().catch(() => null);
    if (!file) return;
    if (!fromText(file.text)) setError(B.wrongKit);
  };

  const restore = async (checkpointId = picked) => {
    if (!checkpointId) return;
    setBusy(true);
    setError(null);
    try {
      await sessionOps.backupRestore(session, checkpointId);
      finished.current = false;
      setState(null);
      setStep({ kind: 'working' });
    } catch (e) {
      // A refusal is an answer; a dropped connection is the runtime stopping for the restore.
      if (e instanceof OperationError) setError(backupErrorText(e, rawLocale));
      else setStep({ kind: 'working' });
    } finally {
      setBusy(false);
    }
  };

  /** Try again: the same backup when the failure names it, else the list to choose from again. */
  const tryAgain = async () => {
    const again = state?.restored?.checkpointId ?? picked;
    if (again) return restore(again);
    setBusy(true);
    try {
      const list = await sessionOps.backupCheckpoints(session);
      const theirs = list.checkpoints.filter((c) => !c.own);
      setPicked(defaultCheckpoint(theirs));
      go({ kind: 'choose', checkpoints: theirs });
    } catch (e) {
      setError(backupErrorText(e, rawLocale));
    } finally {
      setBusy(false);
    }
  };

  // While it works (and after the answer, until it is released): ask every 3 s; a box that doesn't answer is its
  // runtime stopped for the restore, and the session dials again by itself (sooner when asked).
  useEffect(() => {
    if (step?.kind !== 'working') return;
    let on = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const s = await sessionOps.backupRestoreState(session, { deadlineMs: RESTORE_POLL_MS * 2 });
        if (!on) return;
        setState(s);
        setReachable(true);
        const screen = restoreScreen(s);
        if (screen === 'done' || screen === 'failed' || (screen === 'almost' && !finished.current)) {
          setStep({ kind: screen });
          return;
        }
      } catch {
        if (!on) return;
        // Closed for good (the Whombat that came back doesn't let this phone in): it can't be followed from here.
        if (session.state().status === 'closed') {
          setStep({ kind: 'failed' });
          return;
        }
        setReachable(false);
        session.reconnectNow();
      }
      timer = setTimeout(() => void tick(), RESTORE_POLL_MS);
    };
    timer = setTimeout(() => void tick(), RESTORE_POLL_MS);
    return () => {
      on = false;
      if (timer) clearTimeout(timer);
    };
  }, [step?.kind, session]);

  const finish = async () => {
    if (!oldWhombat) return;
    setBusy(true);
    setError(null);
    try {
      const s = await sessionOps.backupFinishRestore(session, { oldWhombat });
      finished.current = true;
      setState(s);
      setStep({ kind: restoreScreen(s) === 'done' ? 'done' : 'working' });
    } catch (e) {
      if (e instanceof OperationError) setError(backupErrorText(e, rawLocale));
      else {
        finished.current = true;
        setStep({ kind: 'working' });
      }
    } finally {
      setBusy(false);
    }
  };

  if (!step) return <Frame title={B.opening} />;
  // The old Whombat's own name, else “your Whombat” (never its device id).
  const who = bringBackName(name ?? kit?.whombatName, rawLocale);
  const time = restoredTime(state);
  const foundKit = foundKitNote(kit, rawLocale);
  const backToStart = () => (later ? props.onCancel?.() : go({ kind: 'question' }));

  switch (step.kind) {
    case 'question':
      return (
        <Frame kicker={B.kicker} title={B.question} sub={B.questionLead}>
          <View accessibilityRole="radiogroup" style={{ gap: 10 }}>
            <ChoiceCard
              title={B.fresh}
              meta={B.freshMeta}
              selected={choice === 'fresh'}
              onPress={() => setChoice('fresh')}
            />
            <ChoiceCard
              title={B.back}
              meta={B.backMeta}
              selected={choice === 'back'}
              onPress={() => setChoice('back')}
            />
          </View>
          {choice === 'back' && foundKit ? <OkNote text={foundKit} /> : null}
          <Button
            label={B.continue}
            size="lg"
            onPress={() => (choice === 'fresh' ? props.onFresh() : go({ kind: 'source' }))}
          />
          {choice === 'back' && !kit ? <Hint text={B.noKitHintPhone} /> : null}
        </Frame>
      );
    case 'replace': {
      const L = backupOptionsText(rawLocale).later;
      return (
        <Frame
          title={L.confirmTitle}
          sub={L.confirmLead(props.thisName ?? 'this Whombat')}
          back={{ label: BACKUP_PHONE_TEXT.back, onPress: () => props.onCancel?.() }}
        >
          <Button label={L.confirm} size="lg" onPress={() => go({ kind: 'source' })} />
          <Button label={L.cancel} variant="quiet" onPress={() => props.onCancel?.()} />
        </Frame>
      );
    }
    case 'source':
      return (
        <Frame
          title={kit ? B.openTitle(who) : B.findTitle}
          sub={kit ? B.openLead(who) : B.findLead}
          back={{ label: BACKUP_PHONE_TEXT.back, onPress: backToStart }}
        >
          {kit ? <KitCard kit={kit} name={who} email={props.email} /> : null}
          {kit && platform?.prf ? (
            <Button label={B.unlock} size="lg" busy={busy} onPress={() => void unlock()} />
          ) : null}
          {!kit ? (
            <>
              <Button
                label={looking === 'none' ? B.lookAgain : B.look}
                size="lg"
                variant={looking === 'none' ? 'secondary' : 'primary'}
                busy={looking === 'looking'}
                onPress={() => void look()}
              />
              {looking === 'looking' ? <Hint text={B.looking} /> : null}
              {looking === 'none' ? <Hint text={B.nothingNear} /> : null}
            </>
          ) : null}
          <ErrorLine text={error} />
          <Text size={13} color={theme.colors.mut} style={{ paddingHorizontal: 4, paddingTop: 4 }}>
            {B.paperTitle}
          </Text>
          <LinkLine label={B.scan} onPress={() => setScanning(true)} />
          <LinkLine label={B.openFile} onPress={() => void openFile()} />
          <LinkLine label={B.pasteTitle} onPress={() => go({ kind: 'paste' })} />
          <QrScanner
            visible={scanning}
            title={B.scan}
            onClose={() => setScanning(false)}
            onDenied={() => {
              setScanning(false);
              go({ kind: 'paste' });
            }}
            escapeLabel={B.pasteTitle}
            onEscape={() => {
              setScanning(false);
              go({ kind: 'paste' });
            }}
            onScanned={(text) => {
              if (!kitFromScan(text)) return B.wrongKit;
              setScanning(false);
              fromText(text);
              return null;
            }}
          />
        </Frame>
      );
    case 'paste':
      return (
        <Frame
          title={B.pasteTitle}
          back={{ label: BACKUP_PHONE_TEXT.back, onPress: () => go({ kind: 'source' }) }}
        >
          <Field
            label={B.pasteLabel}
            value={pasted}
            onChangeText={setPasted}
            mono
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            style={{ minHeight: 160, textAlignVertical: 'top', paddingVertical: 12 }}
          />
          <ErrorLine text={error} />
          <Button
            label={B.openIt}
            size="lg"
            disabled={!pasted.trim()}
            onPress={() => {
              if (!fromText(pasted)) setError(B.wrongKit);
            }}
          />
        </Frame>
      );
    case 'opening':
      return (
        <Frame title={B.opening}>
          <ActivityIndicator />
        </Frame>
      );
    case 'choose': {
      const rows = chooseRows(step.checkpoints, undefined, rawLocale);
      const shown = allRows ? rows : rows.slice(0, 3);
      return (
        <Frame
          title={B.chooseTitle(who)}
          sub={B.chooseLead(place)}
          back={{ label: BACKUP_PHONE_TEXT.back, onPress: () => go({ kind: 'source' }) }}
        >
          <ChooseList
            rows={shown}
            picked={picked}
            onPick={setPicked}
            more={!allRows && rows.length > 3 ? () => setAllRows(true) : null}
          />
          <ErrorLine text={error} />
          <Button
            label={B.restore(who)}
            size="lg"
            busy={busy}
            disabled={!picked}
            onPress={() => void restore()}
          />
          <Hint text={B.restoreHint} />
        </Frame>
      );
    }
    case 'working':
      return (
        <Frame title={B.workingTitle(who)} sub={B.workingLead}>
          <Steps steps={restoreSteps(state, reachable, place, rawLocale)} />
          {!reachable ? <Hint text={BACKUP_PHONE_TEXT.waiting(who)} /> : null}
          <Hint text={B.workingFoot(place)} />
        </Frame>
      );
    case 'almost':
      return (
        <Almost
          name={who}
          time={time}
          newPassword={state?.newPassword ?? null}
          answer={oldWhombat}
          onAnswer={setOldWhombat}
          busy={busy}
          error={error}
          onStart={() => void finish()}
        />
      );
    case 'done':
      return (
        <Done
          session={session}
          control={control}
          platform={platform}
          appliance={props.appliancePeerId}
          name={who}
          time={time}
          servers={state?.servers ?? null}
          state={state}
          onOpen={() => props.onDone(name)}
        />
      );
    case 'failed':
      return (
        <Frame title={B.failedTitle} sub={B.failedLead}>
          {state?.error ? <Note text={state.error} /> : null}
          <ErrorLine text={error} />
          <Button label={B.tryAgain} size="lg" busy={busy} onPress={() => void tryAgain()} />
          <Button
            label={B.startOver}
            variant="quiet"
            disabled={busy}
            onPress={() => {
              setState(null);
              setName(null);
              if (later) go({ kind: 'source' });
              else go({ kind: 'question' });
            }}
          />
        </Frame>
      );
  }
}

/** The passkey's copy found (the account's, or next to the backups on this network). */
function KitCard({ kit, name, email }: { kit: BringBackKit; name: string; email: string }) {
  const { rawLocale } = useI18n();
  const B = backupOptionsText(rawLocale).bringBack;
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        padding: 14,
        borderRadius: 18,
        borderWidth: 1.5,
        borderColor: theme.colors.ink,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: 20,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tint(theme.colors.ok, 0.14),
        }}
      >
        <UserKey size={20} color={theme.colors.ok} strokeWidth={1.8} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text size={15.5} weight={600}>
          {kit.from === 'network' ? capital(name) : `${capital(name)} · ${email}`}
        </Text>
        <Text size={13} color={theme.colors.mut}>
          {kit.from === 'network'
            ? B.foundNear(longDate(kit.createdAt, rawLocale))
            : BACKUP_PHONE_TEXT.saved(longDate(kit.createdAt, rawLocale))}
        </Text>
      </View>
    </View>
  );
}

function ChooseList({
  rows,
  picked,
  onPick,
  more,
}: {
  rows: ReturnType<typeof chooseRows>;
  picked: string | null;
  onPick: (id: string) => void;
  more: (() => void) | null;
}) {
  const { rawLocale } = useI18n();
  const B = backupOptionsText(rawLocale).bringBack;
  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      style={{
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {rows.length === 0 ? (
        <Text size={14} color={theme.colors.mut} style={{ padding: 16 }}>
          {backupOptionsText(rawLocale).list.empty}
        </Text>
      ) : null}
      {rows.map((r, i) => {
        const on = r.id === picked;
        return (
          <Touchable
            key={r.id}
            feedback="wash"
            accessibilityRole="radio"
            accessibilityState={{ checked: on, selected: on }}
            accessibilityLabel={[r.title, r.newest ? B.newest : null, r.meta].filter(Boolean).join('. ')}
            onPress={() => onPick(r.id)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              minHeight: 60,
              paddingVertical: 12,
              paddingHorizontal: 14,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <View style={{ flex: 1, gap: 3 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text size={15.5} weight={600}>
                  {r.title}
                </Text>
                {r.newest ? <Tag text={B.newest} /> : null}
              </View>
              <Text size={13} color={theme.colors.mut}>
                {r.meta}
              </Text>
            </View>
            <View
              style={{
                width: 22,
                height: 22,
                borderRadius: 11,
                borderWidth: on ? 7 : 1.5,
                borderColor: on ? theme.colors.btn : theme.colors.line2,
              }}
            />
          </Touchable>
        );
      })}
      {more ? (
        <Touchable
          feedback="wash"
          accessibilityRole="button"
          onPress={more}
          style={{
            minHeight: 48,
            justifyContent: 'center',
            paddingHorizontal: 14,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Text size={14.5} weight={500} color={theme.colors.brand}>
            {B.olderBackups}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

/** The four steps: ✓ done, a spinner and an indeterminate bar under the one that runs, empty circles to come. */
function Steps({ steps }: { steps: ReturnType<typeof restoreSteps> }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 18,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {steps.map((s, i) => (
        <View
          key={s.text}
          accessible
          accessibilityLabel={`${s.text}: ${s.state === 'done' ? 'done' : s.state === 'running' ? 'going now' : 'next'}`}
          style={{
            gap: 8,
            paddingVertical: 13,
            paddingHorizontal: 14,
            borderTopWidth: i === 0 ? 0 : 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            {s.state === 'done' ? (
              <CircleCheck size={22} color={theme.colors.ok} strokeWidth={2} />
            ) : s.state === 'running' ? (
              <ActivityIndicator size="small" color={theme.colors.ok} style={{ width: 22 }} />
            ) : (
              <Circle size={22} color={theme.colors.line2} strokeWidth={1.6} />
            )}
            <Text size={15} color={s.state === 'queued' ? theme.colors.mut : theme.colors.ink}>
              {s.text}
            </Text>
          </View>
          {s.state === 'running' ? <Indeterminate /> : null}
        </View>
      ))}
    </View>
  );
}

/** A bar that only says “going”: no GB counts (the backup service doesn't report them while the runtime is down). */
function Indeterminate() {
  const theme = useTheme();
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPhase((p) => (p + 1) % 4), 600);
    return () => clearInterval(t);
  }, []);
  return (
    <View
      style={{
        marginLeft: 34,
        height: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.sf2,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          width: '35%',
          left: `${phase * 22}%`,
          borderRadius: 2,
          backgroundColor: theme.colors.ok,
        }}
      />
    </View>
  );
}

/** The one question only the person can say — is the old Whombat gone, or lost or stolen? — then Start. */
function Almost({
  name,
  time,
  newPassword,
  answer,
  onAnswer,
  busy,
  error,
  onStart,
}: {
  name: string;
  time: string;
  /** Who can give the backups a new password: the words promise it only where Whombat can. */
  newPassword: BackupRestoreState['newPassword'] | null;
  answer: 'gone' | 'lost' | null;
  onAnswer: (a: 'gone' | 'lost') => void;
  busy: boolean;
  error: string | null;
  onStart: () => void;
}) {
  const { rawLocale } = useI18n();
  const B = backupOptionsText(rawLocale).bringBack;
  const theme = useTheme();
  return (
    <Frame title={B.almostTitle} sub={B.almostLead(name, time)}>
      <View
        style={{
          borderRadius: 18,
          borderWidth: 1,
          borderColor: answer ? theme.colors.line : theme.colors.warn,
          backgroundColor: theme.colors.sf,
          padding: 16,
          gap: 10,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          {answer ? <Check size={18} color={theme.colors.ok} strokeWidth={2.2} /> : null}
          <Text size={16} weight={600} accessibilityRole="header">
            {B.oldGone}
          </Text>
        </View>
        <Text size={13.5} lh={1.45} color={theme.colors.mut}>
          {oldWhombatMeta(answer, newPassword, rawLocale)}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button
            label={B.oldWiped}
            variant={answer === 'gone' ? 'primary' : 'secondary'}
            onPress={() => onAnswer('gone')}
          />
          <Button
            label={B.oldLost}
            variant={answer === 'lost' ? 'primary' : 'secondary'}
            onPress={() => onAnswer('lost')}
          />
        </View>
      </View>
      <ErrorLine text={error} />
      <Button
        label={busy ? B.starting : B.start(name)}
        size="lg"
        busy={busy}
        disabled={!answer}
        onPress={onStart}
      />
    </Frame>
  );
}

function Done({
  session,
  control,
  platform,
  appliance,
  name,
  time,
  servers,
  state,
  onOpen,
}: {
  session: ApplianceSession;
  control: ControlApi | null;
  platform: PasskeyPlatform | null;
  appliance: string;
  name: string;
  time: string;
  servers: BackupRestoreState['servers'];
  state: BackupRestoreState | null;
  onOpen: () => void;
}) {
  const { rawLocale } = useI18n();
  const B = backupOptionsText(rawLocale).bringBack;

  const theme = useTheme();
  const client = useMemo(() => createClient({ session }), [session]);
  const [agent, setAgent] = useState<string | null>(null);
  // The assistant's name for the words; “Your agent” until it is read (the runtime may still be starting).
  useEffect(() => {
    let live = true;
    void (async () => {
      const me = await client.me.get({});
      const burrow = me.memberships[0]?.burrowSlug;
      if (!burrow) return;
      const boot = await client.conversations.bootstrap({ params: { burrow } });
      if (live) setAgent(theAgentOf(boot.principals)?.name ?? null);
    })().catch(() => {});
    return () => {
      live = false;
    };
  }, [client]);
  const words = agentWords(agent, rawLocale);
  const lines = [
    servers === 'staged' ? B.doneServers(null) : null,
    B.doneBackups(state?.newPassword?.place ?? null),
    B.doneVoices,
    ...oldWhombatDoneLines(state, name, rawLocale),
  ].filter((l): l is string => !!l);
  const connection = session.state();
  const tap = useOnePasskeySetup(
    platform && control
      ? {
          session,
          control,
          platform,
          appliance,
          me: connection.status === 'open' ? (connection.info.account?.id ?? null) : null,
          name: passkeyName(phoneLabel()),
        }
      : null,
    rawLocale,
  );
  const armed = tap?.view?.phase === 'ready';
  const row = (i: number) => ({
    flexDirection: 'row' as const,
    gap: 12,
    alignItems: 'center' as const,
    minHeight: 44,
    paddingVertical: 11,
    paddingHorizontal: 14,
    borderTopWidth: i === 0 ? 0 : 1,
    borderTopColor: theme.colors.line,
  });
  return (
    <Frame
      title={B.doneTitle(name)}
      sub={B.doneLead(words.Name, time)}
      hero={
        <View style={{ alignItems: 'center' }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: tint(theme.colors.ok, 0.14),
            }}
          >
            <Check size={30} color={theme.colors.ok} strokeWidth={2.2} />
          </View>
        </View>
      }
    >
      <View
        style={{
          borderRadius: 18,
          borderWidth: 1,
          borderColor: theme.colors.line,
          backgroundColor: theme.colors.sf,
          overflow: 'hidden',
        }}
      >
        {lines.map((l, i) => (
          <View key={l} style={row(i)}>
            <Check size={16} color={theme.colors.ok} strokeWidth={2.2} />
            <Text size={15}>{l}</Text>
          </View>
        ))}
        <View style={{ ...row(lines.length), flexWrap: 'wrap' }}>
          {armed ? (
            <Check size={16} color={theme.colors.ok} strokeWidth={2.2} />
          ) : (
            <KeyRound size={16} color={theme.colors.ink2} strokeWidth={2} />
          )}
          <View style={{ flex: 1, gap: 4, minWidth: 160 }}>
            <Text size={15} accessibilityLiveRegion="polite">
              {tap?.view?.title ?? B.doneKey(name)}
            </Text>
            {tap?.note ? (
              <Text size={13} color={theme.colors.mut}>
                {tap.note}
              </Text>
            ) : null}
          </View>
          {tap && !armed ? (
            <Button
              label={tap.label}
              variant="secondary"
              busy={tap.busy}
              disabled={!tap.view && !tap.loadError}
              onPress={() => void tap()}
            />
          ) : null}
        </View>
      </View>
      <Button label={B.openChat} size="lg" onPress={onOpen} />
      <Hint text={B.doneFoot(words.Name, time)} />
    </Frame>
  );
}
