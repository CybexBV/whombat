/**
 * The tracker report a run started from, on the run page above its steps (Whombat report-trackers.md TA-14, TA-15;
 * only on a Whombat with `automations.tracker`): read live from its tracker, named in its driver's words — the heading, where it came from, its tags,
 * the reporter, what happened and what they expected, the screenshot (tap for full screen), the conversation and the
 * release — and, for people who may (`can.update`), “Reply to the reporter…” and “Set status…”. What the customer wrote
 * is plain text, never Markdown or links. A send keeps its request id until it goes through (`trackerRequest`), so a
 * retry of the same words never emails the reporter twice.
 */
import { useQueryClient } from '@tanstack/react-query';
import { trackerItemText } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { queryHook, useApiMutation } from '@whombat/client/react';
import type { TrackerWords } from '@whombat/core';
import { api } from '@whombat/core/contracts';
import { randomUUID } from 'expo-crypto';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { Image, View } from 'react-native';
import { useViewContext } from '../data/BurrowProvider';
import {
  spokenLabel,
  type TrackerItemModel,
  type TrackerRequest,
  type TrackerSend,
  trackerItemErrorText,
  trackerItemModel,
  trackerReportText,
  trackerRequest,
} from '../data/trackerItem';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FullScreenModal } from '../ui/fullScreen';
import { X } from '../ui/icons';
import { Button, Section } from '../ui/primitives';
import { Touchable } from '../ui/Touchable';
import { errorText, showNotice } from './feedback';
import { TrackerReplySheet, TrackerStatusSheet } from './TrackerSheets';

/** `tracker.item`: a run's report, read live from its tracker (contracts 0.69). */
export const useTrackerItem = queryHook(api.tracker.item);

export function TrackerItemSection({
  query,
  burrow,
  runId,
  words,
}: {
  query: ReturnType<typeof useTrackerItem>;
  burrow: string;
  runId: string;
  /** The tracker's words as the automation keeps them, until the report says its own. */
  words: TrackerWords;
}) {
  const { rawLocale } = useI18n();
  const copy = trackerReportText(rawLocale);
  const theme = useTheme();
  const { now, timeZone } = useViewContext();
  const data = query.data;
  const model = useMemo(
    () => (data ? trackerItemModel(data.report, data.can, now, timeZone, rawLocale) : null),
    [data, now, timeZone, rawLocale],
  );
  return (
    <Section title={copy.section}>
      {model ? (
        <Report model={model} burrow={burrow} runId={runId} />
      ) : query.error ? (
        <Block>
          <Text size={14} lh={1.42} color={theme.colors.ink2} accessibilityLiveRegion="polite">
            {trackerItemErrorText(query.error, words, rawLocale)}
          </Text>
          <Button
            label={copy.tryAgain}
            variant="secondary"
            busy={query.isFetching}
            onPress={() => void query.refetch()}
            style={{ alignSelf: 'flex-start', marginTop: 4 }}
          />
        </Block>
      ) : (
        <Block>
          <Text size={14} lh={1.42} color={theme.colors.mut}>
            {trackerItemText(words, rawLocale).loading}
          </Text>
        </Block>
      )}
    </Section>
  );
}

function Report({ model, burrow, runId }: { model: TrackerItemModel; burrow: string; runId: string }) {
  const { rawLocale } = useI18n();
  const copy = trackerReportText(rawLocale);
  const theme = useTheme();
  const qc = useQueryClient();
  const update = useApiMutation(api.tracker.update);
  const [sheet, setSheet] = useState<'reply' | 'status' | null>(null);
  const [viewing, setViewing] = useState(false);
  /** The last send's request id and content, kept until it goes through (TA-15). */
  const last = useRef<TrackerRequest | null>(null);
  const params = { burrow, runId };

  /** Sends a reply and/or a status; null once it went through, else what to say in the sheet. */
  const send = async (body: TrackerSend, done: string): Promise<string | null> => {
    const request = trackerRequest(last.current, body, randomUUID);
    last.current = request;
    try {
      const res = await update.mutateAsync({ params, body: { requestId: request.id, ...body } });
      // Refused by a key, or waiting for a person (the web's words): the sheet stays, and so does the request id.
      if (res.status === 'blocked') return res.message;
      if (res.status === 'pending_approval') return copy.needsApproval;
      last.current = null;
      qc.setQueryData(queryKeys.endpoint(api.tracker.item, { params }), (old) =>
        old ? { ...old, report: res.data.report } : old,
      );
      setSheet(null);
      showNotice(done);
      return null;
    } catch (error) {
      return errorText(error, rawLocale);
    }
  };

  return (
    <>
      <View
        accessible
        accessibilityLabel={model.accessibilityLabel}
        style={{
          gap: 6,
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <Text size={17} weight={600} lh={1.3}>
          {model.heading}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.mut}>
          {model.place}
        </Text>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingTop: 2 }}>
          {model.tags.map((tag, i) => (
            <View
              key={tag}
              style={{
                paddingVertical: 2,
                paddingHorizontal: 7,
                borderRadius: theme.radii.tag,
                backgroundColor: theme.colors.sf2,
              }}
            >
              <Text
                size={10.5}
                weight={500}
                mono
                tracking={0.04}
                uppercase
                color={i === 0 ? theme.colors.ink : theme.colors.ink2}
              >
                {tag}
              </Text>
            </View>
          ))}
        </View>
      </View>
      <Field label={copy.reporter} value={model.reporter} />
      <Field label={copy.filed} value={model.filed} />
      {model.fix ? <Field label={copy.fix} value={model.fix} /> : null}
      <Field label={copy.happened} value={model.description} />
      {model.expected ? <Field label={copy.expected} value={model.expected} /> : null}
      {model.screenshot ? (
        <Block>
          <Label>{copy.screenshot}</Label>
          <Touchable
            onPress={() => setViewing(true)}
            feedback="fade"
            ringRadius={12}
            accessibilityRole="imagebutton"
            accessibilityLabel={copy.screenshotLabel}
            accessibilityHint={copy.screenshotHint}
            style={{
              height: 180,
              borderRadius: 12,
              overflow: 'hidden',
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.sf2,
            }}
          >
            <Image
              source={{ uri: model.screenshot }}
              resizeMode="contain"
              style={{ width: '100%', height: '100%' }}
            />
          </Touchable>
        </Block>
      ) : null}
      <Block>
        <Label>{copy.conversation}</Label>
        {model.messages.length === 0 ? (
          <Text size={15} lh={1.42} color={theme.colors.mut}>
            {copy.noReplies}
          </Text>
        ) : (
          model.messages.map((m) => (
            <View key={m.key} accessible accessibilityLabel={m.accessibilityLabel} style={{ gap: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
                <Text size={13.5} weight={600}>
                  {m.author}
                </Text>
                <Text size={11.5} mono color={theme.colors.mut}>
                  {m.time}
                </Text>
              </View>
              <Text size={15} lh={1.42} color={theme.colors.ink2} selectable>
                {m.body}
              </Text>
            </View>
          ))
        )}
        {model.release ? (
          <Text size={14} lh={1.42} color={theme.colors.ink2}>
            {model.release}
          </Text>
        ) : null}
      </Block>
      {model.canUpdate ? (
        <Block>
          <Button label={copy.reply} variant="secondary" onPress={() => setSheet('reply')} />
          <Button label={copy.setStatus} variant="secondary" onPress={() => setSheet('status')} />
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {model.emails}
          </Text>
        </Block>
      ) : null}
      <TrackerReplySheet
        visible={sheet === 'reply'}
        model={model}
        busy={update.isPending}
        onSend={send}
        onClose={() => setSheet(null)}
      />
      <TrackerStatusSheet
        visible={sheet === 'status'}
        model={model}
        busy={update.isPending}
        onSend={send}
        onClose={() => setSheet(null)}
      />
      {model.screenshot ? (
        <ScreenshotViewer uri={model.screenshot} visible={viewing} onClose={() => setViewing(false)} />
      ) : null}
    </>
  );
}

/** A part of the report's card: padding 12 16 and the rows' hairline under it. */
function Block({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        gap: 8,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      {children}
    </View>
  );
}

/** REPORTER, FILED…: the mono labels of the report's rows. */
function Label({ children }: { children: string }) {
  const theme = useTheme();
  return (
    <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
      {children}
    </Text>
  );
}

/** A labelled row, one TalkBack stop (“Reporter: Anna de Vries · anna@hollowmere.example”); its text can be copied. */
function Field({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${spokenLabel(label)}: ${value}`}
      style={{
        gap: 4,
        paddingVertical: 12,
        paddingHorizontal: 16,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <Label>{label}</Label>
      <Text size={15} lh={1.42} color={theme.colors.ink2} selectable>
        {value}
      </Text>
    </View>
  );
}

/** The reporter's screenshot full screen, as a picture in a message opens: Close in a 44dp header. */
function ScreenshotViewer({ uri, visible, onClose }: { uri: string; visible: boolean; onClose: () => void }) {
  const theme = useTheme();
  const { rawLocale } = useI18n();
  const copy = trackerReportText(rawLocale);
  return (
    <FullScreenModal visible={visible} onClose={onClose}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, minHeight: 56 }}
      >
        <Touchable
          onPress={onClose}
          accessibilityLabel={copy.close}
          feedback="wash"
          ringRadius={22}
          style={{
            width: 44,
            height: 44,
            borderRadius: 22,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={20} color={theme.colors.ink} strokeWidth={2} />
        </Touchable>
        <Text size={15} weight={600} numberOfLines={1} style={{ flex: 1 }} accessibilityRole="header">
          {copy.screenshotLabel}
        </Text>
      </View>
      <View style={{ flex: 1, padding: 12 }}>
        <Image
          source={{ uri }}
          resizeMode="contain"
          accessibilityLabel={copy.screenshotLabel}
          style={{ flex: 1, width: '100%' }}
        />
      </View>
    </FullScreenModal>
  );
}
