/**
 * Start a thread with the assistant (one-whombat-mobile.md AP-1358; its name, assistant-name-mobile.md AP-1534): about a
 * server (“Ask about pve-02”, the thread's subject). The new thread in Chat opens at once (chat-channel.md AP-2455).
 * A connection's page opens it with a question ready to send (“Look into it”, a “Show more here” chip;
 * connection-pages-mobile.md AP-1960).
 *
 * With Chat (Whombat chat-channel.md CHT-06; chat-channel.md AP-2455) there is no New chat: the sheet is only “Ask about
 * pve-02” on a page, its button Ask, and what it sends starts a thread in Chat about the subject, which opens. The
 * Automations list opens it as “Tell Dusty” (automation-chat-mobile.md), its own words for the title and the field.
 *
 * The mic under the field is voice typing (docs/decisions/dictation.md DT-01): while it records the bar is there and
 * Ask waits; the words go into the field at the cursor.
 */
import { useStartChat } from '@whombat/client/react';
import type { ChatSubject } from '@whombat/core';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { CHAT_COPY, startedChatRoute } from '../data/chatRoom';
import { askAboutLine, CHATS_COPY } from '../data/chats';
import { useAgentWords } from '../data/useAgent';
import { navigateTo, useAppNavigation } from '../navigation/hooks';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BigButton } from '../ui/assistant';
import { FormField } from '../ui/formField';
import { OneSheet } from '../ui/oneSheet';
import { useComposerVoice, useVoiceSource } from '../voice/useComposerVoice';
import { MicButton, VoiceBar } from '../voice/VoiceBar';
import { useDecisionFeedback } from './feedback';

export function NewChatSheet({
  visible,
  onClose,
  subject = null,
  back,
  initialText = null,
  words = null,
}: {
  visible: boolean;
  onClose: () => void;
  subject?: ChatSubject | null;
  /** The “‹ …” of the chat that opens. */
  back: string;
  /** A question ready to send when it opens; without one, what was typed before stays. */
  initialText?: string | null;
  /** The sheet's title and the field's label and placeholder, instead of “Ask about …” / “Ask Dusty”. */
  words?: { title: string; label: string; placeholder: string } | null;
}) {
  const { slug } = useBurrowBase();
  const navigation = useAppNavigation();
  const start = useStartChat(slug);
  const feedback = useDecisionFeedback();
  const assistant = useAgentWords();
  const theme = useTheme();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const selection = useRef({ start: 0, end: 0 });
  const voiceSource = useVoiceSource();
  const voice = useComposerVoice(visible ? voiceSource : null, {
    ownerKey: `ask:${subject?.kind ?? ''}:${subject?.name ?? ''}`,
    text,
    selection: () => selection.current,
    commit: (next, at) => {
      selection.current = at;
      setText(next);
    },
  });
  useEffect(() => {
    if (visible && initialText) setText(initialText);
  }, [visible, initialText]);
  const send = () => {
    const ask = text.trim();
    if (!ask || busy || voice.active) return;
    setBusy(true);
    start
      .mutateAsync({ text: ask, subject })
      .then((result) => {
        if (result.status !== 'ok') return feedback.onResult(result);
        setText('');
        onClose();
        navigateTo(navigation, startedChatRoute(result.data, back));
      }, feedback.onError)
      .finally(() => setBusy(false));
  };
  const title = words?.title ?? (subject ? `Ask about ${subject.name}` : CHATS_COPY.newChat);
  return (
    <OneSheet
      visible={visible}
      onClose={busy ? () => {} : onClose}
      title={title}
      body={subject ? askAboutLine(subject, assistant) : null}
      buttons={[]}
    >
      <View style={{ marginTop: 14, gap: 14 }}>
        <FormField
          label={words?.label ?? CHATS_COPY.newChatField(assistant)}
          kicker
          value={text}
          onChangeText={setText}
          placeholder={words?.placeholder ?? CHATS_COPY.newChatPlaceholder(assistant)}
          multiline
          autoFocus
          editable={!voice.active}
          onSelectionChange={(e) => {
            selection.current = e.nativeEvent.selection;
          }}
        />
        {voice.active ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              minHeight: 46,
              paddingHorizontal: 7,
              borderRadius: 23,
              borderWidth: 1,
              borderColor: theme.colors.line2,
              backgroundColor: theme.colors.sf,
            }}
          >
            <VoiceBar voice={voice} />
          </View>
        ) : voice.mic !== 'hidden' ? (
          <View style={{ flexDirection: 'row', justifyContent: 'flex-end', marginTop: -6 }}>
            <MicButton voice={voice} />
          </View>
        ) : null}
        {voice.error ? (
          <Text size={13} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
            {voice.error}
          </Text>
        ) : null}
        <BigButton
          label={CHAT_COPY.askButton}
          variant="primary"
          onPress={send}
          busy={busy}
          disabled={!text.trim() || voice.active}
        />
      </View>
    </OneSheet>
  );
}
