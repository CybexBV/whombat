/**
 * Answering a run's tracker report from the phone (Whombat report-trackers.md TA-15; the web's two modals, the same
 * words and rules): “Reply to the reporter” — a reply, and optionally a status with it — and “Set the status” — one of
 * the seven a person sets, and optionally a reply (Not planned needs one). A problem shows under its field; a refusal or
 * an error shows in the sheet, read out, and the sheet stays open. The run page sends (`TrackerItemSection`), so a
 * retry carries the same request id.
 */
import { TRACKER_REPLY_MAX, type TrackerUpdateStatus } from '@whombat/core';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import {
  initialStatus,
  replyDoneText,
  replyProblem,
  replyStatusChoices,
  statusChoices,
  statusDoneText,
  statusProblem,
  type TrackerItemModel,
  type TrackerProblem,
  type TrackerSend,
  type TrackerStatusChoice,
  trackerReplyText,
  trackerSend,
  trackerStatusSheetText,
} from '../data/trackerItem';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField } from '../ui/formField';
import { Check } from '../ui/icons';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';

interface SheetProps {
  visible: boolean;
  model: TrackerItemModel;
  /** A send is on its way: the buttons wait. */
  busy: boolean;
  /** Sends it; null once it went through (the run page closes the sheet and toasts), else what to say here. */
  onSend: (send: TrackerSend, done: string) => Promise<string | null>;
  onClose: () => void;
}

export function TrackerReplySheet(props: SheetProps) {
  const { rawLocale } = useI18n();
  const replyText = trackerReplyText(rawLocale);
  return (
    <Sheet
      visible={props.visible}
      onClose={props.onClose}
      label={replyText.title}
      closeLabel={replyText.cancel}
      maxHeight="90%"
    >
      {props.visible ? <ReplyForm {...props} /> : null}
    </Sheet>
  );
}

export function TrackerStatusSheet(props: SheetProps) {
  const { rawLocale } = useI18n();
  const statusText = trackerStatusSheetText(rawLocale);
  return (
    <Sheet
      visible={props.visible}
      onClose={props.onClose}
      label={statusText.title}
      closeLabel={statusText.cancel}
      maxHeight="90%"
    >
      {props.visible ? <StatusForm {...props} /> : null}
    </Sheet>
  );
}

function ReplyForm({ model, busy, onSend, onClose }: SheetProps) {
  const { rawLocale } = useI18n();
  const replyText = trackerReplyText(rawLocale);
  const [message, setMessage] = useState('');
  const [status, setStatus] = useState<TrackerUpdateStatus | null>(null);
  const [problem, setProblem] = useState<TrackerProblem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const p = replyProblem(message, rawLocale);
    setProblem(p);
    setError(null);
    if (p) return;
    const send = trackerSend(message, status);
    setError(await onSend(send, replyDoneText(send, rawLocale)));
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 4 }}>
      <Heading title={replyText.title} context={model.context} />
      <View style={{ paddingHorizontal: 22, paddingBottom: 14 }}>
        <FormField
          kicker
          label={replyText.reply}
          value={message}
          onChangeText={(v) => {
            setMessage(v);
            setProblem(null);
            setError(null);
          }}
          error={problem?.field === 'message' ? problem.text : null}
          placeholder={replyText.placeholder}
          multiline
          autoFocus
          maxLength={TRACKER_REPLY_MAX}
        />
      </View>
      <StatusChoices
        label={replyText.alsoStatus}
        choices={replyStatusChoices(model.status, rawLocale)}
        value={status}
        busy={busy}
        onChange={(v) => {
          setStatus(v);
          setError(null);
        }}
      />
      <Footer
        note={model.replyNote}
        message={error}
        cancel={replyText.cancel}
        submit={replyText.send}
        busy={busy}
        onCancel={onClose}
        onSubmit={() => void submit()}
      />
    </ScrollView>
  );
}

function StatusForm({ model, busy, onSend, onClose }: SheetProps) {
  const { rawLocale } = useI18n();
  const replyText = trackerReplyText(rawLocale);
  const statusText = trackerStatusSheetText(rawLocale);
  const [status, setStatus] = useState<TrackerUpdateStatus | null>(() => initialStatus(model.status));
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<TrackerProblem | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    const p = statusProblem(model.status, status, message, rawLocale);
    setProblem(p);
    setError(null);
    if (p) return;
    const send = trackerSend(message, status);
    setError(await onSend(send, statusDoneText(send, rawLocale)));
  };

  return (
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 4 }}>
      <Heading title={statusText.title} context={model.context} />
      <StatusChoices
        label={statusText.status}
        choices={statusChoices(rawLocale)}
        value={status}
        busy={busy}
        onChange={(v) => {
          setStatus(v);
          setProblem(null);
          setError(null);
        }}
      />
      {problem?.field === 'status' ? (
        <View style={{ paddingHorizontal: 22, paddingTop: 10 }}>
          <Alerted text={problem.text} />
        </View>
      ) : null}
      <View style={{ paddingHorizontal: 22, paddingTop: 14 }}>
        <FormField
          kicker
          label={statusText.reply}
          value={message}
          onChangeText={(v) => {
            setMessage(v);
            setProblem(null);
            setError(null);
          }}
          error={problem?.field === 'message' ? problem.text : null}
          hint={statusText.hint}
          placeholder={replyText.placeholder}
          multiline
          maxLength={TRACKER_REPLY_MAX}
        />
      </View>
      <Footer
        note={model.statusNote}
        message={error}
        cancel={statusText.cancel}
        submit={statusText.set}
        busy={busy}
        onCancel={onClose}
        onSubmit={() => void submit()}
      />
    </ScrollView>
  );
}

/** The sheet's title (19/700) and what it answers (“Acme Desk dev #15 · The rollout never finishes”). */
function Heading({ title, context }: { title: string; context: string }) {
  const theme = useTheme();
  return (
    <View style={{ gap: 4, paddingHorizontal: 22, paddingTop: 6, paddingBottom: 14 }}>
      <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
        {title}
      </Text>
      <Text size={13.5} lh={1.4} color={theme.colors.mut}>
        {context}
      </Text>
    </View>
  );
}

/**
 * The statuses as radio rows (44dp, the chosen one checked in `brand`), edge to edge between hairlines as a sheet's
 * rows are, under their mono label (ALSO SET THE STATUS, STATUS).
 */
function StatusChoices({
  label,
  choices,
  value,
  busy,
  onChange,
}: {
  label: string;
  choices: readonly TrackerStatusChoice[];
  value: TrackerUpdateStatus | null;
  busy: boolean;
  onChange: (value: TrackerUpdateStatus | null) => void;
}) {
  const theme = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label}>
      <Text
        size={11}
        weight={500}
        mono
        tracking={0.05}
        color={theme.colors.mut}
        style={{ paddingHorizontal: 22, paddingBottom: 6 }}
      >
        {label}
      </Text>
      {choices.map((c) => {
        const checked = c.value === value;
        return (
          <Touchable
            key={c.value ?? 'leave'}
            onPress={() => onChange(c.value)}
            disabled={busy}
            feedback="wash"
            accessibilityRole="radio"
            accessibilityState={{ checked, disabled: busy }}
            accessibilityLabel={c.label}
            style={{
              minHeight: 44,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 10,
              paddingHorizontal: 22,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <Text size={15.5} weight={checked ? 600 : 500} style={{ flex: 1 }}>
              {c.label}
            </Text>
            {checked ? <Check size={20} color={theme.colors.brand} strokeWidth={2.25} /> : null}
          </Touchable>
        );
      })}
      <View style={{ height: 1, backgroundColor: theme.colors.line }} />
    </View>
  );
}

/** A refusal, an error or a problem that isn't one field's: `bad`, announced as it appears. */
function Alerted({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text
      size={13.5}
      lh={1.45}
      color={theme.colors.bad}
      accessibilityRole="alert"
      accessibilityLiveRegion="assertive"
    >
      {text}
    </Text>
  );
}

function Footer({
  note,
  message,
  cancel,
  submit,
  busy,
  onCancel,
  onSubmit,
}: {
  note: string;
  message: string | null;
  cancel: string;
  submit: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const theme = useTheme();
  return (
    <View style={{ paddingHorizontal: 22, paddingTop: 14, gap: 12 }}>
      <Text size={13.5} lh={1.45} color={theme.colors.mut}>
        {note}
      </Text>
      {message ? <Alerted text={message} /> : null}
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label={cancel} variant="secondary" disabled={busy} onPress={onCancel} style={{ flex: 1 }} />
        <Button label={submit} busy={busy} onPress={onSubmit} style={{ flex: 1 }} />
      </View>
    </View>
  );
}
