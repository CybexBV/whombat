/**
 * REMOTE HELP on This Whombat → About (Whombat remote-help.md RH-01…RH-12; app remote-help.md AP-4470…), above
 * DIAGNOSTICS: the web's card (AP-4448…AP-4451) in the phone's grouped-card language. Off: the intro, HOW MUCH as
 * radio cards (Look, Look and fix), FOR HOW LONG as the segmented control (Forever only on a test Whombat), “Turn on
 * remote help” with the passkey hint under it; the confirmation is this phone's passkey, or Android's dialog without
 * one. On: the state line on NEEDS YOU's warm wash with Stop, the help code a customer's Whombat needs,
 * who is connected. Always: WHAT SUPPORT DID, a visit's command line behind Show in a sheet with Share and Download. An
 * older runtime, or a box without a support key, says it isn't available yet. The flow, the states and the words are
 * the shared client's (`useRemoteHelp`, `remoteHelpCard`, `remoteHelpVisitRows`).
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
  remoteHelpCard,
  remoteHelpChoice,
  remoteHelpVisitRows,
} from '@whombat/client/managed';
import { type RemoteHelpModel, useRemoteHelp } from '@whombat/client/react';
import { type ReactNode, useMemo, useState } from 'react';
import { Alert, type LayoutChangeEvent, ScrollView, useWindowDimensions, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { tint } from '../ui/glanceColors';
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
import { Card, Row } from './ui';
import { useForeground } from './useHostStatus';
import type { RemoteHelpHere } from './useRemoteHelpHere';

const W = REMOTE_HELP_WORDS;
const T = REMOTE_HELP_TEXT;

type OffCard = Extract<RemoteHelpCard, { kind: 'off' }>;
type OnCard = Extract<RemoteHelpCard, { kind: 'on' }>;

export function RemoteHelpSection({
  here,
  onLayout,
}: {
  here: RemoteHelpHere;
  onLayout?: (event: LayoutChangeEvent) => void;
}) {
  const theme = useTheme();
  // Asked (and every 10 s while it's on) only while this screen is in front and the app in the foreground, as the
  // phone's other live parts are (AP-4471); back in front, it reads again.
  const focused = useIsFocused();
  const foreground = useForeground();
  const model = useRemoteHelp(here.api, focused && foreground);
  const { timeZone } = useBurrowBase();
  if (!here.shown) return null;
  const card = remoteHelpCard({
    state: model.state,
    hasPasskey: model.hasPasskey,
    now: new Date(),
    timeZone,
  });
  return (
    <View onLayout={onLayout}>
      <Card label={W.title.toUpperCase()}>
        {card.kind === 'unavailable' ? (
          <Part first>
            <Text size={14} lh={1.45} color={theme.colors.ink2}>
              {card.text}
            </Text>
          </Part>
        ) : model.loadError && !model.state ? (
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
        ) : card.kind === 'loading' ? (
          <SkeletonRows count={2} lines={2} />
        ) : card.kind === 'off' ? (
          <OffPart card={card} model={model} here={here} />
        ) : (
          <OnPart card={card} model={model} />
        )}
        {card.kind === 'off' || card.kind === 'on' ? (
          <VisitsPart model={model} api={here.api} timeZone={timeZone} />
        ) : null}
      </Card>
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

/** WHAT SUPPORT DID (AP-4475): every visit's steps, Show opening a command line in the sheet. */
function VisitsPart({
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
  const rows = useMemo(
    () => (model.visits ? remoteHelpVisitRows(model.visits, { now: new Date(), timeZone }) : null),
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
  return (
    <Part>
      <PartLabel>{W.visits}</PartLabel>
      {rows === null ? null : rows.length === 0 ? (
        <Text size={13.5} lh={1.45} color={theme.colors.mut}>
          {W.noVisits}
        </Text>
      ) : (
        <View>
          {rows.map((r) => (
            <Step key={r.key} row={r} loading={loading === r.transcript} onShow={show} />
          ))}
        </View>
      )}
      {failed ? <Problem text={T.transcriptFailed} /> : null}
      <TranscriptSheet open={open} onClose={() => setOpen(null)} />
    </Part>
  );
}

/** A step: its time in mono, its words (a command line in code style), Show at the end where there is a record. */
function Step({
  row,
  loading,
  onShow,
}: {
  row: RemoteHelpStepRow;
  loading: boolean;
  onShow: (visitId: string) => Promise<void>;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 36,
        paddingVertical: 7,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessible
        accessibilityLabel={remoteHelpStepLabel(row)}
        style={{ flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', gap: 12 }}
      >
        <Text size={12} mono color={theme.colors.mut} style={{ minWidth: 42 }}>
          {row.time}
        </Text>
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
      {row.transcript ? (
        <Touchable
          onPress={() => void onShow(row.transcript as string)}
          disabled={loading}
          feedback="fade"
          ringRadius={8}
          accessibilityRole="button"
          accessibilityState={{ busy: loading }}
          accessibilityLabel={`${W.transcript.show} ${W.transcript.title.toLowerCase()}`}
          style={{ minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' }}
        >
          <Text size={13.5} weight={600} color={theme.colors.brand} style={{ opacity: loading ? 0.45 : 1 }}>
            {W.transcript.show}
          </Text>
        </Touchable>
      ) : null}
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
