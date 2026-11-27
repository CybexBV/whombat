/**
 * What answers in Chat on the phone (Whombat chat-runtime.md CR-01…CR-06, CR-09; chat-runtime-android.md
 * AP-2715…AP-2724; the mockup's section 4): one icon in the pill, before the paperclip (chat-runtime-icon.md AP-2962), in
 * the Chat's top-level box and in a Chat thread's reply box, and the sheet it opens — “Neo answers with”, Claude · ChatGPT (greyed, with “Set it up”, when
 * one can't run) and Local where the burrow has a model on its network (hermes-engine-app.md AP-5123: its models,
 * “Another model” by name, no Effort or Fast replies), the usage line, the models, Effort, Fast replies, and “Make this
 * Neo’s default”. In a thread the switch shows the thread's provider alone: it keeps the one it started with
 * (thread-provider.md AP-5600). In the top-level
 * box the choice is for the next question only: it goes with the message (`messages.send` `runtime`) and the button goes back to the agent's own
 * after sending. In a thread a change is saved at once and applies from its next reply. Every rule and word is
 * `@whombat/client`'s (`chat/runtime.ts`, `react/chatRuntime.ts`), shared with the web.
 */

import {
  type ChatFastRow,
  type ChatModelRow,
  type ChatProviderSegment,
  type ChatThreadState,
  chatDefaultBody,
  chatDraftWithEffort,
  chatDraftWithFast,
  chatDraftWithModel,
  chatDraftWithProvider,
  chatEffortChoices,
  chatFastRow,
  chatMadeDefaultText,
  chatMakeDefaultShown,
  chatModelRows,
  chatModelsOf,
  chatProviderHints,
  chatProviderOf,
  chatProviderSegments,
  chatRuntimeButton,
  chatRuntimeInEffect,
  chatRuntimeLine,
  chatRuntimeRefusalText,
  chatRuntimeScope,
  chatRuntimeShown,
  chatStartRuntime,
  chatThreadChoice,
  chatThreadState,
  LOCAL_MODEL_TEXT,
  modelRuntimeSaved,
} from '@whombat/client';
import { useChatRuntime, useMakeChatDefault, useSetThreadRuntime } from '@whombat/client/react';
import {
  type AgentEffort,
  type ChatProvider,
  type ChatRoom,
  type ChatRuntime,
  type ChatRuntimeView,
  chatRuntimeCopy,
  type Message,
  modelEffortCopy,
} from '@whombat/core';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ScrollView, Switch, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { useTheAgentHere } from '../data/useAgent';
import { useI18n } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ChatRuntimeIcon, FastBolt, NoAiIcon, ProviderMark } from '../ui/chatRuntime';
import { FormField } from '../ui/formField';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';
import { hitSlopFor } from '../ui/touchTarget';
import { showNotice } from './feedback';

/** What a composer's “what answers” button holds (null where it doesn't show). */
export interface ChatRuntimeChoice {
  view: ChatRuntimeView;
  /** What answers now: the top-level box's own choice, else the thread's, else the agent's (`chatRuntimeInEffect`). */
  runtime: ChatRuntime;
  inThread: boolean;
  /** In a thread: its replies so far, for the mid-thread note under Fast replies. */
  thread: ChatThreadState | null;
  change: (next: ChatRuntime) => void;
  /** The top-level box's send: the choice for `messages.send` (absent: the agent's own), then back to it. */
  takeForSend: () => ChatRuntime | undefined;
  /** “Make this Neo’s default” went through: the top-level box follows the new default. */
  madeDefault: () => void;
  /** Why the last change didn't take (the thread's choice put back). */
  refusal: string | null;
}

/**
 * The button's state in a composer (CR-01, CR-02, AP-2715…AP-2719): in the Chat room only (`room` 'chat'), on a runtime
 * with `chat.runtime`, whatever the agent runs on. `threadRootId` is the thread's first message for its
 * reply box; `replies` its replies, oldest first.
 */
export function useChatRuntimeChoice({
  room,
  threadRootId,
  replies,
}: {
  room: ChatRoom | null;
  threadRootId: string | null;
  replies: readonly Pick<Message, 'ranOn'>[];
}): ChatRuntimeChoice | null {
  const { slug } = useBurrowBase();
  const enabled = true && room === 'chat';
  const query = useChatRuntime(slug, threadRootId, { enabled });
  const view = query.data ?? null;
  // The top-level box's own choice for the next question (CR-02); null: the agent's own.
  const [draft, setDraft] = useState<ChatRuntime | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const setThread = useSetThreadRuntime(slug, {
    onRefused: (text) => {
      setRefusal(text);
      showNotice(text);
    },
  });
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const viewRef = useRef(view);
  viewRef.current = view;
  const inThread = !!threadRootId;
  const shown = chatRuntimeShown({ room, view });
  const runtime = shown && view ? chatRuntimeInEffect(view, inThread ? null : draft) : null;
  const thread = useMemo(() => (inThread ? chatThreadState(replies) : null), [inThread, replies]);
  const change = useCallback(
    (next: ChatRuntime) => {
      const v = viewRef.current;
      if (!v) return;
      setRefusal(null);
      const stored = chatThreadChoice(next, v);
      if (threadRootId) setThread.mutate({ rootId: threadRootId, runtime: stored });
      else setDraft(stored);
    },
    [threadRootId, setThread],
  );
  const takeForSend = useCallback(() => {
    const sent = chatStartRuntime(draftRef.current, viewRef.current);
    setDraft(null);
    return sent;
  }, []);
  const madeDefault = useCallback(() => setDraft(null), []);
  if (!shown || !view || !runtime) return null;
  return { view, runtime, inThread, thread, change, takeForSend, madeDefault, refusal };
}

/** The icon in the pill and its sheet (AP-2715, AP-2716, chat-runtime-icon.md AP-2962). */
export function ChatRuntimeControl({ choice }: { choice: ChatRuntimeChoice }) {
  const { rawLocale } = useI18n();
  const chatRuntimeCopyHere = chatRuntimeCopy(rawLocale);

  const [open, setOpen] = useState(false);
  const navigation = useAppNavigation();
  const button = chatRuntimeButton(choice.view, choice.runtime);
  const scope = chatRuntimeScope(choice.inThread);
  // No AI signed in yet: the icon names none and goes where one is signed in, not to a sheet of models nobody chose.
  if (button.noAi)
    return (
      <NoAiIcon
        label={chatRuntimeCopyHere.noAiLabel(choice.view.assistantName)}
        line={chatRuntimeCopyHere.noAi}
        onPress={() => navigation.navigate('SettingsAgent', { part: 'ai' })}
      />
    );
  return (
    <>
      <ChatRuntimeIcon
        provider={button.provider}
        providerLabel={button.providerLabel}
        model={button.model}
        effort={button.effort}
        fast={button.fast}
        label={button.ariaLabel}
        line={chatRuntimeLine(button, scope)}
        scope={scope}
        onPress={() => setOpen(true)}
      />
      <ChatRuntimeSheet choice={choice} visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * The sheet (the mockup's right phone; AP-2716…AP-2724): on the raised surface, the title, the two-way switch, the
 * usage line and “ChatGPT isn’t set up on this Whombat. Set it up”, the models (48dp rows, ✓ and DEFAULT, “N more…”
 * past four), Effort's pills, Fast replies with its switch and words, and “Make this Neo’s default” across the width.
 * Every pick applies at once (the button shows it); the sheet stays open until closed.
 */
export function ChatRuntimeSheet({
  choice,
  visible,
  onClose,
}: {
  choice: ChatRuntimeChoice;
  visible: boolean;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();
  const chatRuntimeCopyHere = chatRuntimeCopy(rawLocale);
  const modelEffortCopyHere = modelEffortCopy(rawLocale);

  const theme = useTheme();
  const navigation = useAppNavigation();
  const { slug } = useBurrowBase();
  const agent = useTheAgentHere();
  const { view, runtime } = choice;
  const name = view.assistantName;
  const [moreOpen, setMoreOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const makeDefault = useMakeChatDefault(slug);
  const [defaultRefusal, setDefaultRefusal] = useState<string | null>(null);
  const models = chatModelsOf(view, runtime.provider);
  // A started thread keeps its provider (Whombat HN-06; AP-5600): its own segment only, its own words.
  const segments = chatProviderSegments(view, runtime, choice.inThread);
  const hints = chatProviderHints(view, choice.inThread ? runtime.provider : undefined);
  const rows = chatModelRows(models, runtime.model, moreOpen);
  const efforts = chatEffortChoices(models, runtime);
  const fast = chatFastRow(chatProviderOf(view, runtime.provider), runtime, choice.thread);
  const canMakeDefault = !!agent && chatMakeDefaultShown(view, runtime);
  const close = () => {
    setMoreOpen(false);
    setTyped('');
    setDefaultRefusal(null);
    onClose();
  };
  const pickProvider = (provider: ChatProvider) => {
    setMoreOpen(false);
    setTyped('');
    choice.change(chatDraftWithProvider(runtime, provider, view.default));
  };
  /** Local's “Another model” (AP-5001): a model its list doesn't name, by its name. */
  const applyTyped = () => {
    const name = typed.trim();
    if (!name) return;
    setTyped('');
    pickModel(name);
  };
  const pickModel = (id: string | null) =>
    choice.change(chatDraftWithModel(runtime, id, models, view.default));
  const pickEffort = (effort: AgentEffort | null) =>
    choice.change(chatDraftWithEffort(runtime, effort, models, view.default));
  const setFast = (on: boolean) => choice.change(chatDraftWithFast(runtime, on, models, view.default));
  const saveDefault = () => {
    setDefaultRefusal(null);
    const body = chatDefaultBody(runtime);
    makeDefault
      .make(runtime)
      .then((result) => {
        if (result.status !== 'ok') return setDefaultRefusal(chatRuntimeRefusalText(result));
        const saved = result.data.agent.runtime;
        if (!modelRuntimeSaved(body, saved, models)) return setDefaultRefusal(modelEffortCopyHere.notSaved);
        showNotice(chatMadeDefaultText(view, saved));
        choice.madeDefault();
        close();
      })
      .catch((error: unknown) => setDefaultRefusal(chatRuntimeRefusalText(error)));
  };
  const refusal = defaultRefusal ?? choice.refusal;
  const title = chatRuntimeCopyHere.answersWith(name);
  return (
    <Sheet
      visible={visible}
      onClose={close}
      label={`${title}, ${chatRuntimeScope(choice.inThread).toLowerCase()}`}
      surface="sf"
      maxHeight="90%"
    >
      <ScrollView contentContainerStyle={{ paddingBottom: 4 }}>
        <Text
          size={18}
          weight={700}
          accessibilityRole="header"
          style={{ paddingHorizontal: 18, paddingTop: 4, paddingBottom: 12 }}
        >
          {title}
        </Text>
        <View style={{ paddingHorizontal: 18, paddingBottom: 12, gap: 8 }}>
          <ProviderSwitch label={title} segments={segments} onPick={pickProvider} />
          {hints.usage ? <Hint text={hints.usage} /> : null}
          {hints.notSetUp.map((h) => (
            <View key={h.provider} style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' }}>
              <Hint text={`${h.text} `} />
              <Touchable
                onPress={() => {
                  close();
                  // The assistant's AI sign-in.
                  navigation.navigate('SettingsAgent', { part: 'ai' });
                }}
                feedback="fade"
                ringRadius={6}
                accessibilityRole="link"
                accessibilityLabel={`${chatRuntimeCopyHere.setUp}: ${h.text}`}
                hitSlop={hitSlopFor(20)}
                style={{ minHeight: 20, justifyContent: 'center' }}
              >
                <Text size={12.5} weight={600} color={theme.colors.brand}>
                  {chatRuntimeCopyHere.setUp}
                </Text>
              </Touchable>
            </View>
          ))}
        </View>
        <ModelRows
          label={`${name}’s model`}
          rows={rows.rows}
          more={rows.more}
          onPick={pickModel}
          onMore={() => setMoreOpen(true)}
        />
        {runtime.provider === 'local' ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12, gap: 10 }}>
            <FormField
              label={LOCAL_MODEL_TEXT.another}
              hint={LOCAL_MODEL_TEXT.anotherHint}
              value={typed}
              onChangeText={setTyped}
              mono
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={applyTyped}
            />
            <Button
              label={LOCAL_MODEL_TEXT.use}
              variant="secondary"
              disabled={!typed.trim()}
              accessibilityHint={`${name}’s model: ${typed.trim()}`}
              onPress={applyTyped}
            />
          </View>
        ) : null}
        {efforts.length ? (
          <View style={{ paddingHorizontal: 18, paddingTop: 12, paddingBottom: 12 }}>
            <Text
              size={10.5}
              weight={500}
              mono
              uppercase
              tracking={0.06}
              color={theme.colors.mut}
              style={{ marginBottom: 8 }}
            >
              {chatRuntimeCopyHere.effort}
            </Text>
            <View
              accessibilityRole="radiogroup"
              accessibilityLabel={chatRuntimeCopyHere.effort}
              style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 5 }}
            >
              {efforts.map((e) => (
                <EffortPill
                  key={e.value ?? 'automatic'}
                  label={e.label}
                  picked={e.picked}
                  onPress={() => pickEffort(e.value)}
                />
              ))}
            </View>
          </View>
        ) : null}
        <FastRow row={fast} onChange={setFast} />
        {refusal ? (
          <Text
            size={13}
            lh={1.45}
            color={theme.colors.bad}
            accessibilityRole="alert"
            accessibilityLiveRegion="assertive"
            style={{ paddingHorizontal: 18, paddingTop: 10 }}
          >
            {refusal}
          </Text>
        ) : null}
        {canMakeDefault ? (
          <Touchable
            onPress={saveDefault}
            disabled={makeDefault.isPending}
            feedback="wash"
            ringRadius={12}
            accessibilityRole="button"
            accessibilityLabel={chatRuntimeCopyHere.makeDefault(name)}
            accessibilityState={{ busy: makeDefault.isPending }}
            style={{
              height: 46,
              marginTop: 6,
              marginHorizontal: 18,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.line2,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: makeDefault.isPending ? 0.6 : 1,
            }}
          >
            <Text size={14.5} weight={600} color={theme.colors.ink2}>
              {chatRuntimeCopyHere.makeDefault(name)}
            </Text>
          </Touchable>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}

function Hint({ text }: { text: string }) {
  const theme = useTheme();
  return (
    <Text size={12.5} lh={1.45} color={theme.colors.mut}>
      {text}
    </Text>
  );
}

/**
 * Claude · ChatGPT (CR-01, CR-04; the mockup's `.sheet .seg`): a `bg` track with a hairline, 44dp halves with the mark
 * and the name, the picked one raised on `sf2`; one that can't run is greyed and can't be picked.
 */
function ProviderSwitch({
  label,
  segments,
  onPick,
}: {
  label: string;
  segments: readonly ChatProviderSegment[];
  onPick: (provider: ChatProvider) => void;
}) {
  const { rawLocale } = useI18n();
  const chatRuntimeCopyHere = chatRuntimeCopy(rawLocale);

  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        flexDirection: 'row',
        gap: 3,
        padding: 3,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.bg,
      }}
    >
      {segments.map((s) => (
        <Touchable
          key={s.provider}
          onPress={() => onPick(s.provider)}
          disabled={!s.ready && !s.picked}
          feedback={s.picked ? 'none' : 'wash'}
          ringRadius={7}
          accessibilityRole="radio"
          accessibilityLabel={s.label}
          accessibilityState={{ checked: s.picked, disabled: !s.ready && !s.picked }}
          {...(!s.ready ? { accessibilityHint: chatRuntimeCopyHere.notSetUp(s.label) } : {})}
          style={{
            flex: 1,
            height: 44,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 7,
            borderRadius: 7,
            ...(s.picked
              ? { backgroundColor: theme.colors.sf2, borderWidth: 1, borderColor: theme.colors.line2 }
              : null),
          }}
        >
          <View style={{ opacity: s.ready ? 1 : 0.45 }}>
            <ProviderMark provider={s.provider} size={15} muted={!s.picked} />
          </View>
          <Text
            size={15}
            weight={s.picked ? 600 : 500}
            color={s.picked ? theme.colors.ink : s.ready ? theme.colors.ink2 : theme.colors.mut}
            style={s.ready ? null : { opacity: 0.7 }}
          >
            {s.label}
          </Text>
        </Touchable>
      ))}
    </View>
  );
}

/**
 * The models (CR-05; the mockup's `.sheet .mrow`): between hairlines, 48dp rows — ✓ in `brand` on the picked one (raised
 * on `sel`), the name, the tool's own line, DEFAULT on the tool's default — and “N more…” past four, opening the rest.
 * The delegation checklist's AI menu draws its models, efforts and Fast with these too (`DelegationAiSheet.tsx`).
 */
export function ModelRows({
  label,
  rows,
  more,
  onPick,
  onMore,
}: {
  label: string;
  rows: readonly ChatModelRow[];
  more: number;
  onPick: (id: string | null) => void;
  onMore: () => void;
}) {
  const { rawLocale } = useI18n();
  const chatRuntimeCopyHere = chatRuntimeCopy(rawLocale);

  const theme = useTheme();
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        paddingVertical: 4,
        paddingHorizontal: 8,
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: theme.colors.line,
      }}
    >
      {rows.map((r) => (
        <Touchable
          key={r.id ?? 'default'}
          onPress={() => onPick(r.id)}
          feedback="wash"
          ringRadius={8}
          accessibilityRole="radio"
          accessibilityState={{ checked: r.picked }}
          accessibilityLabel={[r.label, r.description, r.isDefault ? 'default' : null]
            .filter(Boolean)
            .join(', ')}
          style={{
            minHeight: 48,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            paddingVertical: 6,
            paddingHorizontal: 10,
            borderRadius: 8,
            backgroundColor: r.picked ? theme.colors.sel : 'transparent',
          }}
        >
          <Text size={14} weight={600} color={theme.colors.brand} style={{ width: 16, textAlign: 'center' }}>
            {r.picked ? '✓' : ''}
          </Text>
          <Text size={14} weight={600} numberOfLines={1}>
            {r.label}
          </Text>
          <Text size={12.5} color={theme.colors.mut} numberOfLines={1} style={{ flex: 1 }}>
            {r.description ?? ''}
          </Text>
          {r.isDefault ? (
            <View
              style={{
                paddingVertical: 1,
                paddingHorizontal: 5,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: theme.colors.line2,
              }}
            >
              <Text size={10} weight={500} mono color={theme.colors.mut}>
                {chatRuntimeCopyHere.defaultTag}
              </Text>
            </View>
          ) : null}
        </Touchable>
      ))}
      {more > 0 ? (
        <Touchable
          onPress={onMore}
          feedback="wash"
          ringRadius={8}
          accessibilityRole="button"
          accessibilityLabel={chatRuntimeCopyHere.more(more)}
          style={{ minHeight: 44, justifyContent: 'center', paddingLeft: 36, borderRadius: 8 }}
        >
          <Text size={12.5} color={theme.colors.mut}>
            {chatRuntimeCopyHere.more(more)}
          </Text>
        </Touchable>
      ) : null}
    </View>
  );
}

/** An effort (the mockup's `.sheet .effs span`): a 36dp pill, the picked one filled with `btn`. */
export function EffortPill({
  label,
  picked,
  onPress,
}: {
  label: string;
  picked: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback={picked ? 'none' : 'wash'}
      ringRadius={18}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: picked }}
      hitSlop={hitSlopFor(36)}
      style={{
        height: 36,
        justifyContent: 'center',
        paddingHorizontal: 12,
        borderRadius: 18,
        borderWidth: 1,
        borderColor: picked ? 'transparent' : theme.colors.line2,
        backgroundColor: picked ? theme.colors.btn : 'transparent',
      }}
    >
      <Text size={13.5} weight={picked ? 600 : 500} color={picked ? theme.colors.btnfg : theme.colors.ink2}>
        {label}
      </Text>
    </Touchable>
  );
}

/**
 * Fast replies (CR-06; the mockup's `.sheet .fastrow`): the bolt, “Fast replies” and its words, and the switch — on in
 * `warn`, the mockup's fast colour. Greyed with the reason when the picked model has none or the provider goes through the
 * AI gateway; absent when no model of the provider has them.
 */
export function FastRow({ row, onChange }: { row: ChatFastRow; onChange: (on: boolean) => void }) {
  const theme = useTheme();
  if (row.kind === 'hidden') return null;
  const offered = row.kind === 'offered';
  const on = offered && row.on;
  const words = [row.text, offered ? row.note : null].filter((t): t is string => !!t);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 10,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 18,
        borderTopWidth: 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View style={{ paddingTop: 1, opacity: offered ? 1 : 0.45 }}>
        <FastBolt size={16} color={offered ? theme.colors.warn : theme.colors.mut} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text size={14} weight={600} color={offered ? theme.colors.ink : theme.colors.mut}>
          {row.title}
        </Text>
        {words.map((w) => (
          <Text key={w} size={12.5} lh={1.45} color={theme.colors.mut}>
            {w}
          </Text>
        ))}
      </View>
      <Switch
        value={on}
        disabled={!offered}
        onValueChange={onChange}
        accessibilityLabel={row.title}
        accessibilityHint={words.join(' ')}
        accessibilityRole="switch"
        trackColor={{ true: theme.colors.warn, false: theme.colors.line2 }}
        thumbColor={on ? theme.colors.btnfg : theme.colors.mut}
        style={{ minHeight: 44, marginTop: -10, opacity: offered ? 1 : 0.35 }}
      />
    </View>
  );
}
