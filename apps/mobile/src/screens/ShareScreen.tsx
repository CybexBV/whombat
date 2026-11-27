/**
 * Share to… (AP-715; not mocked): what another app shared through Android's share sheet. First the conversations —
 * the person's Chat and Feedback room and their branch rooms, newest first, with a search (AP-4984) — then a small
 * composer for the one picked: the shared text or link to edit, the shared files going up as the composer's chips (the
 * same upload path, limits and errors), and “Send to Chat”. Once sent, that conversation opens in place of this screen.
 * The share itself waits in `data/shareInbox` (never in the route's params) and is forgotten when this screen goes —
 * with the copies Android made of its files (MX-07).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { composerMentionTargets, composerText } from '@whombat/client';
import { useSendMessage } from '@whombat/client/react';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PrincipalAvatar } from '../avatars/Avatars';
import { canSend } from '../data/attachments';
import { useBurrow } from '../data/BurrowProvider';
import { clearShare, currentShare, shareNote, shareSummary, subscribeShare } from '../data/shareInbox';
import { matchesShareTarget, type ShareTarget, shareTargetRoute, shareTargets } from '../data/shareTargets';
import { useAgentWords, useTheAgentHere } from '../data/useAgent';
import { useComposerUploads } from '../data/useComposerUploads';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { UploadChips } from '../ui/attachments';
import { haptic } from '../ui/haptics';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Search } from '../ui/icons';
import { bottomPadding } from '../ui/insets';
import { KeyboardAvoidingView } from '../ui/keyboard';
import { ListRow } from '../ui/ListRow';
import { Button, QuietText, Section } from '../ui/primitives';
import { ConversationMark } from './ConversationScreen';
import { errorText, outcomeText } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'Share'>;

/** A conversation's face: the agent's for the person's own rooms, the branch mark for a branch room. */
function TargetMark({ target, size }: { target: ShareTarget; size: number }) {
  const agent = useTheAgentHere();
  if (target.kind === 'dm' && agent) return <PrincipalAvatar principal={agent} size={size} />;
  return <ConversationMark kind={target.kind} size={size} />;
}

export function ShareScreen({ navigation }: Props) {
  const { rawLocale, tClient } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { slug, mode, bootstrap } = useBurrow();
  const share = useSyncExternalStore(subscribeShare, currentShare);
  const shareId = share?.id ?? null;
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<ShareTarget | null>(null);
  const [text, setText] = useState(share?.text ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const words = useAgentWords();
  const targets = useMemo(
    () => shareTargets(bootstrap.sidebar, words.name, rawLocale),
    [bootstrap.sidebar, words.name, rawLocale],
  );
  const shown = targets.filter((t) => matchesShareTarget(t, q));
  const mentionTargets = useMemo(
    () => composerMentionTargets(bootstrap.principals, bootstrap.me.id),
    [bootstrap.principals, bootstrap.me.id],
  );
  const uploads = useComposerUploads(slug, target?.id ?? null);
  const send = useSendMessage({ burrow: slug, conversationId: target?.id ?? '', threadRootId: null });
  // The demo world (fixtures) has no uploads, as in a conversation's composer.
  const canAttach = mode !== 'fixtures';

  // A new share starts over from the list with its own text.
  useEffect(() => {
    if (shareId === null) return;
    setTarget(null);
    setProblem(null);
    setText(currentShare()?.text ?? '');
  }, [shareId]);

  // Its files go up once a conversation is picked (a conversation's uploads belong to it, so picking another starts
  // them again there).
  const added = useRef<string | null>(null);
  const addFiles = uploads.add;
  useEffect(() => {
    if (!target || !share) {
      added.current = null;
      return;
    }
    const key = `${share.id}:${target.id}`;
    if (added.current === key) return;
    added.current = key;
    if (canAttach && share.files.length) addFiles(share.files);
  }, [target, share, canAttach, addFiles]);

  // Leaving forgets the share; back from the composer goes back to the list instead.
  const leaving = useRef(false);
  useEffect(() => {
    return navigation.addListener('beforeRemove', (e) => {
      if (leaving.current || !target) return;
      e.preventDefault();
      setTarget(null);
      setProblem(null);
    });
  }, [navigation, target]);
  useEffect(() => () => (shareId === null ? undefined : clearShare(shareId)), [shareId]);

  const close = () => {
    leaving.current = true;
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.navigate('Tabs');
  };

  const sendable = !!target && !!share && canSend(text, uploads.items);
  const sendIt = () => {
    if (!target || !share || !sendable || send.isPending) return;
    setProblem(null);
    haptic('send');
    const attachmentIds = uploads.readyIds;
    send.mutate(
      {
        // Every mention canonical (MS-C02), as the conversation's own composer sends it.
        text: composerText(text.trim(), mentionTargets),
        ...(attachmentIds.length ? { attachmentIds } : {}),
      },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') {
            setProblem(outcomeText(result, rawLocale)?.body ?? null);
            return;
          }
          // The share is forgotten as this screen goes (not before: it would show “Nothing to share” on its way out).
          leaving.current = true;
          const route = shareTargetRoute(target);
          (navigation.replace as (name: string, params: unknown) => void)(route.name, route.params);
        },
        onError: (error) => setProblem(errorText(error, rawLocale)),
      },
    );
  };

  if (!share)
    return (
      <Screen>
        <BackBar label={tMobile('managed.back')} onPress={close} />
        <LargeTitle title={tMobile('screens.share-to')} />
        <QuietText>{tMobile('screens.nothing-to-share-share-from-another-app-to')}</QuietText>
      </Screen>
    );

  const note = shareNote(share, rawLocale);
  const demoFiles = !canAttach && share.files.length > 0 ? tMobile('screens2.share.demoFiles') : null;

  if (!target)
    return (
      <Screen>
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
          <LargeTitle
            title={tMobile('screens.share-to')}
            right={
              <Button
                label={tClient('reports.cancel')}
                variant="quiet"
                onPress={close}
                style={{ minWidth: 72 }}
              />
            }
          />
          <Text size={12} mono color={theme.colors.mut} style={{ paddingHorizontal: 22 }}>
            {shareSummary(share, rawLocale)}
          </Text>
          <View style={{ paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 }}>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                paddingHorizontal: 12,
                minHeight: 44,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: theme.colors.line2,
                backgroundColor: theme.colors.sf,
              }}
            >
              <Search size={16} color={theme.colors.mut} strokeWidth={1.75} />
              <TextInput
                value={q}
                onChangeText={setQ}
                placeholder={tMobile('screens.find-a-conversation')}
                placeholderTextColor={theme.colors.mut}
                accessibilityLabel={tMobile('screens.find-a-conversation')}
                autoCorrect={false}
                cursorColor={theme.colors.ink}
                selectionColor={theme.colors.brand}
                style={{
                  flex: 1,
                  minHeight: 44,
                  color: theme.colors.ink,
                  ...textMetrics({ size: 15 }),
                  includeFontPadding: false,
                }}
              />
            </View>
          </View>
          <Section title={tMobile('screens.conversations')}>
            {shown.length === 0 ? (
              <QuietText>
                {targets.length
                  ? tMobile('screens.nothing-matches-that')
                  : tMobile('screens.youre-not-in-any-conversations-yet')}
              </QuietText>
            ) : (
              shown.map((t) => (
                <ListRow
                  key={t.id}
                  leading={<TargetMark target={t} size={44} />}
                  title={t.title}
                  meta={t.meta}
                  accessibilityLabel={tMobile('screens2.share.shareTo', { title: t.title, meta: t.meta })}
                  onPress={() => {
                    setProblem(null);
                    setTarget(t);
                  }}
                />
              ))
            )}
          </Section>
        </ScrollView>
      </Screen>
    );

  return (
    <Screen>
      <KeyboardAvoidingView style={{ flex: 1 }}>
        <BackBar label={tMobile('screens.conversations-2')} onPress={() => setTarget(null)} />
        <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 12 }}>
          <LargeTitle title={tMobile('screens.share-to')} />
          <Section title={tMobile('screens.to')}>
            <ListRow
              leading={<TargetMark target={target} size={44} />}
              title={target.title}
              meta={target.meta}
            />
          </Section>
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder={tMobile('screens2.share.message', { title: target.title })}
              placeholderTextColor={theme.colors.mut}
              accessibilityLabel={tMobile('screens2.share.message', { title: target.title })}
              multiline
              selectionColor={theme.colors.brand}
              cursorColor={theme.colors.ink}
              style={{
                minHeight: 120,
                maxHeight: 260,
                paddingVertical: 12,
                paddingHorizontal: 14,
                borderRadius: 16,
                borderWidth: 1,
                borderColor: theme.colors.line2,
                backgroundColor: theme.colors.sf,
                color: theme.colors.ink,
                ...textMetrics({ size: 15.5 }),
                includeFontPadding: false,
                textAlignVertical: 'top',
              }}
            />
            <UploadChips
              items={uploads.items}
              onRemove={uploads.remove}
              onRetry={uploads.retry}
              canRetry={uploads.canRetry}
            />
            {note || demoFiles ? (
              <Text size={13} lh={1.45} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
                {[note, demoFiles].filter(Boolean).join(' ')}
              </Text>
            ) : null}
            {problem ? (
              <Text
                size={13.5}
                lh={1.45}
                color={theme.colors.bad}
                accessibilityLiveRegion="assertive"
                style={{ paddingHorizontal: 6 }}
              >
                {problem}
              </Text>
            ) : null}
          </View>
        </ScrollView>
        <View
          style={{
            paddingTop: 10,
            paddingHorizontal: 16,
            paddingBottom: bottomPadding(36, insets.bottom, 12),
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
            backgroundColor: theme.colors.bg,
          }}
        >
          <Button
            label={tMobile('screens2.share.sendTo', { title: target.title })}
            size="lg"
            busy={send.isPending}
            disabled={!sendable}
            onPress={sendIt}
            {...(uploads.items.some((i) => i.state === 'uploading')
              ? { accessibilityHint: tMobile('screens2.share.waitsUpload') }
              : {})}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
