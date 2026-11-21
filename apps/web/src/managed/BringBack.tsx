/**
 * “Is this a new Whombat?” and bringing a Whombat back (Whombat backup-options.md BKO-11, BKO-12, BKO-21, BKO-29,
 * BKO-34, backup-passkey.md BPK-05, BPK-06; app backup-options.md AP-6830…, backup-v2.md; mock 3-bring-back, screens
 * b–f). Right after a claim Start fresh goes on to Protect your Whombat; Bring back opens the old Whombat's backups
 * with the passkey first (the account's locked copy, else the copies next to the backups on this network, which the
 * person asks for: it can take a minute), else the paper copy (its file or its text: the web has no camera), joins them
 * (`backup.adopt`), lets the person choose one (the newest first), restores it (`backup.restore`) and follows it every
 * few seconds (`backup.restoreState`) — the runtime stops for most of it, so the steps carry on from what is known
 * while the session reconnects — then asks the one thing only the person can say (gone, or lost or stolen) and starts
 * the Whombat again (`backup.finishRestore`). The last screen finishes the same passkey setup for access and backups.
 * A failed restore says the service's plain words, with Try again and Start over.
 *
 * From the app's Backups (`later`): `resume` opens where a restore stands (finishing it, trying again); `replace` brings
 * one back on a Whombat that started fresh, after saying what's on it now is set aside (`backup.adopt` with `replace`).
 */
import { AGENT_FALLBACK_NAME, createClient } from '@whombat/client';
import {
  accountKitsToBringBack,
  BACKUP_OPTIONS_TEXT,
  type BringBackKit,
  backupToBringBack,
  bringBackName,
  COPY,
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
  passkeyName,
  placeShown,
  readClaimWorld,
  restoreSteps,
  unlockKitWithPasskey,
} from '@whombat/client/managed';
import { useOnePasskeySetup } from '@whombat/client/managed/react';
import { type ApplianceSession, OperationError, sessionOps } from '@whombat/client/session';
import type { BackupCheckpoint, BackupRestoreState } from '@whombat/protocol/session';
import { Check, Circle, KeyRound, LoaderCircle, UserKey } from 'lucide-react';
import {
  type ChangeEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AuthLayout } from '../app/auth/AuthLayout';
import { Button } from '../components/Button';
import { cx } from '../components/cx';
import { Icon } from '../components/Icon';
import { Tag } from '../components/Tag';
import { backupErrorText } from '../features/settings/BackupDestination';
import styles from './bringBack.module.css';
import {
  type BringBackStep,
  chooseRows,
  kitWhombatName,
  restoredTime,
  stepOfRestore,
  stepOfRestoreLater,
} from './bringBackModel';
import { browserLabel } from './keys';
import m from './managed.module.css';

const B = BACKUP_OPTIONS_TEXT.bringBack;
/** How often the restore is asked about while it works (and the session tries again while the runtime is away). */
export const RESTORE_POLL_MS = 3_000;
/** “Home’s backups” shows the newest few first; Older backups… lists every one. */
const CHOOSE_SHOWN = 3;

type Control = Pick<ControlApi, 'kitEnvelopes'> &
  Partial<
    Pick<
      ControlApi,
      | 'passkeys'
      | 'passkeyRegisterOptions'
      | 'passkeyRegisterVerify'
      | 'session'
      | 'appliances'
      | 'putPasskeyOwner'
      | 'retirePasskey'
    >
  >;

export interface BringBackProps {
  session: ApplianceSession;
  control: Control;
  platform: PasskeyPlatform | null;
  /** The account's email (“Home · mara@…”). */
  email: string;
  /** This box's PeerId: its own kits aren't offered, and the last step's passkey is for it. */
  thisPeerId: string;
  /** This Whombat's name (“what’s on Home now is set aside”). */
  thisName?: string | null;
  /** This Whombat's device id. */
  device?: string;
  /** Opened from the app's Backups: where a restore stands, or bringing one back on a Whombat that started fresh. */
  later?: 'resume' | 'replace';
  /** Start fresh: on to Protect your Whombat. */
  onFresh: () => void;
  /** Done: open the Whombat at Chat. */
  onOpenChat: () => void;
  /** Away from the flow: back to the list (after a claim) or to Backups (from the app). */
  onList: () => void;
  /** The restore poll's interval (tests make it short). */
  pollMs?: number;
}

type Looking = 'idle' | 'looking' | 'none';

export function BringBackFlow({
  session,
  control,
  platform,
  email,
  thisPeerId,
  thisName = null,
  later,
  onFresh,
  onOpenChat,
  onList,
  pollMs = RESTORE_POLL_MS,
}: BringBackProps) {
  const [step, setStep] = useState<BringBackStep | null>(null);
  const [kits, setKits] = useState<BringBackKit[] | null>(null);
  const [looking, setLooking] = useState<Looking>('idle');
  const [choice, setChoice] = useState<'fresh' | 'back' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [oldName, setOldName] = useState<string | null>(null);
  const [place, setPlace] = useState<string | null>(null);
  const [checkpoints, setCheckpoints] = useState<BackupCheckpoint[]>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [state, setState] = useState<BackupRestoreState | null>(null);
  const [reachable, setReachable] = useState(true);
  const [agent, setAgent] = useState<string>(AGENT_FALLBACK_NAME);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  // A restore under way here resumes; else the question (or, from the app, its own start), with the account's kits.
  useEffect(() => {
    let on = true;
    // Only kits a passkey the account still has opens: a removed one (a lost phone) isn't offered.
    void Promise.all([
      sessionOps.backupRestoreState(session).catch(() => null),
      accountKitsToBringBack(control, thisPeerId),
    ]).then(([restore, found]) => {
      if (!on) return;
      setKits(found);
      setChoice(found.length ? 'back' : 'fresh');
      if (restore) setState(restore);
      const resume = later ? stepOfRestoreLater(restore) : stepOfRestore(restore);
      if (resume) setStep(resume);
      else if (later === 'resume') onList();
      else setStep(later === 'replace' ? 'replace' : 'question');
    });
    return () => {
      on = false;
    };
  }, [session, control, thisPeerId, later, onList]);

  // While it works, and until it is back after the answer, the restore is asked about every few seconds; a refusal
  // or no answer is the runtime away: the session is told to try again now.
  const following = step === 'working' || (step === 'almost' && busy);
  useEffect(() => {
    if (!following) return;
    let on = true;
    const tick = () =>
      sessionOps.backupRestoreState(session, { deadlineMs: pollMs * 2 }).then(
        (next) => {
          if (!on) return;
          setReachable(true);
          setState(next);
          if (next.phase === 'checking' && step === 'working') setStep('almost');
          if (next.phase === 'failed') {
            setBusy(false);
            setStep('failed');
          }
          if (next.phase === 'released') {
            setBusy(false);
            setStep('done');
          }
        },
        () => {
          if (!on) return;
          setReachable(false);
          session.reconnectNow();
        },
      );
    void tick();
    const timer = setInterval(() => void tick(), pollMs);
    return () => {
      on = false;
      clearInterval(timer);
    };
  }, [following, session, pollMs, step]);

  // The assistant's name for the last screen, once the Whombat is back.
  useEffect(() => {
    if (step !== 'done') return;
    let on = true;
    void readClaimWorld(createClient({ session })).then(
      (w) => on && w.assistant && setAgent(w.assistant),
      () => {},
    );
    return () => {
      on = false;
    };
  }, [step, session]);

  const kit = kits?.[0] ?? null;
  // The old Whombat's own name, else “your Whombat” (never its device id).
  const name = bringBackName(oldName ?? kit?.whombatName);
  const here = thisName ?? 'this Whombat';

  const adopt = useCallback(
    async (text: string, from: string | null) => {
      const body = kitFromScan(text);
      if (!body) {
        setError(B.wrongKit);
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const joined = await sessionOps.backupAdopt(session, body, undefined, {
          replace: later === 'replace',
        });
        if (from) setOldName(from);
        setCheckpoints(joined.checkpoints);
        // The newest, unless the old Whombat made it after it was replaced (a lost or stolen box's later backups).
        setPicked(backupToBringBack(joined.checkpoints));
        // Where they are, in the words of the place (“Found on BlackBox”).
        const places = await sessionOps.backupPlaces(session).catch(() => null);
        const current = places?.places.find((p) => p.id === places.currentPlaceId)?.name ?? null;
        const shown =
          current ??
          placeShown((await sessionOps.backupStatus(session).catch(() => null))?.status?.destination.display);
        setPlace(shown ?? null);
        setStep('choose');
      } catch {
        setError(B.adoptFailed);
      } finally {
        setBusy(false);
      }
    },
    [session, later],
  );

  const unlock = async () => {
    if (!kit || !platform) return;
    setError(null);
    setBusy(true);
    try {
      const text = await unlockKitWithPasskey(platform, kit);
      setBusy(false);
      if (!text) setError(B.unlockFailed);
      else await adopt(text, kit.whombatName ?? kitWhombatName(text));
    } catch (e) {
      setBusy(false);
      if (e instanceof PasskeyCancelled) return;
      setError(e instanceof PasskeyError && e.code === 'unsupported' ? B.noPrf : B.unlockFailed);
    }
  };

  /** “Look on my network”: the copies kept next to backups on this network (it can take about a minute). */
  const look = async () => {
    setError(null);
    setLooking('looking');
    const near = await kitsFromNetwork(session, thisPeerId, control);
    if (!live.current) return;
    if (near.length) {
      setKits(near);
      setLooking('idle');
    } else setLooking('none');
  };

  const restore = async (checkpointId = picked) => {
    if (!checkpointId) return;
    setBusy(true);
    setError(null);
    try {
      await sessionOps.backupRestore(session, checkpointId);
      setReachable(true);
      setState(null);
      setStep('working');
    } catch (e) {
      // A refusal up front says why in plain words; a dropped connection is the runtime stopping for the restore.
      if (e instanceof OperationError) setError(backupErrorText(e));
      else setStep('working');
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
      setCheckpoints(theirs);
      setPicked(backupToBringBack(theirs));
      setStep('choose');
    } catch {
      setError(COPY.claim.errors.failed);
    } finally {
      setBusy(false);
    }
  };

  const startOver = () => {
    setError(null);
    setState(null);
    setOldName(null);
    setStep(later ? 'kit' : 'question');
  };

  const finish = async (oldWhombat: 'gone' | 'lost') => {
    setBusy(true);
    setError(null);
    try {
      const next = await sessionOps.backupFinishRestore(session, { oldWhombat });
      setState(next);
      // The runtime and servers restart now: the poll follows it until it answers released.
    } catch {
      setBusy(false);
      setError(COPY.claim.errors.failed);
    }
  };

  if (step === null) return null;
  const layout = (title: string, sub: ReactNode, children: ReactNode) => (
    <AuthLayout kicker={B.kicker} title={title} sub={sub} tip={B.tip}>
      {children}
      {error ? (
        <p className={m.error} role="alert">
          {error}
        </p>
      ) : null}
    </AuthLayout>
  );

  if (step === 'question')
    return layout(
      B.question,
      B.questionLead,
      <>
        <div className={styles.options} role="radiogroup" aria-label={B.question}>
          <BigChoice
            selected={choice === 'fresh'}
            title={B.fresh}
            meta={B.freshMeta}
            onSelect={() => setChoice('fresh')}
            value="fresh"
          />
          <BigChoice
            selected={choice === 'back'}
            title={B.back}
            meta={B.backMeta}
            onSelect={() => setChoice('back')}
            value="back"
          />
        </div>
        {kit ? (
          <p className={styles.note} data-found="">
            {B.found(bringBackName(kit.whombatName), longDate(kit.createdAt))}
          </p>
        ) : null}
        <Button
          variant="primary"
          size="xl"
          block
          disabled={!choice}
          onClick={() => (choice === 'fresh' ? onFresh() : setStep('kit'))}
        >
          {B.continue}
        </Button>
        <p className={styles.hint}>{B.noKitHintWeb}</p>
      </>,
    );

  if (step === 'replace') {
    const L = BACKUP_OPTIONS_TEXT.later;
    return layout(
      L.confirmTitle,
      L.confirmLead(here),
      <div className={m.actions} data-replace="">
        <Button variant="primary" size="xl" onClick={() => setStep('kit')}>
          {L.confirm}
        </Button>
        <Button variant="link" onClick={onList}>
          {L.cancel}
        </Button>
      </div>,
    );
  }

  if (step === 'kit' || step === 'paste')
    return layout(
      kit ? B.openTitle(name) : B.findTitle,
      kit ? B.openLead(name) : B.findLead,
      <KitSource
        kit={kit}
        name={name}
        email={email}
        paste={step === 'paste'}
        busy={busy}
        looking={looking}
        canUnlock={!!platform?.prf}
        onUnlock={() => void unlock()}
        onLook={() => void look()}
        onPaste={() => {
          setError(null);
          setStep('paste');
        }}
        onText={(text) => void adopt(text, kitWhombatName(text))}
        onBack={() => {
          setError(null);
          if (later) onList();
          else setStep('question');
        }}
      />,
    );

  if (step === 'choose')
    return layout(
      B.chooseTitle(name),
      B.chooseLead(place),
      <ChooseBackup
        checkpoints={checkpoints}
        picked={picked}
        onPick={setPicked}
        busy={busy}
        name={name}
        onRestore={() => void restore()}
        onBack={() => setStep('kit')}
      />,
    );

  if (step === 'working')
    return layout(
      B.workingTitle(name),
      B.workingLead,
      <>
        <Steps steps={restoreSteps(awayState(state, reachable), reachable, place)} />
        {!reachable ? (
          <p className={styles.hint} role="status">
            {B.reconnecting}
          </p>
        ) : null}
        <p className={styles.foot}>{B.workingFoot(place)}</p>
      </>,
    );

  if (step === 'almost')
    return layout(
      B.almostTitle,
      B.almostLead(name, restoredTime(state)),
      <OldWhombat
        busy={busy}
        name={name}
        newPassword={state?.newPassword ?? null}
        onStart={(answer) => void finish(answer)}
      />,
    );

  if (step === 'done') {
    const time = restoredTime(state);
    return (
      <AuthLayout kicker={B.kicker} title={B.doneTitle(name)} sub={B.doneLead(agent, time)} tip={B.tip}>
        <span className={styles.doneMark} aria-hidden="true">
          <Icon icon={Check} size={28} />
        </span>
        <ul className={styles.doneList}>
          {[
            B.doneServers(null),
            B.doneBackups(place ?? state?.newPassword?.place ?? null),
            B.doneVoices,
            ...oldWhombatDoneLines(state, name),
          ].map((line) => (
            <li key={line}>
              <span className={styles.doneTick} aria-hidden="true">
                <Icon icon={Check} size={16} />
              </span>
              {line}
            </li>
          ))}
          <PasskeyForThis
            session={session}
            control={control}
            platform={platform}
            appliance={thisPeerId}
            name={name}
          />
        </ul>
        <Button variant="primary" size="xl" block onClick={onOpenChat}>
          {B.openChat}
        </Button>
        <p className={styles.foot}>{B.doneFoot(agent, time)}</p>
      </AuthLayout>
    );
  }

  // It didn't finish: the service's plain words (never its technical detail), Try again, Start over.
  return layout(
    B.failedTitle,
    B.failedLead,
    <>
      {state?.error ? (
        <p className={styles.hint} data-restore-error="">
          {state.error}
        </p>
      ) : null}
      <Button variant="primary" size="xl" block disabled={busy} onClick={() => void tryAgain()}>
        {B.tryAgain}
      </Button>
      <div className={m.actions}>
        <Button variant="link" disabled={busy} onClick={startOver}>
          {B.startOver}
        </Button>
      </div>
    </>,
  );
}

/**
 * While the runtime is away the backup is being put back: a check last heard of is over by then (the runtime stops
 * only once the backup checked out), so the steps don't stay on it.
 */
export function awayState(state: BackupRestoreState | null, reachable: boolean): BackupRestoreState | null {
  if (reachable) return state;
  return state?.stage === 'prepare' || state?.stage === 'check' ? null : state;
}

/** One of the question's two big choices (a radio as a card). */
function BigChoice({
  selected,
  title,
  meta,
  value,
  onSelect,
}: {
  selected: boolean;
  title: string;
  meta: string;
  value: string;
  onSelect: () => void;
}) {
  return (
    <label className={cx(styles.bigChoice, selected && styles.bigChoiceOn)} data-choice={value}>
      <input
        type="radio"
        className={styles.srOnly}
        name="bring-back"
        value={value}
        checked={selected}
        onChange={onSelect}
      />
      <span className={styles.bigTitle}>{title}</span>
      <span className={styles.bigMeta}>{meta}</span>
    </label>
  );
}

/**
 * Screen b': the passkey first (the account's locked copy, or one found on the network, unlocked with the passkey);
 * without one, Look on my network; then the paper copy's file or its text pasted.
 */
function KitSource({
  kit,
  name,
  email,
  paste,
  busy,
  looking,
  canUnlock,
  onUnlock,
  onLook,
  onPaste,
  onText,
  onBack,
}: {
  kit: BringBackKit | null;
  name: string;
  email: string;
  paste: boolean;
  busy: boolean;
  looking: Looking;
  canUnlock: boolean;
  onUnlock: () => void;
  onLook: () => void;
  onPaste: () => void;
  onText: (text: string) => void;
  onBack: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const ids = useId();
  const [text, setText] = useState('');
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const picked = e.target.files?.[0];
    e.target.value = '';
    if (picked) void picked.text().then(onText);
  };
  return (
    <>
      {kit ? (
        <div className={styles.kitCard} data-kit={kit.id ?? kit.credentialId}>
          <span className={styles.kitIcon} aria-hidden="true">
            <Icon icon={UserKey} size={20} />
          </span>
          <span className={styles.choiceMain}>
            <span className={styles.choiceTitle}>
              {kit.from === 'network' ? capital(name) : `${capital(name)} · ${email}`}
            </span>
            <span className={styles.choiceMeta}>
              {kit.from === 'network'
                ? B.foundNear(longDate(kit.createdAt))
                : B.savedOn(longDate(kit.createdAt))}
            </span>
          </span>
        </div>
      ) : null}
      {kit && canUnlock && !paste ? (
        <Button variant="primary" size="xl" block disabled={busy} onClick={onUnlock}>
          {busy ? B.opening : B.unlock}
        </Button>
      ) : null}
      {!kit && !paste ? (
        <div className={styles.look} data-look={looking}>
          <Button
            variant={looking === 'none' ? 'secondary' : 'primary'}
            size="xl"
            block
            disabled={busy || looking === 'looking'}
            onClick={onLook}
          >
            {looking === 'none' ? B.lookAgain : B.look}
          </Button>
          <p className={styles.hint} role="status">
            {looking === 'looking' ? B.looking : looking === 'none' ? B.nothingNear : null}
          </p>
        </div>
      ) : null}
      {paste ? (
        <div className={m.field}>
          <label className={m.label} htmlFor={`${ids}-paste`}>
            {B.pasteLabel}
          </label>
          <textarea
            id={`${ids}-paste`}
            className={m.textarea}
            rows={8}
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <Button
            variant="primary"
            size="xl"
            block
            disabled={busy || !text.trim()}
            onClick={() => onText(text)}
          >
            {busy ? B.opening : B.openIt}
          </Button>
        </div>
      ) : null}
      <div className={styles.links}>
        <span className={styles.linksLabel}>{B.paperTitle}</span>
        <input
          ref={file}
          type="file"
          accept=".txt,text/plain"
          className={styles.srOnly}
          tabIndex={-1}
          aria-hidden="true"
          onChange={onFile}
        />
        <button
          type="button"
          className={styles.linkRow}
          disabled={busy}
          onClick={() => file.current?.click()}
        >
          {B.openFile}
        </button>
        {!paste ? (
          <button type="button" className={styles.linkRow} disabled={busy} onClick={onPaste}>
            {B.pasteTitle}
          </button>
        ) : null}
      </div>
      <div className={m.actions}>
        <Button variant="link" onClick={onBack}>
          {B.goBack}
        </Button>
      </div>
    </>
  );
}

/** Screen c: the old Whombat's backups, the newest chosen. */
function ChooseBackup({
  checkpoints,
  picked,
  onPick,
  busy,
  name,
  onRestore,
  onBack,
}: {
  checkpoints: BackupCheckpoint[];
  picked: string | null;
  onPick: (id: string) => void;
  busy: boolean;
  name: string;
  onRestore: () => void;
  onBack: () => void;
}) {
  const [all, setAll] = useState(false);
  const rows = chooseRows(checkpoints);
  const shown = all ? rows : rows.slice(0, CHOOSE_SHOWN);
  return (
    <>
      <div className={styles.choices} role="radiogroup" aria-label={B.chooseTitle(name)}>
        {shown.map((row) => (
          <label key={row.id} className={styles.choiceRow} data-checkpoint={row.id}>
            <span className={styles.choiceMain}>
              <span className={styles.choiceTitle}>
                {row.title}
                {row.newest ? (
                  <Tag tone="ok" className={styles.recommended}>
                    {B.newest}
                  </Tag>
                ) : null}
              </span>
              <span className={styles.choiceMeta}>{row.meta}</span>
            </span>
            <input
              type="radio"
              className={styles.radio}
              name="checkpoint"
              value={row.id}
              checked={picked === row.id}
              onChange={() => onPick(row.id)}
            />
          </label>
        ))}
        {!all && rows.length > CHOOSE_SHOWN ? (
          <button type="button" className={styles.olderRow} onClick={() => setAll(true)}>
            {B.olderBackups}
          </button>
        ) : null}
      </div>
      <Button variant="primary" size="xl" block disabled={busy || !picked} onClick={onRestore}>
        {B.restore(name)}
      </Button>
      <p className={styles.hint}>{B.restoreHint}</p>
      <div className={m.actions}>
        <Button variant="link" onClick={onBack}>
          {B.goBack}
        </Button>
      </div>
    </>
  );
}

/** Screen d's steps: done ✓, the running one with a bar that moves, the rest waiting. */
function Steps({ steps }: { steps: ReturnType<typeof restoreSteps> }) {
  return (
    <ol className={styles.steps} data-restore-steps="">
      {steps.map((s) => (
        <li key={s.text} className={styles.step} data-state={s.state}>
          <span className={styles.stepMark} aria-hidden="true">
            <Icon
              icon={s.state === 'done' ? Check : s.state === 'running' ? LoaderCircle : Circle}
              size={18}
            />
          </span>
          <span className={styles.choiceMain}>
            <span className={styles.stepText}>{s.text}</span>
            {s.state === 'running' ? <span className={styles.bar} aria-hidden="true" /> : null}
          </span>
          <span className={styles.srOnly}>
            {s.state === 'done' ? 'done' : s.state === 'running' ? 'now' : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Screen e: the one thing only the person can say — is the old Whombat gone, or lost or stolen? — then Start. Where
 * Whombat can't give the backups a new password (`newPassword.by` `you`), the words promise only what it can do.
 */
function OldWhombat({
  busy,
  name,
  newPassword,
  onStart,
}: {
  busy: boolean;
  name: string;
  newPassword: BackupRestoreState['newPassword'] | null;
  onStart: (answer: 'gone' | 'lost') => void;
}) {
  const [answer, setAnswer] = useState<'gone' | 'lost' | null>(null);
  return (
    <>
      <section
        className={cx(styles.answer, answer === null && styles.answerOpen)}
        data-answer="old"
        aria-label={B.oldGone}
      >
        <h2 className={styles.answerTitle}>
          {answer ? (
            <span className={styles.answerTick} aria-hidden="true">
              <Icon icon={Check} size={16} />
            </span>
          ) : null}
          {B.oldGone}
        </h2>
        <p className={styles.answerMeta}>{oldWhombatMeta(answer, newPassword)}</p>
        <div className={styles.answerActions}>
          <Button
            variant={answer === 'gone' ? 'primary' : 'secondary'}
            size="md"
            aria-pressed={answer === 'gone'}
            onClick={() => setAnswer('gone')}
          >
            {B.oldWiped}
          </Button>
          <Button
            variant={answer === 'lost' ? 'primary' : 'secondary'}
            size="md"
            aria-pressed={answer === 'lost'}
            onClick={() => setAnswer('lost')}
          >
            {B.oldLost}
          </Button>
        </div>
      </section>
      <Button
        variant="primary"
        size="xl"
        block
        disabled={!answer || busy}
        onClick={() => answer && onStart(answer)}
      >
        {busy ? B.starting : B.start(name)}
      </Button>
    </>
  );
}

/** Finish shared passkey setup on the restored Whombat without creating a second, per-box credential. */
function PasskeyForThis({
  session,
  control,
  platform,
  appliance,
  name,
}: {
  session: ApplianceSession;
  control: Control;
  platform: PasskeyPlatform | null;
  appliance: string;
  name: string;
}) {
  const setupControl = useMemo(
    () =>
      control.session &&
      control.appliances &&
      control.passkeys &&
      control.putPasskeyOwner &&
      control.passkeyRegisterOptions &&
      control.passkeyRegisterVerify
        ? {
            session: control.session.bind(control),
            appliances: control.appliances.bind(control),
            passkeys: control.passkeys.bind(control),
            putPasskeyOwner: control.putPasskeyOwner.bind(control),
            passkeyRegisterOptions: control.passkeyRegisterOptions.bind(control),
            passkeyRegisterVerify: control.passkeyRegisterVerify.bind(control),
            kitEnvelopes: control.kitEnvelopes.bind(control),
            retirePasskey: control.retirePasskey?.bind(control),
          }
        : null,
    [control],
  );
  const state = session.state();
  const tap = useOnePasskeySetup(
    platform && setupControl
      ? {
          session,
          control: setupControl,
          platform,
          appliance,
          me: state.status === 'open' ? (state.info.account?.id ?? null) : null,
          name: passkeyName(browserLabel()),
        }
      : null,
  );
  const armed = tap?.view?.phase === 'ready';
  return (
    <li className={styles.doneKey} data-done-passkey={armed ? 'done' : ''}>
      <span className={styles.doneTick} data-tone={armed ? undefined : 'key'} aria-hidden="true">
        <Icon icon={armed ? Check : KeyRound} size={16} />
      </span>
      <span className={styles.choiceMain}>
        <span>{tap?.view?.title ?? B.doneKey(name)}</span>
        {tap?.note ? (
          <span className={styles.choiceMeta} role="status">
            {tap.note}
          </span>
        ) : null}
      </span>
      {tap && !armed ? (
        <Button
          variant="secondary"
          size="sm"
          disabled={tap.busy || (!tap.view && !tap.loadError)}
          onClick={() => void tap()}
        >
          {tap.label}
        </Button>
      ) : null}
    </li>
  );
}
