/**
 * REMOTE HELP (Whombat remote-help.md RH-01…RH-12; app remote-help.md AP-4470…), the web's card (AP-4448…AP-4451) in
 * the phone's grouped-card language, in two sizes (docs/app/decisions/about-page.md). On This Whombat → About,
 * `RemoteHelpSummary`: while it's off one row (“Off”, how many visits there were) that opens the Remote help screen;
 * while it's on the state line with Stop, the help code and who is connected, then a row to the screen. On that screen
 * (and the demo world's This Whombat), `RemoteHelpSection`: off, the intro, HOW MUCH as radio cards (Look, Look and
 * fix), FOR HOW LONG as the segmented control (Forever only on a test Whombat), “Turn on remote help” with the passkey
 * hint under it, the confirmation this phone's passkey, or the system's dialog without one; on, as About shows it. Then
 * WHAT SUPPORT DID, one block per visit (who, how much, when, how many steps), the newest three visits and each one's
 * last three steps, the rest behind Show all; a visit's command line opens in a sheet with Share and Download. An
 * older runtime, or a box without a support key, says it isn't available yet. The flow, the states and the words are
 * the shared client's (`useRemoteHelp`, `remoteHelpCard`, `remoteHelpVisitGroups`).
 */
import { useIsFocused } from '@react-navigation/native';
import {
  REMOTE_HELP_DEFAULT_CHOICE,
  REMOTE_HELP_TEXT,
  REMOTE_HELP_WORDS,
  type RemoteHelpApi,
  type RemoteHelpCard,
  type RemoteHelpChoice,
  type RemoteHelpStepRow,
  type RemoteHelpTranscript,
  type RemoteHelpVisitGroup,
  remoteHelpCard,
  remoteHelpChoice,
  remoteHelpVisitGroups,
} from '@whombat/client/managed';
import { type RemoteHelpModel, useRemoteHelp } from '@whombat/client/react';
import { type ReactNode, useMemo, useState } from 'react';
import { Alert, type LayoutChangeEvent, ScrollView, useWindowDimensions, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { tint } from '../ui/glanceColors';
import { Eye, LifeBuoy, SquareTerminal, Wrench } from '../ui/icons';
import { Button, SkeletonRows, StatusDot } from '../ui/primitives';
import { RadioCards } from '../ui/radioCards';
import { Segmented } from '../ui/Segmented';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';
import { COPY } from './copy';
import {
  downloadTranscript,
  helpCodeSpoken,
  remoteHelpConfirm,
  remoteHelpStepLabel,
  type ShowAlert,
  shareTranscript,
  transcriptShown,
} from './remoteHelp';
import { transcriptFiles } from './remoteHelpFiles';
import { Card, IconTile, LinkRow, Row } from './ui';
import { useForeground } from './useHostStatus';
import type { RemoteHelpHere } from './useRemoteHelpHere';

const W = REMOTE_HELP_WORDS;
const T = REMOTE_HELP_TEXT;

type OffCard = Extract<RemoteHelpCard, { kind: 'off' }>;
type OnCard = Extract<RemoteHelpCard, { kind: 'on' }>;

/** How many visits and steps show before Show all. */
const VISITS_SHOWN = 3;
const STEPS_SHOWN = 3;

/** The card's state, asked only while the screen is in front and the app in the foreground. */
function useRemoteHelpHereCard(here: RemoteHelpHere) {
  // Asked (and every 10 s while it's on) only while this screen is in front and the app in the foreground, as the
  // phone's other live parts are (AP-4471); back in front, it reads again.
  const focused = useIsFocused();
  const foreground = useForeground();
  const model = useRemoteHelp(here.api, focused && foreground);
  const { timeZone } = useBurrowBase();
  const card = remoteHelpCard({
    state: model.state,
    hasPasskey: model.hasPasskey,
    now: new Date(),
    timeZone,
  });
  return { model, card, timeZone };
}

/** The card's top when it can't show the controls: not available here, couldn't load, or loading. */
function NotReady({ card, model }: { card: RemoteHelpCard; model: RemoteHelpModel }) {
  const theme = useTheme();
  if (card.kind === 'unavailable')
    return (
      <Part first>
        <Text size={14} lh={1.45} color={theme.colors.ink2}>
          {card.text}
        </Text>
      </Part>
    );
  if (model.loadError && !model.state)
    return (
      <Row
        first
        dot="mut"
        title={T.loadError}
        action={
          <Button
            label={T.retry}
            variant="secondary"
            onPress={model.reload}
            style={{ paddingHorizontal: 14 }}
          />
        }
      />
    );
  return <SkeletonRows count={1} lines={2} />;
}

/**
 * REMOTE HELP on About: short, so a long history doesn't fill the page. Off: one row to the Remote help screen. On: the
 * state with Stop, the help code and who is connected stay here, then a row to what support did.
 */
export function RemoteHelpSummary({
  here,
  onOpen,
  onLayout,
}: {
  here: RemoteHelpHere;
  onOpen: () => void;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const { model, card } = useRemoteHelpHereCard(here);
  if (!here.shown) return null;
  const visits = model.visits?.length ?? 0;
  const count = visits > 0 ? T.visitCount(visits) : null;
  return (
    <View onLayout={onLayout}>
      <Card label={W.title.toUpperCase()}>
        {card.kind === 'off' ? (
          <LinkRow
            first
            icon={LifeBuoy}
            title={T.offTitle}
            body={T.offLine}
            meta={count}
            label={[W.title, T.offTitle, T.offLine, count].filter(Boolean).join(', ')}
            onPress={onOpen}
          />
        ) : card.kind === 'on' ? (
          <>
            <OnPart card={card} model={model} />
            <LinkRow
              icon={LifeBuoy}
              title={W.visits}
              meta={count}
              label={[W.visits, count].filter(Boolean).join(', ')}
              onPress={onOpen}
            />
          </>
        ) : (
          <NotReady card={card} model={model} />
        )}
      </Card>
    </View>
  );
}

/** REMOTE HELP in full (the Remote help screen, the demo world's This Whombat), then WHAT SUPPORT DID. */
export function RemoteHelpSection({
  here,
  onLayout,
}: {
  here: RemoteHelpHere;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const { model, card, timeZone } = useRemoteHelpHereCard(here);
  if (!here.shown) return null;
  return (
    <View onLayout={onLayout} style={{ gap: 14 }}>
      <Card label={W.title.toUpperCase()}>
        {card.kind === 'off' ? (
          <OffPart card={card} model={model} here={here} />
        ) : card.kind === 'on' ? (
          <OnPart card={card} model={model} />
        ) : (
          <NotReady card={card} model={model} />
        )}
      </Card>
      {card.kind === 'off' || card.kind === 'on' ? (
        <VisitsCard model={model} api={here.api} timeZone={timeZone} />
      ) : null}
    </View>
  );
}

/* Parts of the card ------------------------------------------------------------------------------------------------- */

/** One part of the card: 16dp in, a hairline above all but the first (the desk's). */
function Part({ first = false, children }: { first?: boolean; children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 12,
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

/**
 * The small label of the card's parts (“HOW MUCH”, “HELP CODE”), the section label's type. A control's own label says
 * it to TalkBack (`spoken`: false); a part without one reads it as its header.
 */
function PartLabel({ children, spoken = true }: { children: string; spoken?: boolean }) {
  const theme = useTheme();
  return (
    <Text
      size={11}
      weight={500}
      mono
      tracking={0.05}
      color={theme.colors.mut}
      {...(spoken
        ? { accessibilityRole: 'header' as const }
        : { importantForAccessibility: 'no' as const, accessibilityElementsHidden: true })}
    >
      {children.toUpperCase()}
    </Text>
  );
}

/** What went wrong, read out at once. */
function Problem({ text }: { text: string | null }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text
      size={13.5}
      lh={1.45}
      color={theme.colors.ink2}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      {text}
    </Text>
  );
}

/** Off (AP-4472): the intro, how much, for how long, the button and the passkey hint. */
function OffPart({ card, model, here }: { card: OffCard; model: RemoteHelpModel; here: RemoteHelpHere }) {
  const theme = useTheme();
  const [picked, setPicked] = useState<RemoteHelpChoice>(REMOTE_HELP_DEFAULT_CHOICE);
  const choice = remoteHelpChoice(picked, model.state);
  const confirm = useMemo(() => remoteHelpConfirm(Alert.alert as ShowAlert), []);
  const busy = model.busy !== null;
  const levels = useMemo(
    () => card.levels.map((l) => ({ value: l.value, title: l.label, line: l.text })),
    [card.levels],
  );
  const turnOn = () =>
    void model.turnOn(choice, { platform: here.platform, endpoint: here.endpoint, confirm });
  return (
    <Part first>
      <Text size={14} lh={1.5} color={theme.colors.ink2}>
        {card.intro}
      </Text>
      <View style={{ gap: 8 }}>
        <PartLabel spoken={false}>{card.howMuch}</PartLabel>
        <RadioCards
          label={card.howMuch}
          options={levels}
          value={choice.level}
          disabled={busy}
          onChange={(level) => setPicked((c) => ({ ...c, level }))}
        />
      </View>
      <View style={{ gap: 8 }}>
        <PartLabel spoken={false}>{card.howLong}</PartLabel>
        <Segmented
          label={card.howLong}
          options={card.durations}
          value={choice.duration}
          disabled={busy}
          onChange={(duration) => setPicked((c) => ({ ...c, duration }))}
        />
      </View>
      <View style={{ gap: 8, paddingTop: 2 }}>
        <Button
          label={card.button}
          busy={model.busy === 'on'}
          disabled={busy}
          onPress={turnOn}
          {...(card.hint && { accessibilityHint: card.hint })}
        />
        {card.hint ? (
          <Text size={13.5} lh={1.4} color={theme.colors.mut} importantForAccessibility="no">
            {card.hint}
          </Text>
        ) : null}
      </View>
      <Problem text={model.problem} />
    </Part>
  );
}

/** On (AP-4474): the state line with Stop on the warm wash, the help code, who is connected. */
function OnPart({ card, model }: { card: OnCard; model: RemoteHelpModel }) {
  const theme = useTheme();
  return (
    <>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          minHeight: 64,
          paddingVertical: 10,
          paddingHorizontal: 16,
          backgroundColor: tint(theme.colors.warn, 0.07),
        }}
      >
        <StatusDot color={theme.colors.warn} size={9} label={T.onLabel} />
        <Text size={15} weight={600} lh={1.35} style={{ flex: 1, minWidth: 0 }}>
          {card.line}
        </Text>
        {/* Disabled while it stops, not a spinner: a spinner would narrow the button under the finger. */}
        <Button
          label={card.stop}
          variant="secondary"
          disabled={model.busy !== null}
          onPress={() => void model.stop()}
          style={{ paddingHorizontal: 18 }}
        />
      </View>
      {model.problem ? (
        <Part>
          <Problem text={model.problem} />
        </Part>
      ) : null}
      {card.helpCode ? (
        <Part>
          <View
            accessible
            accessibilityLabel={`${card.helpCode.label}, ${helpCodeSpoken(card.helpCode.code)}`}
            style={{ gap: 6 }}
          >
            <PartLabel spoken={false}>{card.helpCode.label}</PartLabel>
            <Text size={20} weight={500} mono tracking={0.12} selectable>
              {card.helpCode.code}
            </Text>
          </View>
          <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
            {card.helpCode.hint}
          </Text>
        </Part>
      ) : null}
      {card.connected.map((c) => (
        <View
          key={c.key}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            minHeight: 52,
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <StatusDot color={theme.colors.ok} size={9} label={T.connectedLabel} />
          <Text size={14.5} lh={1.4} style={{ flex: 1 }}>
            {c.text}
          </Text>
        </View>
      ))}
    </>
  );
}

/**
 * WHAT SUPPORT DID (AP-4475): one block per visit, the newest three, the rest behind “Show N earlier visits”. A
 * visit's Command line opens what the command line showed in the sheet.
 */
function VisitsCard({
  model,
  api,
  timeZone,
}: {
  model: RemoteHelpModel;
  api: RemoteHelpApi | null;
  timeZone: string;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState<{ visitId: string; transcript: RemoteHelpTranscript } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [all, setAll] = useState(false);
  const groups = useMemo(
    () => (model.visits ? remoteHelpVisitGroups(model.visits, { now: new Date(), timeZone }) : null),
    [model.visits, timeZone],
  );
  const show = async (visitId: string) => {
    if (!api || loading) return;
    setFailed(false);
    setLoading(visitId);
    try {
      setOpen({ visitId, transcript: await api.transcript(visitId) });
    } catch {
      setFailed(true);
    } finally {
      setLoading(null);
    }
  };
  const shown = groups ? (all ? groups : groups.slice(0, VISITS_SHOWN)) : [];
  const hidden = groups ? groups.length - shown.length : 0;
  return (
    <Card label={W.visits.toUpperCase()}>
      {groups === null ? (
        <SkeletonRows count={1} lines={2} />
      ) : groups.length === 0 ? (
        <Part first>
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {W.noVisits}
          </Text>
        </Part>
      ) : (
        shown.map((g, i) => (
          <Visit key={g.key} group={g} first={i === 0} loading={loading === g.visitId} onShow={show} />
        ))
      )}
      {hidden > 0 ? (
        <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.line, paddingHorizontal: 16 }}>
          <TextLink label={T.earlierVisits(hidden)} onPress={() => setAll(true)} />
        </View>
      ) : null}
      {failed ? (
        <Part>
          <Problem text={T.transcriptFailed} />
        </Part>
      ) : null}
      <TranscriptSheet open={open} onClose={() => setOpen(null)} />
    </Card>
  );
}

/**
 * One visit: an eye (Look) or a wrench (Look and fix), green while it lasts, with who came and “Now”; when it started,
 * how much they could do and how many steps; then its last three steps, Show all for the rest, and Command line where
 * one was kept.
 */
function Visit({
  group: g,
  first,
  loading,
  onShow,
}: {
  group: RemoteHelpVisitGroup;
  first: boolean;
  loading: boolean;
  onShow: (visitId: string) => Promise<void>;
}) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const steps = open ? g.steps : g.steps.slice(-STEPS_SHOWN);
  const more = g.steps.length > STEPS_SHOWN;
  return (
    <View
      style={{
        gap: 10,
        paddingTop: 14,
        paddingBottom: more || g.transcript ? 4 : 14,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={[g.who, g.ongoing ? T.now : null, g.when, g.line].filter(Boolean).join(', ')}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}
      >
        <IconTile icon={g.level === 'fix' ? Wrench : Eye} tone={g.ongoing ? 'ok' : null} />
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Text size={15} weight={600} lh={1.35} style={{ flexShrink: 1 }}>
              {g.who}
            </Text>
            {g.ongoing ? (
              <View
                style={{
                  paddingVertical: 1,
                  paddingHorizontal: 7,
                  borderRadius: 999,
                  backgroundColor: tint(theme.colors.ok, 0.14),
                }}
              >
                <Text size={11.5} weight={600} color={theme.colors.ok}>
                  {T.now}
                </Text>
              </View>
            ) : null}
          </View>
          <Text size={12.5} lh={1.4} color={theme.colors.mut}>
            {`${g.when} · ${g.line}`}
          </Text>
        </View>
      </View>
      {/* The steps under the words, past the icon. */}
      <View style={{ paddingLeft: 48 }}>
        {steps.map((r) => (
          <Step key={r.key} row={r} />
        ))}
      </View>
      {more || g.transcript ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 20, paddingLeft: 48 }}>
          {more ? (
            <TextLink
              label={open ? T.fewerSteps : T.allSteps(g.steps.filter((r) => !r.muted).length)}
              onPress={() => setOpen((o) => !o)}
            />
          ) : null}
          {g.transcript ? (
            <TextLink
              label={W.transcript.title}
              icon={SquareTerminal}
              busy={loading}
              onPress={() => void onShow(g.transcript as string)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A link-styled button, 44 high: Show all, Command line. */
function TextLink({
  label,
  onPress,
  icon: Icon,
  busy = false,
}: {
  label: string;
  onPress: () => void;
  icon?: typeof SquareTerminal;
  busy?: boolean;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      disabled={busy}
      feedback="fade"
      ringRadius={8}
      accessibilityRole="button"
      accessibilityState={{ busy }}
      accessibilityLabel={label}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, opacity: busy ? 0.45 : 1 }}
    >
      {Icon ? <Icon size={15} color={theme.colors.brand} strokeWidth={2} /> : null}
      <Text size={13.5} weight={600} color={theme.colors.brand}>
        {label}
      </Text>
    </Touchable>
  );
}

/** A step: its time in mono, its words (a command line in code style). */
function Step({ row }: { row: RemoteHelpStepRow }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={remoteHelpStepLabel(row)}
      style={{ flexDirection: 'row', alignItems: 'baseline', gap: 10, paddingVertical: 4 }}
    >
      {row.time ? (
        <Text size={12} mono color={theme.colors.mut} style={{ minWidth: 42 }}>
          {row.time}
        </Text>
      ) : null}
      <Text
        size={13.5}
        lh={1.45}
        color={row.muted ? theme.colors.mut : theme.colors.ink2}
        style={{ flex: 1, minWidth: 0 }}
      >
        {row.text}
        {row.code ? (
          <>
            {' '}
            <Text size={12.5} mono color={theme.colors.ink} style={{ backgroundColor: theme.colors.sf2 }}>
              {/* Kept off the line's ends when it wraps: the padding is part of the code's wash. */}
              {`\u00a0${row.code}\u00a0`}
            </Text>
          </>
        ) : null}
      </Text>
    </View>
  );
}

/**
 * The command line (AP-4476, AP-4477) in a sheet: its title, the record in mono in a scrolling block (the start of a
 * long one, and a line saying so), then Share (Android's share sheet) and Download (“Save as”), as the phone gives
 * DIAGNOSTICS' files. The backdrop, the handle and Back close it.
 */
function TranscriptSheet({
  open,
  onClose,
}: {
  open: { visitId: string; transcript: RemoteHelpTranscript } | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  const window = useWindowDimensions();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const shown = useMemo(() => (open ? transcriptShown(open.transcript.text) : null), [open]);
  const close = () => {
    setNote(null);
    onClose();
  };
  const act = async (work: (visitId: string, bytes: Uint8Array) => Promise<unknown>) => {
    if (!open || busy) return;
    setBusy(true);
    setNote(null);
    try {
      await work(open.visitId, open.transcript.bytes);
    } catch {
      setNote(T.failed);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={open !== null} onClose={close} label={W.transcript.title} closeLabel={T.close}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}>
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          {W.transcript.title}
        </Text>
        <ScrollView
          style={{
            maxHeight: Math.round(window.height * 0.5),
            borderRadius: 12,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf2,
          }}
          contentContainerStyle={{ paddingVertical: 12, paddingHorizontal: 14 }}
        >
          <Text size={12} mono lh={1.55} color={theme.colors.ink} selectable>
            {shown?.text ?? ''}
          </Text>
        </ScrollView>
        {shown?.cut ? (
          <Text size={13} lh={1.45} color={theme.colors.mut}>
            {COPY.remoteHelp.cut}
          </Text>
        ) : null}
        <Problem text={note} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={COPY.remoteHelp.share}
            variant="secondary"
            disabled={busy}
            onPress={() => void act((visitId, bytes) => shareTranscript(transcriptFiles, visitId, bytes))}
            style={{ flex: 1 }}
          />
          <Button
            label={W.transcript.download}
            disabled={busy}
            onPress={() => void act((visitId, bytes) => downloadTranscript(transcriptFiles, visitId, bytes))}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Sheet>
  );
}
