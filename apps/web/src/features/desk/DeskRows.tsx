/**
 * Settings → Screen's rows: the box's own screen as a desk display, the person's, where the box has a display or a
 * pairing (`deskSectionView` decides the rows). The tab puts them in its parts:
 *
 * - **Show Whombat on this screen** on top, the screen line under it (“DELL U2720Q · connected”, and since when it is
 *   paired) and, when off, why or what that means. On pairs the screen to the person; off, while paired, asks first (it
 *   ends the pairing and its PIN). Unpaired, **Pair the screen** under it: the screen shows four letters; the dialog
 *   takes them and a PIN of 4 to 6 digits twice (`desk.pair`; one too easy to guess is refused before it is sent).
 * - **Lock and PIN**: the PIN (**Change PIN**, or **Choose a PIN** while it has none), what a locked screen shows
 *   (Only the time · A summary · Everything) and **Lock again** (After 2 minutes · When you leave, where the camera
 *   works · When you press Lock).
 * - **Night**: quiet hours (on or off, from, to, At night: Dim clock · Black) and, where the camera works, **Use the
 *   camera to see when you’re here**.
 * - **Talk**: Talk to {assistant} (off with the reason where the box can't hear) and, while it is on, the **Voice** it
 *   answers with (the voices the box lists, each with its kind and **Listen**).
 *
 * A choice is saved at once and shown before the answer (put back when refused); times once they rest. Every word is
 * `DESK_TEXT`'s.
 */
import {
  DESK_PIN_MAX,
  DESK_TEXT,
  type DeskApi,
  type DeskCameraWakeView,
  type DeskLockAgainView,
  type DeskSectionView,
  type DeskSwitchView,
  type DeskUpdateInput,
  type DeskVoiceView,
  deskErrorText,
  deskLetters,
  deskLettersMinutes,
  deskLettersRefused,
  deskLockAgainPatch,
  deskNeedsNewLetters,
  deskPairProblem,
  deskPinProblem,
  deskPinRefused,
  formatDeskPinInput,
} from '@whombat/client/desk';
import { useDeskActions, useDeskClock, useDeskListen } from '@whombat/client/desk/react';
import { ClockTime } from '@whombat/core';
import { Monitor } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useId, useState } from 'react';
import { Button } from '../../components/Button';
import { cx } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { Input } from '../../components/Input';
import { Modal, ModalClose, ModalDescription, ModalTitle } from '../../components/Modal';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { useToast } from '../../components/Toast';
import { Toggle } from '../../components/Toggle';
import { LettersInput } from '../../managed/LettersInput';
import styles from '../settings/SettingsScreen.module.css';
import tw from '../settings/ThisWhombat.module.css';
import d from './Desk.module.css';
import { playWav } from './playWav';

const T = DESK_TEXT;

/** A choice saved at once; put back with the reason when refused. */
function useSave(api: DeskApi) {
  const actions = useDeskActions(api);
  const toast = useToast();
  return (patch: DeskUpdateInput) =>
    void actions.update(patch).catch((error) => toast.show(deskErrorText(error)));
}

/**
 * Show Whombat on this screen, with the screen's mark, the screen line under it and, when off, the hint. On is
 * saved at once (the answer brings the pairing); off while paired asks first, since it ends the pairing and its PIN.
 */
export function SwitchRow({
  api,
  view,
  line,
  paired,
  onAskOff,
}: {
  api: DeskApi;
  view: DeskSwitchView;
  /** The screen line, with since when it is paired. */
  line: string;
  paired: boolean;
  onAskOff: () => void;
}) {
  const ids = useId();
  const actions = useDeskActions(api);
  const toast = useToast();
  const change = (on: boolean) => {
    if (!on && paired) return onAskOff();
    void actions.setScreen(on).catch((error) => toast.show(deskErrorText(error)));
  };
  return (
    <div className={cx(styles.row, d.switchRow)} data-row="desk-switch">
      <span className={d.screenMark}>
        <Icon icon={Monitor} size={32} />
      </span>
      <span className={styles.rowMain}>
        <label className={styles.rowTitle} htmlFor={`${ids}-on`}>
          {view.title}
        </label>
        <span className={styles.rowMeta} id={`${ids}-line`} data-screen-line="">
          {line}
        </span>
        {view.hint ? (
          <span className={styles.rowMeta} id={`${ids}-hint`} data-screen-hint="">
            {view.hint}
          </span>
        ) : null}
      </span>
      <Toggle
        id={`${ids}-on`}
        checked={view.on}
        aria-describedby={view.hint ? `${ids}-line ${ids}-hint` : `${ids}-line`}
        onCheckedChange={change}
      />
    </div>
  );
}

/** Unpaired: one line and **Pair the screen**, under the switch while it is on (or letters show). */
export function UnpairedRow({
  unpaired,
  onPair,
}: {
  unpaired: NonNullable<DeskSectionView['unpaired']>;
  onPair: () => void;
}) {
  return (
    <div className={styles.row} data-row="desk-unpaired">
      <StatusDot tone="mut" size={8} label={null} />
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{unpaired.title}</span>
        <span className={styles.rowMeta}>{unpaired.meta}</span>
      </span>
      <Button variant="primary" size="sm" onClick={onPair}>
        {T.pair}
      </Button>
    </div>
  );
}

type Mine = NonNullable<DeskSectionView['mine']>;

/** The PIN: **Change PIN**, or **Choose a PIN** while there is none. */
export function PinRow({ pin, onChangePin }: { pin: Mine['pin']; onChangePin: () => void }) {
  return (
    <div className={styles.row} data-row="desk-pin" data-has-pin={pin.has ? 'true' : 'false'}>
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{T.pin}</span>
        <span className={styles.rowMeta}>{pin.meta}</span>
      </span>
      <Button variant={pin.has ? 'secondary' : 'primary'} size="sm" onClick={onChangePin}>
        {pin.action}
      </Button>
    </div>
  );
}

/** While locked it shows: Only the time · A summary · Everything, the chosen one's hint under the title. */
export function LockedRow({ api, mine }: { api: DeskApi; mine: Mine }) {
  const ids = useId();
  const save = useSave(api);
  return (
    <div className={cx(styles.row, d.wrapRow)} data-row="desk-locked">
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{T.lockedShows}</span>
        <span className={styles.rowMeta} id={`${ids}-locked`}>
          {mine.lockedHint}
        </span>
      </span>
      <SegmentedControl
        label={T.lockedShows}
        describedBy={`${ids}-locked`}
        options={mine.lockedOptions}
        value={mine.lockedView}
        onChange={(lockedView) => save({ lockedView })}
      />
    </div>
  );
}

/** Quiet hours: the switch and what happens then; while on, From and To in the person's time zone, and At night. */
export function QuietRows({ api, mine, timeZone }: { api: DeskApi; mine: Mine; timeZone: string }) {
  const ids = useId();
  const save = useSave(api);
  const quiet = mine.quietHours;
  const [start, setStart] = useState(quiet.start);
  const [end, setEnd] = useState(quiet.end);
  useEffect(() => setStart(quiet.start), [quiet.start]);
  useEffect(() => setEnd(quiet.end), [quiet.end]);
  // A time is saved once it is a whole time and rests for a moment (the field changes per digit).
  // biome-ignore lint/correctness/useExhaustiveDependencies: `save` is new every render; the times decide
  useEffect(() => {
    if (start === quiet.start && end === quiet.end) return;
    if (!ClockTime.safeParse(start).success || !ClockTime.safeParse(end).success) return;
    const timer = setTimeout(() => save({ quietHours: { ...quiet, start, end } }), 500);
    return () => clearTimeout(timer);
  }, [start, end, quiet.start, quiet.end, quiet.enabled]);
  return (
    <>
      <div className={styles.row} data-row="desk-quiet">
        <span className={styles.rowMain}>
          <label className={styles.rowTitle} htmlFor={`${ids}-quiet`}>
            {T.quietHours}
          </label>
          <span className={styles.rowMeta} id={`${ids}-quiet-meta`}>
            {mine.quietMeta}
          </span>
        </span>
        <Toggle
          id={`${ids}-quiet`}
          checked={quiet.enabled}
          aria-describedby={`${ids}-quiet-meta`}
          onCheckedChange={(enabled) => save({ quietHours: { ...quiet, enabled } })}
        />
      </div>
      {quiet.enabled ? (
        <>
          <div className={cx(styles.row, d.wrapRow)} data-row="desk-quiet-times">
            <label className={d.rowLabel} htmlFor={`${ids}-start`}>
              {T.from}
            </label>
            <Input
              id={`${ids}-start`}
              type="time"
              className={d.clockInput}
              value={start}
              required
              onChange={(e) => setStart(e.target.value)}
            />
            <label className={d.rowLabel} htmlFor={`${ids}-end`}>
              {T.to}
            </label>
            <Input
              id={`${ids}-end`}
              type="time"
              className={d.clockInput}
              value={end}
              required
              onChange={(e) => setEnd(e.target.value)}
            />
            <span className={d.fullHint}>{T.inZone(timeZone)}</span>
          </div>
          <div className={cx(styles.row, d.wrapRow)} data-row="desk-night">
            <span className={d.rowLabel} id={`${ids}-night`}>
              {T.atNight}
            </span>
            <SegmentedControl
              label={T.atNight}
              options={mine.nightOptions}
              value={mine.night}
              onChange={(night) => save({ night })}
            />
          </div>
        </>
      ) : null}
    </>
  );
}

/** Talk to {assistant}: off and disabled, with the reason, where the box can't hear or speak. */
export function TalkRow({ api, talk }: { api: DeskApi; talk: Mine['talk'] }) {
  const ids = useId();
  const save = useSave(api);
  return (
    <div className={styles.row} data-row="desk-talk">
      <span className={styles.rowMain}>
        <label className={styles.rowTitle} htmlFor={`${ids}-talk`}>
          {talk.title}
        </label>
        <span className={styles.rowMeta} id={`${ids}-talk-meta`}>
          {talk.meta}
        </span>
      </span>
      <Toggle
        id={`${ids}-talk`}
        checked={talk.on}
        disabled={talk.disabled}
        aria-describedby={`${ids}-talk-meta`}
        onCheckedChange={(voice) => save({ voice })}
      />
    </div>
  );
}

/**
 * The voice Talk answers with, right after Talk while it is on: the row's words, then the
 * voices three to a line, each a radio with its name and kind and **Listen** beside it. Choosing saves at once
 * (`desk.update {speechVoice}`, put back with a toast when refused); Listen plays the box's sample, one at a time,
 * “Playing…” until it ends (pressed again, it stops).
 */
export function VoiceRow({ api, view, assistant }: { api: DeskApi; view: DeskVoiceView; assistant: string }) {
  const ids = useId();
  const actions = useDeskActions(api);
  const toast = useToast();
  const listen = useDeskListen(api, { assistant, play: playWav, onFailed: (text) => toast.show(text) });
  return (
    <div className={cx(styles.row, d.wrapRow)} data-row="desk-voice">
      <span className={styles.rowMain}>
        <span className={styles.rowTitle} id={`${ids}-voice`}>
          {view.title}
        </span>
        <span className={styles.rowMeta} id={`${ids}-voice-meta`}>
          {view.meta}
        </span>
      </span>
      <fieldset className={d.voices} aria-labelledby={`${ids}-voice`} aria-describedby={`${ids}-voice-meta`}>
        {view.options.map((o) => {
          const playing = listen.playing === o.value;
          return (
            <div
              key={o.value}
              className={d.voice}
              data-voice={o.value}
              data-selected={o.value === view.value || undefined}
            >
              <label className={d.voicePick}>
                <input
                  type="radio"
                  className={d.voiceRadio}
                  name={`${ids}-voices`}
                  value={o.value}
                  checked={o.value === view.value}
                  aria-labelledby={`${ids}-${o.value}-name`}
                  aria-describedby={`${ids}-${o.value}-kind`}
                  onChange={() =>
                    void actions
                      .update({ speechVoice: o.value })
                      .catch((error) => toast.show(deskErrorText(error)))
                  }
                />
                <span className={d.voiceText}>
                  <span className={d.voiceName} id={`${ids}-${o.value}-name`}>
                    {o.label}
                  </span>
                  <span className={d.voiceKind} id={`${ids}-${o.value}-kind`}>
                    {o.kind}
                  </span>
                </span>
              </label>
              <Button
                variant="secondary"
                size="sm"
                className={d.listen}
                id={`${ids}-${o.value}-listen`}
                aria-labelledby={`${ids}-${o.value}-listen ${ids}-${o.value}-name`}
                aria-pressed={playing}
                data-playing={playing || undefined}
                onClick={() => listen.toggle(o.value)}
              >
                {playing ? T.playing : T.listen}
              </Button>
            </div>
          );
        })}
      </fieldset>
    </div>
  );
}

/**
 * A switch of yours, in Talk's shape: Use the camera to see when you’re here under quiet hours in Night. Saved
 * at once.
 */
export function ChoiceSwitchRow({
  api,
  row,
  view,
  patch,
}: {
  api: DeskApi;
  row: string;
  view: DeskCameraWakeView;
  patch: (on: boolean) => DeskUpdateInput;
}) {
  const ids = useId();
  const actions = useDeskActions(api);
  const toast = useToast();
  return (
    <div className={styles.row} data-row={row}>
      <span className={styles.rowMain}>
        <label className={styles.rowTitle} htmlFor={`${ids}-switch`}>
          {view.title}
        </label>
        <span className={styles.rowMeta} id={`${ids}-meta`}>
          {view.meta}
        </span>
      </span>
      <Toggle
        id={`${ids}-switch`}
        checked={view.on}
        aria-describedby={`${ids}-meta`}
        onCheckedChange={(on) =>
          void actions.update(patch(on)).catch((error) => toast.show(deskErrorText(error)))
        }
      />
    </div>
  );
}

/**
 * Lock again in Lock and PIN, in the shape of While locked it shows (the segmented control beside the title, the
 * chosen one's hint under it). Choosing sends both of `presence` and `stayUnlocked` (`deskLockAgainPatch`), shown at
 * once and put back with a toast when refused.
 */
export function LockAgainRow({ api, view }: { api: DeskApi; view: DeskLockAgainView }) {
  const ids = useId();
  const actions = useDeskActions(api);
  const toast = useToast();
  return (
    <div className={cx(styles.row, d.wrapRow)} data-row="desk-lock-again">
      <span className={styles.rowMain}>
        <span className={styles.rowTitle}>{view.title}</span>
        <span className={styles.rowMeta} id={`${ids}-lock-again`}>
          {view.meta}
        </span>
      </span>
      <SegmentedControl
        label={view.title}
        describedBy={`${ids}-lock-again`}
        options={view.options}
        value={view.value}
        onChange={(choice) =>
          void actions.update(deskLockAgainPatch(choice)).catch((error) => toast.show(deskErrorText(error)))
        }
      />
    </div>
  );
}

/* Dialogs ---------------------------------------------------------------------------------------------------------- */

/** A labelled field with its problem under it (the problem names the input through `aria-describedby`). */
function Field({
  id,
  label,
  hint,
  problem,
  children,
}: {
  id: string;
  label: string;
  hint?: string | null;
  problem: string | null;
  children: (describedBy: string | undefined) => ReactNode;
}) {
  const describedBy = [hint ? `${id}-hint` : null, problem ? `${id}-problem` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={d.field}>
      <label className={d.label} htmlFor={id}>
        {label}
      </label>
      {children(describedBy || undefined)}
      {hint ? (
        <span className={d.hint} id={`${id}-hint`}>
          {hint}
        </span>
      ) : null}
      {problem ? (
        <span className={d.problem} id={`${id}-problem`} role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

function PinField({
  id,
  label,
  hint,
  value,
  onChange,
  problem,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  problem: string | null;
}) {
  return (
    <Field id={id} label={label} hint={hint ?? null} problem={problem}>
      {(describedBy) => (
        <Input
          id={id}
          type="password"
          inputMode="numeric"
          autoComplete="new-password"
          maxLength={DESK_PIN_MAX}
          className={d.pin}
          invalid={problem !== null}
          aria-describedby={describedBy}
          value={value}
          onChange={(e) => onChange(formatDeskPinInput(e.target.value))}
        />
      )}
    </Field>
  );
}

type Problem = { field: 'letters' | 'pin' | 'pinAgain'; text: string } | null;

/**
 * Pair the screen: where it is paired with someone else, first whose it is; then the screen shows its letters
 * (`desk.startPairing`) and the form takes them with a PIN typed twice. The letters' time left, and new ones when they
 * ran out or five tries were wrong.
 */
export function PairDialog({ open, onClose, api }: { open: boolean; onClose: () => void; api: DeskApi }) {
  const ids = useId();
  const actions = useDeskActions(api);
  const toast = useToast();
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [letters, setLetters] = useState('');
  const [pin, setPin] = useState('');
  const [pinAgain, setPinAgain] = useState('');
  const [problem, setProblem] = useState<Problem>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const now = useDeskClock(open && expiresAt !== null, 1000);
  const minutes = expiresAt ? deskLettersMinutes(expiresAt, now) : null;

  const show = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await actions.startPairing();
      setExpiresAt(r.expiresAt);
      setLetters('');
    } catch (error) {
      setNote(deskErrorText(error));
    } finally {
      setBusy(false);
    }
  };

  // Opening shows the letters on the screen at once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: once per opening
  useEffect(() => {
    if (!open) {
      setExpiresAt(null);
      setLetters('');
      setPin('');
      setPinAgain('');
      setProblem(null);
      setNote(null);
      return;
    }
    void show();
  }, [open]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = deskPairProblem({ letters, pin, pinAgain });
    setProblem(p);
    setNote(null);
    if (p) return;
    setBusy(true);
    try {
      await actions.pair({ code: deskLetters(letters) as string, pin });
      toast.show(T.dialog.done);
      onClose();
    } catch (error) {
      // Wrong or stale letters are the letters field's problem, a PIN Whombat won't take the PIN's (it used no
      // letters up, so they stay); anything else is the dialog's note.
      if (deskPinRefused(error)) return setProblem({ field: 'pin', text: deskErrorText(error) });
      if (deskLettersRefused(error)) setProblem({ field: 'letters', text: deskErrorText(error) });
      else setNote(deskErrorText(error));
      setLetters('');
      if (deskNeedsNewLetters(error)) {
        // Five wrong tries drew new letters on the screen; ones that ran out need asking for.
        const screen = await api.get().catch(() => null);
        setExpiresAt(screen?.pairing?.expiresAt ?? null);
      }
    } finally {
      setBusy(false);
    }
  };

  const at = (field: NonNullable<Problem>['field']) => (problem?.field === field ? problem.text : null);
  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : onClose())} width="md">
      <form className={tw.dialog} onSubmit={(e) => void submit(e)} noValidate>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{T.dialog.title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{T.dialog.lead}</ModalDescription>
        </div>
        <div className={d.fields}>
          <Field
            id={`${ids}-letters`}
            label={T.dialog.letters}
            hint={minutes === null ? null : T.dialog.changesIn(minutes)}
            problem={at('letters')}
          >
            {(describedBy) => (
              <LettersInput
                id={`${ids}-letters`}
                value={letters}
                onChange={setLetters}
                placeholder={T.dialog.lettersPlaceholder}
                invalid={at('letters') !== null}
                aria-describedby={describedBy}
              />
            )}
          </Field>
          {expiresAt !== null && minutes === null ? (
            <div className={d.expiry}>
              <span className={d.hint}>{T.dialog.expired}</span>
              <Button variant="link" disabled={busy} onClick={() => void show()}>
                {T.dialog.newLetters}
              </Button>
            </div>
          ) : null}
          <div className={d.pins}>
            <PinField
              id={`${ids}-pin`}
              label={T.dialog.pin}
              value={pin}
              onChange={setPin}
              problem={at('pin')}
            />
            <PinField
              id={`${ids}-again`}
              label={T.dialog.pinAgain}
              value={pinAgain}
              onChange={setPinAgain}
              problem={at('pinAgain')}
            />
          </div>
        </div>
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {T.dialog.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" type="submit" disabled={busy || expiresAt === null}>
            {busy ? T.dialog.busy : T.dialog.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Change PIN (the paired person): 4 to 6 digits twice (`desk.setPin`), none too easy; Choose a PIN while there is none
 *.
 */
export function PinDialog({
  open,
  onClose,
  api,
  first,
}: {
  open: boolean;
  onClose: () => void;
  api: DeskApi;
  first: boolean;
}) {
  const P = first ? T.firstPinDialog : T.pinDialog;
  const ids = useId();
  const actions = useDeskActions(api);
  const toast = useToast();
  const [pin, setPin] = useState('');
  const [pinAgain, setPinAgain] = useState('');
  const [problem, setProblem] = useState<Problem>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) return;
    setPin('');
    setPinAgain('');
    setProblem(null);
    setNote(null);
  }, [open]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const p = deskPinProblem(pin, pinAgain);
    setProblem(p);
    setNote(null);
    if (p) return;
    setBusy(true);
    try {
      await actions.setPin(pin);
      toast.show(P.done);
      onClose();
    } catch (error) {
      if (deskPinRefused(error)) setProblem({ field: 'pin', text: deskErrorText(error) });
      else setNote(deskErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : onClose())} width="md">
      <form className={tw.dialog} onSubmit={(e) => void submit(e)} noValidate>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{P.title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>{P.lead}</ModalDescription>
        </div>
        <div className={d.pins}>
          <PinField
            id={`${ids}-pin`}
            label={T.dialog.pin}
            value={pin}
            onChange={setPin}
            problem={problem?.field === 'pin' ? problem.text : null}
          />
          <PinField
            id={`${ids}-again`}
            label={T.dialog.pinAgain}
            value={pinAgain}
            onChange={setPinAgain}
            problem={problem?.field === 'pinAgain' ? problem.text : null}
          />
        </div>
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {T.dialog.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" type="submit" disabled={busy}>
            {busy ? P.busy : P.submit}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Turning the screen off while it is paired (it ends the pairing and its PIN): asked once. */
export function OffDialog({
  open,
  onClose,
  api,
  paired,
  hasPin,
}: {
  open: boolean;
  onClose: () => void;
  api: DeskApi;
  paired: boolean;
  hasPin: boolean;
}) {
  const actions = useDeskActions(api);
  const toast = useToast();
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) setNote(null);
  }, [open]);
  const off = async () => {
    setBusy(true);
    try {
      await actions.setScreen(false);
      toast.show(T.offDialog.done);
      onClose();
    } catch (error) {
      setNote(deskErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onOpenChange={(next) => (next ? null : onClose())} width="md">
      <div className={tw.dialog}>
        <div className={tw.dialogHead}>
          <ModalTitle className={tw.dialogTitle}>{T.offDialog.title}</ModalTitle>
          <ModalDescription className={tw.dialogLead}>
            {paired ? T.offDialog.lead(hasPin) : T.offHint}
          </ModalDescription>
        </div>
        {note ? (
          <span className={tw.dialogNote} role="status">
            {note}
          </span>
        ) : null}
        <div className={tw.dialogActions}>
          <ModalClose asChild>
            <Button variant="secondary" size="lg">
              {T.dialog.cancel}
            </Button>
          </ModalClose>
          <Button variant="primary" size="lg" disabled={busy} onClick={() => void off()}>
            {T.offDialog.submit}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
