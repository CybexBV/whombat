/**
 * A pull request's branch room (not mocked on mobile): the chat header and bubbles, with author lines on other
 * people's messages and compact cards. Opened by id, or by PR number and repository (essentials item 5): the sidebar's
 * room, else the server's (`prs.get`), and when several rooms have that number and the link names no repository, a
 * short list to pick from (AP-514). The person's own rooms with the agent (Chat, Feedback, a task chat) open their own
 * screens; there are no channels or conversations between people (Whombat one-agent.md OA-04; app one-agent.md
 * AP-4981). The header's “More” opens the notification level, the pinned messages, plans, Files and what the agent
 * remembers there.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useConversation, usePullRequest } from '@whombat/client/react';
import { type ConversationDetail, composerPlaceholder, prStatus, prStatusLabels } from '@whombat/core';
import { useEffect } from 'react';
import { ScrollView, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { branchRoomMeta } from '../data/lists';
import { conversationLoadError } from '../data/messages';
import { useI18n, useMobileT } from '../i18n';
import { branchRoomFor, type RootStackParamList } from '../navigation/routes';
import { useTheme } from '../theme/theme';
import { ChatHeader, Screen } from '../ui/headers';
import { GitBranch, MessageCircle } from '../ui/icons';
import { ListRow } from '../ui/ListRow';
import { ErrorState, QuietText, Section, SkeletonRows, StatusDot, toneColor } from '../ui/primitives';
import { ChatView } from './ChatView';
import { ConversationMenu } from './ConversationMenu';
import { PullRequestBar } from './PullRequestScreen';

type Props = NativeStackScreenProps<RootStackParamList, 'Conversation'>;

/** 36dp tile with the branch icon (a branch room) or a speech bubble (the person's Chat or Feedback room, a task chat). */
export function ConversationMark({ kind, size = 36 }: { kind: 'branch' | 'dm'; size?: number }) {
  const theme = useTheme();
  const Icon = kind === 'branch' ? GitBranch : MessageCircle;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.3,
        backgroundColor: theme.colors.sf2,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon size={Math.round(size * 0.46)} color={theme.colors.ink2} strokeWidth={1.75} />
    </View>
  );
}

/** Which conversation the route names: its id when known now, else what still has to be asked. */
function useTarget(params: Props['route']['params']) {
  const { slug, bootstrap } = useBurrow();
  const byPr = 'prNumber' in params ? params : null;
  const rooms = bootstrap.sidebar.branchRooms;
  const room = byPr ? branchRoomFor(rooms, byPr.prNumber, byPr.repo) : null;
  const choices = byPr && !room && !byPr.repo ? rooms.filter((r) => r.prNumber === byPr.prNumber) : [];
  // Not in the sidebar (and not ambiguous there): the server knows the room of `number` in `repo`.
  const askServer = !!byPr && !room && choices.length < 2;
  const pr = usePullRequest(
    askServer && byPr
      ? { params: { burrow: slug, number: byPr.prNumber }, query: byPr.repo ? { repo: byPr.repo } : {} }
      : null,
  );
  const id =
    'conversationId' in params ? params.conversationId : (room?.id ?? pr.data?.pr.conversationId ?? null);
  return { id, choices: choices.length > 1 ? choices : [], prQuery: askServer ? pr : null, byPr };
}

export function ConversationScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const prStatusLabelsHere = prStatusLabels(rawLocale);
  const { t: tMobile } = useMobileT();
  const { slug } = useBurrow();
  const theme = useTheme();
  const params = route.params;
  const target = useTarget(params);
  const query = useConversation(target.id ? { params: { burrow: slug, conversationId: target.id } } : null);
  const detail = query.data;
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  // The person's own room (or a task chat) by its id: its own screen, which knows Chat from Feedback (AP-4981).
  const own = detail?.conversation.kind === 'dm' ? detail.conversation.id : null;
  useEffect(() => {
    if (own) navigation.replace('Chat', { conversationId: own });
  }, [own, navigation]);

  if (target.choices.length > 0 && target.byPr) {
    // Several repositories have a PR with this number and the link didn't say which (AP-514): ask, never pick.
    const repos = new Set(target.choices.map((r) => r.repo).filter((r): r is string => !!r));
    return (
      <Screen>
        <ChatHeader
          onBack={goBack}
          backLabel={tMobile('screens2.common.back')}
          title={`PR #${target.byPr.prNumber}`}
        />
        <ScrollView contentContainerStyle={{ paddingTop: 12 }}>
          <QuietText style={{ paddingTop: 8, paddingBottom: 18 }}>
            {tMobile('screens2.conversation.whichRepo', { number: target.byPr.prNumber })}
          </QuietText>
          <Section title={tMobile('screens.branch-rooms')}>
            {target.choices.map((r) => (
              <ListRow
                key={r.id}
                leading={<ConversationMark kind="branch" size={44} />}
                title={r.branch}
                titleMono
                meta={r.repo ?? branchRoomMeta(r, repos)}
                trailing={
                  <StatusDot color={toneColor(theme, r.dot)} label={prStatusLabelsHere[r.prStatus]} />
                }
                accessibilityLabel={`${r.branch}, ${r.repo ?? ''} PR ${r.prNumber}, ${prStatusLabelsHere[r.prStatus]}`}
                onPress={() =>
                  navigation.replace('Conversation', {
                    conversationId: r.id,
                    ...(params.anchor ? { anchor: params.anchor } : {}),
                  })
                }
              />
            ))}
          </Section>
        </ScrollView>
      </Screen>
    );
  }

  if (!detail || own) {
    const error = query.error ?? target.prQuery?.error ?? null;
    const failure = error ? conversationLoadError(error, rawLocale) : null;
    const title = target.byPr ? `PR #${target.byPr.prNumber}` : '';
    return (
      <Screen>
        <ChatHeader onBack={goBack} backLabel={tMobile('screens2.common.back')} title={title} />
        {failure ? (
          <ErrorState
            text={failure.text}
            {...(failure.retry
              ? {
                  onRetry: () => {
                    void query.refetch();
                    void target.prQuery?.refetch();
                  },
                }
              : {})}
          />
        ) : (
          <SkeletonRows
            count={6}
            avatarSize={32}
            lines={1}
            label={tMobile('screens.loading-the-conversation')}
          />
        )}
      </Screen>
    );
  }

  return (
    <Conversation detail={detail} goBack={goBack} navigation={navigation} anchor={params.anchor ?? null} />
  );
}

function Conversation({
  detail,
  goBack,
  navigation,
  anchor,
}: {
  detail: ConversationDetail;
  goBack: () => void;
  navigation: Props['navigation'];
  /** The message a link opens it at (MX-03). */
  anchor: string | null;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale } = useI18n();
  const prStatusLabelsHere = prStatusLabels(rawLocale);

  const c = detail.conversation;
  const title = c.title;
  const subtitle = detail.pr
    ? `${detail.pr.repoFullName ? `${detail.pr.repoFullName} · ` : ''}PR #${detail.pr.number} · ${prStatusLabelsHere[prStatus(detail.pr)]}`
    : c.topic || null;
  const placeholder = c.prNumber
    ? composerPlaceholder({ kind: 'branch', prNumber: c.prNumber }, rawLocale)
    : tMobile('screens2.conversation.placeholder');

  return (
    <Screen>
      <ChatHeader
        onBack={goBack}
        backLabel={tMobile('screens2.common.back')}
        avatar={<ConversationMark kind="branch" />}
        title={title}
        {...(subtitle ? { subtitle } : {})}
        right={
          <ConversationMenu
            label={tMobile('screens2.conversation.optionsFor', { title })}
            conversation={{ id: c.id, kind: c.kind, notify: detail.notify ?? detail.summary.notify ?? null }}
            onPins={() => navigation.navigate('Pins', { conversationId: c.id, title })}
            onPlans={() => navigation.navigate('Plans', { conversationId: c.id, back: title })}
            onFiles={() => navigation.navigate('ConversationFiles', { conversationId: c.id })}
          />
        }
      />
      {/* A branch room opens its pull request (stream C, AP-712). */}
      {detail.pr ? (
        <PullRequestBar
          number={detail.pr.number}
          back={title}
          {...(detail.pr.repoFullName ? { repo: detail.pr.repoFullName } : {})}
        />
      ) : null}
      <ChatView
        conversationId={c.id}
        authors
        placeholder={placeholder}
        emptyText={tMobile('screens2.conversation.empty')}
        backLabel={title}
        anchor={anchor}
        onAnchorDone={() => navigation.setParams({ anchor: undefined })}
      />
    </Screen>
  );
}
