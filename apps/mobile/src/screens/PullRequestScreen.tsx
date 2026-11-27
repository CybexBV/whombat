/**
 * A pull request (AP-712; not mocked on mobile, the branch room's pane and Files changed in the run screen's language):
 * its title, state and branch, CHECKS, REVIEWERS and FILES CHANGED — each file opens the file view — then Merge into
 * main where the server allows it (`mergeBlock`: people only, checks and review; an agent's Merge key on a Whombat with
 * `keys.merge_deploy`), asking first, and Branch room. Live through `pr.updated` on the room's topic; pull to refresh.
 * Opened from a run (its PR number), a run card and the branch room.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useQueryClient } from '@tanstack/react-query';
import { mergeErrorText, mergeOutcomeText } from '@whombat/client';
import { queryKeys } from '@whombat/client/query';
import { useApiMutation, usePullRequest, useSubscription } from '@whombat/client/react';
import { api, mergeToast, topics } from '@whombat/core';
import { useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PrincipalAvatar } from '../avatars/Avatars';
import { useBurrow } from '../data/BurrowProvider';
import { mergeConfirm, pullRequestModel } from '../data/pullRequest';
import { useAgentWords } from '../data/useAgent';
import { useI18n, useMobileT } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { branchRoomFor, type RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { bottomPadding } from '../ui/insets';
import { ListRow } from '../ui/ListRow';
import { Button, ErrorState, QuietText, Section, SkeletonRows, toneColor } from '../ui/primitives';
import { StatusPill } from '../ui/StatusPill';
import { showNotice } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'PullRequest'>;

function CheckMark({ passed }: { passed: boolean }) {
  const theme = useTheme();
  return (
    <View
      style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        borderWidth: 2,
        borderColor: passed ? theme.colors.ok : theme.colors.warn,
        backgroundColor: passed ? theme.colors.ok : 'transparent',
      }}
    />
  );
}

export function PullRequestScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const { slug, bootstrap, people } = useBurrow();
  const { number, back: backParam } = route.params;
  const back = backParam ?? tMobile('screens2.common.back');
  // A number alone: the sidebar's one room with it says which repository (AP-514).
  const repo = route.params.repo ?? branchRoomFor(bootstrap.sidebar.branchRooms, number, undefined)?.repo;
  const repoQuery = repo ? { repo } : {};
  const query = usePullRequest({ params: { burrow: slug, number }, query: repoQuery });
  const detail = query.data;
  useSubscription(detail ? topics.conversation(detail.pr.conversationId) : null);
  const merge = useApiMutation(api.prs.merge);
  const agent = useAgentWords();
  const [mergeError, setMergeError] = useState<string | null>(null);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));

  if (!detail) {
    const notFound = query.error && 'status' in query.error && query.error.status === 404;
    return (
      <Screen>
        <BackBar label={back} onPress={goBack} />
        {notFound ? (
          <ErrorState text={tMobile('screens.theres-no-pull-request-with-this-number-here')} />
        ) : query.error ? (
          <ErrorState
            text={tMobile('screens.this-pull-request-didnt-load')}
            onRetry={() => void query.refetch()}
          />
        ) : (
          <SkeletonRows count={6} lines={1} label={tMobile('screens.loading-the-pull-request')} />
        )}
      </Screen>
    );
  }

  const model = pullRequestModel(detail, {
    lookup: (id) => people.get(id),
    agentsMayMerge: true,
    agent: agent.name,
    locale: rawLocale,
  });
  const params = { burrow: slug, number };

  const doMerge = () => {
    setMergeError(null);
    merge.mutate(
      { params, query: repoQuery, body: {} },
      {
        onSuccess: (result) => {
          const refused = mergeOutcomeText(result, rawLocale);
          if (refused) return setMergeError(refused);
          if (result.status === 'ok')
            qc.setQueryData(queryKeys.prs.get({ params, query: repoQuery }), result.data);
          void qc.invalidateQueries({ queryKey: queryKeys.scope('conversations.bootstrap') });
          showNotice(mergeToast(number, rawLocale));
        },
        onError: (error) => {
          setMergeError(mergeErrorText(error, rawLocale));
          void query.refetch();
        },
      },
    );
  };
  const askMerge = () => {
    const ask = mergeConfirm(detail, rawLocale);
    Alert.alert(ask.title, ask.body, [
      { text: tMobile('screens2.common.cancel'), style: 'cancel' },
      { text: tMobile('screens2.common.merge'), onPress: doMerge },
    ]);
  };

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ gap: 18, paddingTop: 4, paddingBottom: 20 }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ gap: 8, paddingHorizontal: 22 }}>
          <Text size={11.5} mono color={theme.colors.mut}>
            {model.label}
          </Text>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {model.title}
          </Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <StatusPill text={model.status.text.toUpperCase()} tone={model.status.tone} />
            <Text size={12} mono color={theme.colors.mut} numberOfLines={1} style={{ flexShrink: 1 }}>
              {model.branch}
            </Text>
          </View>
        </View>

        <View>
          <Section title={tMobile('screens.checks')}>
            {model.checks.length === 0 ? (
              <QuietText>{tMobile('screens.no-checks-on-this-branch')}</QuietText>
            ) : (
              model.checks.map((c) => (
                <View
                  key={c.name}
                  accessible
                  accessibilityLabel={c.accessibilityLabel}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 12,
                    minHeight: 48,
                    paddingHorizontal: 16,
                    borderBottomWidth: 1,
                    borderBottomColor: theme.colors.line,
                  }}
                >
                  <CheckMark passed={c.passed} />
                  <Text size={15} style={{ flex: 1 }} numberOfLines={1}>
                    {c.name}
                  </Text>
                  <Text size={11.5} mono color={theme.colors.mut}>
                    {c.note}
                  </Text>
                </View>
              ))
            )}
          </Section>
          <Section title={tMobile('screens.reviewers')}>
            {model.reviewers.length === 0 ? (
              <QuietText>{tMobile('screens.no-reviewers-yet')}</QuietText>
            ) : (
              model.reviewers.map((r) => (
                <ListRow
                  key={r.id}
                  leading={<PrincipalAvatar principal={people.get(r.id)} size={32} />}
                  title={r.name}
                  trailing={
                    <Text size={12.5} weight={500} color={toneColor(theme, r.tone)}>
                      {r.state}
                    </Text>
                  }
                  accessibilityLabel={`${r.name}, ${r.state}`}
                />
              ))
            )}
          </Section>
          <Section title={tMobile('screens2.pr.filesChanged', { diff: model.diff }).toUpperCase()}>
            {model.files.length === 0 ? (
              <QuietText>{tMobile('screens.no-files-changed')}</QuietText>
            ) : (
              model.files.map((f) => (
                <ListRow
                  key={f.path}
                  title={f.path}
                  titleMono
                  trailing={
                    <Text size={12} weight={500} mono>
                      <Text size={12} weight={500} mono color={theme.colors.ok}>
                        {f.add}
                      </Text>{' '}
                      <Text size={12} weight={500} mono color={theme.colors.bad}>
                        {f.del}
                      </Text>
                      {'  ›'}
                    </Text>
                  }
                  onPress={() =>
                    navigation.navigate('PullRequestFile', {
                      number,
                      path: f.path,
                      ...(repo ? { repo } : {}),
                    })
                  }
                  accessibilityLabel={f.accessibilityLabel}
                />
              ))
            )}
          </Section>
        </View>
      </ScrollView>
      <View
        style={{
          gap: 10,
          paddingTop: 14,
          paddingHorizontal: 22,
          paddingBottom: bottomPadding(36, insets.bottom, 14),
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
          backgroundColor: theme.colors.bg,
        }}
      >
        {mergeError ? (
          <Text size={13.5} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
            {mergeError}
          </Text>
        ) : null}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button
            label={tMobile('screens.branch-room')}
            variant="secondary"
            size="lg"
            onPress={() => navigation.navigate('Conversation', { conversationId: detail.pr.conversationId })}
            style={{ flex: 1 }}
          />
          <Button
            label={model.merge.label}
            size="lg"
            variant={model.merge.look === 'ready' ? 'primary' : 'secondary'}
            disabled={!model.merge.canMerge}
            busy={merge.isPending}
            onPress={askMerge}
            accessibilityHint={model.merge.hint ?? undefined}
            style={{ flex: 1.4 }}
          />
        </View>
        <Text size={12.5} lh={1.4} color={theme.colors.mut}>
          {model.merge.hint ? `${model.merge.hint} ${model.mergeNote}` : model.mergeNote}
        </Text>
      </View>
    </Screen>
  );
}

/**
 * Under a branch room's header (AP-712): one row that opens the room's pull request — checks, files changed and Merge
 * into main, which the phone's room didn't have.
 */
export function PullRequestBar({ number, repo, back }: { number: number; repo?: string; back: string }) {
  const { t: tMobile } = useMobileT();
  const navigation = useAppNavigation();
  return (
    <ListRow
      title={tMobile('screens.pull-request')}
      meta={`#${number} · checks · files changed · merge`}
      trailing="›"
      onPress={() => navigation.navigate('PullRequest', { number, back, ...(repo ? { repo } : {}) })}
      accessibilityLabel={tMobile('screens2.pr.rowLabel', { number })}
    />
  );
}
