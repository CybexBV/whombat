/**
 * The box's own screen as a desk display on the phone (Whombat desk-display.md DK-02…DK-09, DK-16…DK-20, DK-26…DK-28,
 * DK-72, DK-74, DK-123; desk-display-android.md AP-3051…AP-3058, AP-3115…AP-3124, AP-3325…, AP-3625…, AP-5860…): the
 * cards of Settings → Screen and This Whombat's row that opens it. The top card starts with Show Whombat on this
 * screen, the screen line and, when off, why or what that means; off while paired asks first. Unpaired: one row and
 * Pair the screen, which shows four letters on the screen and opens a sheet for them and a PIN of 4 to 6 digits typed
 * twice (one too easy to guess is refused before it is sent). Paired: since when. Then the parts' cards: Lock and PIN
 * (the PIN with Change PIN, or Choose a PIN while there is none; While locked it shows; Lock again — After 2 minutes ·
 * When you leave, where the camera works · When you press Lock), Night (Quiet hours with From and to and At night; Use
 * the camera to see when you’re here, where the camera works) and Talk (Talk to {assistant} and, while it is on, the
 * Voice it answers with: the voices the box lists, each with its kind and Listen, AP-3425…). The rows and words are the
 * shared `deskSectionView` and `DESK_TEXT`; a choice is saved at once and put back when refused. Every target 44dp.
 */
import {
  DESK_PIN_MAX,
  type DeskApi,
  type DeskCameraWakeView,
  type DeskLockAgainView,
  type DeskScreen,
  type DeskSectionView,
  type DeskSwitchView,
  type DeskVoice,
  type DeskVoiceView,
  deskErrorText,
  deskLetters,
  deskLettersMinutes,
  deskLettersRefused,
  deskLockAgainPatch,
  deskNeedsNewLetters,
  deskPairProblem,
  deskPinProblem,
  deskSectionShown,
  deskSectionView,
  deskSwitchView,
  deskText,
  formatDeskPinInput,
} from '@whombat/client/desk';
import { type DeskActions, useDesk, useDeskClock, useDeskListen } from '@whombat/client/desk/react';
import { deskWords } from '@whombat/core/domain';
import { type ReactNode, useState } from 'react';
import { Alert, ScrollView, Switch, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { useI18n, useMobileT } from '../i18n';
import { showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ClockField } from '../ui/ClockField';
import { Button } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { Sheet } from '../ui/sheet';
import { switchColors } from '../ui/switchColors';
import { Touchable } from '../ui/Touchable';
import { useVoicePlayer } from '../ui/VoicePlayer';
import { LettersField } from './screens';
import { Card, ErrorLine, Field, LinkRow } from './ui';

/** Something didn't go through: why, in the shared words. */
export function useDeskFailure() {
  const { rawLocale } = useI18n();
  const { t } = useMobileT();
  return (error: unknown) => Alert.alert(t('managed.that-didnt-go-through'), deskErrorText(error, rawLocale));
}

/** The section's view of the screen now: the Whombat's times are real ones (the demo world's desk too). */
function useDeskView(screen: DeskScreen) {
  const { rawLocale } = useI18n();
  const { timeZone } = useBurrowBase();
  const assistant = useAgentWords().name;
  return {
    view: deskSectionView(screen, { locale: rawLocale, assistant, timeZone, now: Date.now() }),
    assistant,
  };
}

/**
 * SCREEN on This Whombat (desk-display-android.md AP-5861): one row that opens Settings → Screen, with the screen line
 * under it; where the box has a screen or one is paired. The unlock request stays on the Overview's top.
 */
export function DeskSettingsRow({ api, onOpen }: { api: DeskApi | null; onOpen: () => void }) {
  const { rawLocale } = useI18n();
  const desk = useDesk(api);
  const screen = desk.data;
  if (!api || !screen || !deskSectionShown(screen)) return null;
  const line = deskSwitchView(screen, rawLocale).line;
  const title = deskWords(rawLocale).settings.openScreen;
  return (
    <Card label={deskText(rawLocale).section}>
      <LinkRow first title={title} meta={line} label={`${title}, ${line}`} onPress={onOpen} />
    </Card>
  );
}

/**
 * Settings → Screen's top (AP-5862): Show Whombat on this screen with the screen line and, when off, why or what that
 * means (off while paired asks first); unpaired, one row and Pair the screen; paired, since when.
 */
export function DeskSwitchCard({ screen, actions }: { screen: DeskScreen; actions: DeskActions }) {
  const { rawLocale } = useI18n();
  const { offDialog, dialog, pair } = deskText(rawLocale);
  const failed = useDeskFailure();
  const { view } = useDeskView(screen);
  const [pairing, setPairing] = useState(false);
  // Pair the screen: its letters show now (or still do), then the sheet.
  const startPairing = () => {
    const live = screen.pairing && Date.parse(screen.pairing.expiresAt) > Date.now();
    if (live) return setPairing(true);
    actions.startPairing().then(() => setPairing(true), failed);
  };
  // The switch (DK-20): on at once; off while paired ends the pairing and its PIN, so it asks first.
  const setOn = (on: boolean) => {
    const p = screen.paired;
    if (on || !p) return void actions.setScreen(on).catch(failed);
    Alert.alert(offDialog.title, offDialog.lead(p.hasPin !== false), [
      { text: dialog.cancel, style: 'cancel' },
      {
        text: offDialog.submit,
        style: 'destructive',
        onPress: () => actions.setScreen(false).then(() => showNotice(offDialog.done), failed),
      },
    ]);
  };
  return (
    <Card>
      <SwitchPart view={view.onScreen} onChange={setOn} />
      {view.unpaired ? (
        <Part>
          <Head title={view.unpaired.title} meta={view.unpaired.meta} />
          <Buttons>
            <Button label={pair} variant="secondary" onPress={startPairing} />
          </Buttons>
        </Part>
      ) : null}
      {view.paired ? (
        <Part>
          <Head title={view.paired.title} meta={view.paired.meta} />
        </Part>
      ) : null}
      <PairSheet visible={pairing} screen={screen} actions={actions} onClose={() => setPairing(false)} />
    </Card>
  );
}

/** Lock and PIN (AP-5864): the PIN with Change PIN (Choose a PIN while there is none), While locked it shows, Lock again. */
export function DeskLockCard({ screen, actions }: { screen: DeskScreen; actions: DeskActions }) {
  const failed = useDeskFailure();
  const { view } = useDeskView(screen);
  const [pinOpen, setPinOpen] = useState(false);
  const mine = view.mine;
  if (!mine) return null;
  return (
    <Card>
      <PinPart mine={mine} onChangePin={() => setPinOpen(true)} first />
      <LockedPart mine={mine} actions={actions} />
      {view.lockAgain ? (
        <LockAgainPart
          view={view.lockAgain}
          onChoose={(choice) => void actions.update(deskLockAgainPatch(choice)).catch(failed)}
        />
      ) : null}
      <PinSheet visible={pinOpen} actions={actions} first={!mine.pin.has} onClose={() => setPinOpen(false)} />
    </Card>
  );
}

/** Night (AP-5864): quiet hours with From and to and At night, and Use the camera to see when you’re here. */
export function DeskNightCard({ screen, actions }: { screen: DeskScreen; actions: DeskActions }) {
  const failed = useDeskFailure();
  const { view } = useDeskView(screen);
  if (!view.mine) return null;
  return (
    <Card>
      <QuietPart mine={view.mine} actions={actions} first />
      {view.cameraWake ? (
        <ChoiceSwitchPart
          view={view.cameraWake}
          onChange={(cameraWake) => void actions.update({ cameraWake }).catch(failed)}
        />
      ) : null}
    </Card>
  );
}

/** Talk (AP-5864): Talk to {assistant} and, while it is on, the voice it answers with. */
export function DeskTalkCard({
  api,
  screen,
  actions,
}: {
  api: DeskApi;
  screen: DeskScreen;
  actions: DeskActions;
}) {
  const failed = useDeskFailure();
  const { view, assistant } = useDeskView(screen);
  const mine = view.mine;
  if (!mine) return null;
  return (
    <Card>
      <TalkPart mine={mine} actions={actions} />
      {mine.voice ? (
        <VoicePart
          api={api}
          view={mine.voice}
          assistant={assistant}
          onChoose={(speechVoice) => void actions.update({ speechVoice }).catch(failed)}
        />
      ) : null}
    </Card>
  );
}

/* Parts of the card ------------------------------------------------------------------------------------------------- */

/** One part of the card: 16dp in, a hairline above all but the first. */
function Part({ first = false, children }: { first?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 10,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {children}
    </View>
  );
}

/** A part's title (15/500) over its sentence (13 `mut`), and what sits at its end (a switch, a button). */
function Head({ title, meta, end }: { title: string; meta?: string | null; end?: ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
        <Text size={15} weight={500} lh={1.35}>
          {title}
        </Text>
        {meta ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {meta}
          </Text>
        ) : null}
      </View>
      {end}
    </View>
  );
}

function Buttons({ children }: { children: ReactNode }) {
  return <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>{children}</View>;
}

/** Show Whombat on this screen (DK-20): the screen line under it, and when off why or what that means. */
function SwitchPart({ view, onChange }: { view: DeskSwitchView; onChange: (on: boolean) => void }) {
  const theme = useTheme();
  const meta = view.hint ? `${view.line} ${view.hint}` : view.line;
  return (
    <Part first>
      <Head
        title={view.title}
        meta={view.line}
        end={
          <Switch
            value={view.on}
            onValueChange={onChange}
            accessibilityLabel={view.title}
            accessibilityHint={meta}
            accessibilityRole="switch"
            {...switchColors(theme, view.on)}
            style={{ minHeight: 44 }}
          />
        }
      />
      {view.hint ? (
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {view.hint}
        </Text>
      ) : null}
    </Part>
  );
}

type Mine = NonNullable<DeskSectionView['mine']>;
type Save = (patch: Parameters<DeskActions['update']>[0]) => void;
function useDeskSave(actions: DeskActions): Save {
  const failed = useDeskFailure();
  return (patch) => void actions.update(patch).catch(failed);
}

/** The PIN: Change PIN beside it, or, with none yet (DK-18), the one thing to do, filled, under its sentence. */
function PinPart({ mine, onChangePin, first }: { mine: Mine; onChangePin: () => void; first?: boolean }) {
  const { rawLocale } = useI18n();
  return mine.pin.has ? (
    <Part first={first}>
      <Head
        title={deskText(rawLocale).pin}
        meta={mine.pin.meta}
        end={
          <Button
            label={mine.pin.action}
            variant="secondary"
            onPress={onChangePin}
            style={{ paddingHorizontal: 14 }}
          />
        }
      />
    </Part>
  ) : (
    <Part first={first}>
      <Head title={deskText(rawLocale).pin} meta={mine.pin.meta} />
      <Buttons>
        <Button label={mine.pin.action} onPress={onChangePin} style={{ paddingHorizontal: 16 }} />
      </Buttons>
    </Part>
  );
}

/** While locked it shows, and the chosen one's hint. */
function LockedPart({ mine, actions }: { mine: Mine; actions: DeskActions }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const save = useDeskSave(actions);
  return (
    <Part>
      <Head title={deskText(rawLocale).lockedShows} />
      <Segmented
        options={mine.lockedOptions}
        value={mine.lockedView}
        onChange={(lockedView) => save({ lockedView })}
        label={deskText(rawLocale).lockedShows}
      />
      <Text size={13} lh={1.4} color={theme.colors.mut}>
        {mine.lockedHint}
      </Text>
    </Part>
  );
}

/** Quiet hours: From and to in the Whombat's time zone, and At night, while they're on. */
function QuietPart({ mine, actions, first }: { mine: Mine; actions: DeskActions; first?: boolean }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const { timeZone } = useBurrowBase();
  const save = useDeskSave(actions);
  const quiet = mine.quietHours;
  return (
    <Part first={first}>
      <Head
        title={deskText(rawLocale).quietHours}
        meta={mine.quietMeta}
        end={
          <Switch
            value={quiet.enabled}
            onValueChange={(enabled) => save({ quietHours: { ...quiet, enabled } })}
            accessibilityLabel={deskText(rawLocale).quietHours}
            accessibilityHint={mine.quietMeta}
            accessibilityRole="switch"
            {...switchColors(theme, quiet.enabled)}
            style={{ minHeight: 44 }}
          />
        }
      />
      {quiet.enabled ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 12 }}>
            <ClockField
              label={deskText(rawLocale).from}
              value={quiet.start}
              onChange={(start) => save({ quietHours: { ...quiet, start } })}
            />
            <ClockField
              label={deskText(rawLocale).to}
              value={quiet.end}
              onChange={(end) => save({ quietHours: { ...quiet, end } })}
            />
          </View>
          <Text size={12.5} lh={1.4} color={theme.colors.mut}>
            {deskText(rawLocale).inZone(timeZone)}
          </Text>
          <View style={{ gap: 8, paddingTop: 2 }}>
            <Text size={13} weight={500} color={theme.colors.ink2}>
              {deskText(rawLocale).atNight}
            </Text>
            <Segmented
              options={mine.nightOptions}
              value={mine.night}
              onChange={(night) => save({ night })}
              label={deskText(rawLocale).atNight}
            />
          </View>
        </>
      ) : null}
    </Part>
  );
}

/** Talk to {assistant}: off and greyed where the machine can't hear. */
function TalkPart({ mine, actions }: { mine: Mine; actions: DeskActions }) {
  const theme = useTheme();
  const save = useDeskSave(actions);
  return (
    <Part first>
      <Head
        title={mine.talk.title}
        meta={mine.talk.meta}
        end={
          <Switch
            value={mine.talk.on}
            disabled={mine.talk.disabled}
            onValueChange={(voice) => save({ voice })}
            accessibilityLabel={mine.talk.title}
            accessibilityHint={mine.talk.meta}
            accessibilityRole="switch"
            {...switchColors(theme, mine.talk.on)}
            style={{ minHeight: 44, opacity: mine.talk.disabled ? 0.5 : 1 }}
          />
        }
      />
    </Part>
  );
}

/**
 * The voice Talk answers with (DK-50, DK-51; AP-3425), a part of its own right after Talk while it is on: its title
 * and hint, then a card of rows as Settings' radio cards draw them (a 20dp ring, the voice's name and its kind under
 * it), each with Listen at its end. Choosing saves at once; Listen plays the box's sample through the hidden player, one
 * at a time, “Playing…” until it ends (pressed again, it stops); a sample that didn't come or play says so.
 */
function VoicePart({
  api,
  view,
  assistant,
  onChoose,
}: {
  api: DeskApi;
  view: DeskVoiceView;
  assistant: string;
  onChoose: (voice: DeskVoice) => void;
}) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const player = useVoicePlayer();
  const listen = useDeskListen(api, { assistant, play: player.play, onFailed: showNotice });
  return (
    <Part>
      <Head title={view.title} meta={view.meta} />
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={view.title}
        style={{
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.line2,
          backgroundColor: theme.colors.sf,
          overflow: 'hidden',
        }}
      >
        {view.options.map((o, i) => {
          const selected = o.value === view.value;
          const playing = listen.playing === o.value;
          const action = playing ? deskText(rawLocale).playing : deskText(rawLocale).listen;
          return (
            <View
              key={o.value}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                borderTopWidth: i === 0 ? 0 : 1,
                borderTopColor: theme.colors.line,
              }}
            >
              <Touchable
                onPress={() => onChoose(o.value)}
                feedback="wash"
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, selected }}
                accessibilityLabel={`${o.label}. ${o.kind}`}
                style={{
                  flex: 1,
                  minHeight: 56,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 12,
                  paddingVertical: 9,
                  paddingLeft: 12,
                  paddingRight: 8,
                }}
              >
                <View
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 10,
                    borderWidth: selected ? 6 : 1.5,
                    borderColor: selected ? theme.colors.btn : theme.colors.line2,
                  }}
                />
                <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                  <Text size={15} weight={600}>
                    {o.label}
                  </Text>
                  <Text size={13} lh={1.4} color={theme.colors.mut} numberOfLines={1}>
                    {o.kind}
                  </Text>
                </View>
              </Touchable>
              <Button
                label={action}
                variant="secondary"
                onPress={() => listen.toggle(o.value)}
                accessibilityLabel={`${action}, ${o.label}`}
                style={{ minWidth: 96, marginRight: 8, paddingHorizontal: 12 }}
              />
            </View>
          );
        })}
      </View>
      {player.element}
    </Part>
  );
}

/** Use the camera to see when you’re here (DK-72, AP-3626) after Lock again. Saved at once. */
function ChoiceSwitchPart({ view, onChange }: { view: DeskCameraWakeView; onChange: (on: boolean) => void }) {
  const theme = useTheme();
  return (
    <Part>
      <Head
        title={view.title}
        meta={view.meta}
        end={
          <Switch
            value={view.on}
            onValueChange={onChange}
            accessibilityLabel={view.title}
            accessibilityHint={view.meta}
            accessibilityRole="switch"
            {...switchColors(theme, view.on)}
            style={{ minHeight: 44 }}
          />
        }
      />
    </Part>
  );
}

/**
 * Lock again (DK-74, AP-3625), where Stay unlocked while you’re here was, in the shape of While locked it shows: the
 * title, the segmented control (labels on up to two lines: a third of a phone is too narrow for “When you press Lock”),
 * the chosen one's hint under it. Choosing saves at once (`presence` and `stayUnlocked` together).
 */
function LockAgainPart({
  view,
  onChoose,
}: {
  view: DeskLockAgainView;
  onChoose: (choice: DeskLockAgainView['value']) => void;
}) {
  const theme = useTheme();
  return (
    <Part>
      <Head title={view.title} />
      <Segmented options={view.options} value={view.value} onChange={onChoose} label={view.title} lines={2} />
      <Text size={13} lh={1.4} color={theme.colors.mut}>
        {view.meta}
      </Text>
    </Part>
  );
}

/* Sheets ----------------------------------------------------------------------------------------------------------- */

/** A sheet's form: its title (19/700) and lead, the fields, the problem, the buttons. */
function SheetForm({ title, lead, children }: { title: string; lead: string; children: ReactNode }) {
  const theme = useTheme();
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}
    >
      <View style={{ gap: 4 }}>
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          {title}
        </Text>
        <Text size={13.5} lh={1.45} color={theme.colors.mut}>
          {lead}
        </Text>
      </View>
      {children}
    </ScrollView>
  );
}

/** A PIN field: digits only, 4 to 6 (DK-26; the sheet checks the least), hidden as it is typed. */
function PinField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  onChange: (pin: string) => void;
  hint?: string;
}) {
  return (
    <Field
      label={label}
      value={value}
      onChangeText={(v) => onChange(formatDeskPinInput(v))}
      mono
      secureTextEntry
      keyboardType="number-pad"
      maxLength={DESK_PIN_MAX}
      autoComplete="off"
      importantForAutofill="no"
      autoCorrect={false}
      {...(hint ? { hint } : {})}
    />
  );
}

/**
 * Pair the screen (DK-02): the letters the screen shows for 10 minutes (“They change in 8 min.”, then “Show new
 * letters”), a PIN twice, Pair. Wrong letters say how many tries are left; after the last one the screen draws new
 * letters.
 */
function PairSheet({
  visible,
  screen,
  actions,
  onClose,
}: {
  visible: boolean;
  screen: DeskScreen;
  actions: DeskActions;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();
  const D = deskText(rawLocale).dialog;
  const [letters, setLetters] = useState('');
  const [pin, setPin] = useState('');
  const [pinAgain, setPinAgain] = useState('');
  // A problem with the letters shows under them (as on the web), the rest above the buttons.
  const [problem, setProblem] = useState<{ letters: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // The letters' time left, a minute at a time while the sheet is open.
  const now = useDeskClock(visible, 15_000);
  const minutes = screen.pairing ? deskLettersMinutes(screen.pairing.expiresAt, now) : null;
  const close = () => {
    setLetters('');
    setPin('');
    setPinAgain('');
    setProblem(null);
    onClose();
  };
  const newLetters = () => {
    setProblem(null);
    setLetters('');
    actions
      .startPairing()
      .catch((error) => setProblem({ letters: false, text: deskErrorText(error, rawLocale) }));
  };
  const pair = async () => {
    const wrong = deskPairProblem({ letters, pin, pinAgain }, rawLocale);
    if (wrong) return setProblem({ letters: wrong.field === 'letters', text: wrong.text });
    setProblem(null);
    setBusy(true);
    try {
      await actions.pair({ code: deskLetters(letters) ?? letters, pin });
      showNotice(D.done);
      close();
    } catch (error) {
      setProblem({ letters: deskLettersRefused(error), text: deskErrorText(error, rawLocale) });
      if (deskNeedsNewLetters(error)) setLetters('');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={visible} onClose={close} label={D.title} closeLabel={D.cancel}>
      <SheetForm title={D.title} lead={D.lead}>
        <LettersField
          label={D.letters}
          value={letters}
          onChange={(v) => {
            setLetters(v);
            setProblem(null);
          }}
          placeholder={D.lettersPlaceholder}
          hint={minutes === null ? D.expired : D.changesIn(minutes)}
          maxLength={4}
        />
        <ErrorLine text={problem?.letters ? problem.text : null} />
        {minutes === null ? <Button label={D.newLetters} variant="secondary" onPress={newLetters} /> : null}
        <PinField label={D.pin} value={pin} onChange={setPin} />
        <PinField label={D.pinAgain} value={pinAgain} onChange={setPinAgain} />
        <ErrorLine text={problem && !problem.letters ? problem.text : null} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button label={D.cancel} variant="secondary" disabled={busy} onPress={close} style={{ flex: 1 }} />
          <Button
            label={D.submit}
            busy={busy}
            disabled={minutes === null}
            onPress={() => void pair()}
            style={{ flex: 1 }}
          />
        </View>
      </SheetForm>
    </Sheet>
  );
}

/** Change PIN: 4 to 6 digits twice, none too easy (DK-26, DK-27); Choose a PIN while there is none (DK-18). */
function PinSheet({
  visible,
  actions,
  first,
  onClose,
}: {
  visible: boolean;
  actions: DeskActions;
  first: boolean;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();
  const P = first ? deskText(rawLocale).firstPinDialog : deskText(rawLocale).pinDialog;
  const [pin, setPin] = useState('');
  const [pinAgain, setPinAgain] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    setPin('');
    setPinAgain('');
    setProblem(null);
    onClose();
  };
  const save = async () => {
    const wrong = deskPinProblem(pin, pinAgain, rawLocale);
    if (wrong) return setProblem(wrong.text);
    setProblem(null);
    setBusy(true);
    try {
      await actions.setPin(pin);
      showNotice(P.done);
      close();
    } catch (error) {
      setProblem(deskErrorText(error, rawLocale));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={visible} onClose={close} label={P.title} closeLabel={deskText(rawLocale).dialog.cancel}>
      <SheetForm title={P.title} lead={P.lead}>
        <PinField label={deskText(rawLocale).dialog.pin} value={pin} onChange={setPin} />
        <PinField label={deskText(rawLocale).dialog.pinAgain} value={pinAgain} onChange={setPinAgain} />
        <ErrorLine text={problem} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={deskText(rawLocale).dialog.cancel}
            variant="secondary"
            disabled={busy}
            onPress={close}
            style={{ flex: 1 }}
          />
          <Button label={P.submit} busy={busy} onPress={() => void save()} style={{ flex: 1 }} />
        </View>
      </SheetForm>
    </Sheet>
  );
}
