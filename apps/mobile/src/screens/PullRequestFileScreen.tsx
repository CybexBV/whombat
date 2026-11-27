/**
 * A pull request's file (AP-712; the web's file view, AP-664, CT-241): the file whole, view only, on the code surface —
 * old and new line numbers, removed lines in red and added lines in green in place, the same `+`/`−` marks. The bar
 * says the path, `+12 −3` and how many changes; “Previous file” and “Next file” step through Files changed. Long lines
 * scroll sideways with the block. Opens at the first change when it is below the first screen. Unchanged lines are
 * coloured by the file's language with the web's syntax colours (`tokenizeFileLines`, MX-06); changed lines stay plain
 * green or red, as on the web (AP-664). `whombat://pr/482/file?path=…&repo=…` opens it from a link (MX-06).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ApiError,
  type CodeToken,
  type CodeTokenKind,
  changeStarts,
  gutterDigits,
  neighbours,
  tokenizeFileLines,
} from '@whombat/client';
import { usePullRequest, usePullRequestFile } from '@whombat/client/react';
import { formatAdditions, formatDeletions, PR_FILE_SHOWN_TEXT, type PrFileLine } from '@whombat/core';
import type { NativeTheme } from '@whombat/tokens';
import { memo, type ReactNode, useMemo, useRef } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBurrowBase } from '../data/BurrowProvider';
import { LINE_KIND_LABELS, LINE_MARKS } from '../data/pullRequest';
import { useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { bottomPadding } from '../ui/insets';
import { Button, ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { scrollToRow } from './scrollToRow';

type Props = NativeStackScreenProps<RootStackParamList, 'PullRequestFile'>;

/** One line's height at the default text size (12.5 mono at 1.6); larger system text grows it. */
const LINE_HEIGHT = 20;

/** A token kind's colour on the code surface (`codeColors.syntax*`, the web's message code blocks and file view). */
const SYNTAX: Record<CodeTokenKind, keyof NativeTheme['code']> = {
  keyword: 'syntaxKeyword',
  string: 'syntaxString',
  number: 'syntaxNumber',
  comment: 'syntaxComment',
  title: 'syntaxTitle',
  type: 'syntaxType',
  attr: 'syntaxAttr',
  tag: 'syntaxTag',
  meta: 'syntaxMeta',
};

const FileLine = memo(function FileLine({
  line,
  digits,
  tokens,
}: {
  line: PrFileLine;
  digits: number;
  /** The unchanged line's syntax colours; null for changed lines and files in a language without them. */
  tokens: readonly CodeToken[] | null;
}) {
  const theme = useTheme();
  const color =
    line.kind === 'add' ? theme.code.added : line.kind === 'del' ? theme.code.removed : theme.code.text;
  const label = LINE_KIND_LABELS[line.kind];
  const width = digits * 8 + 8;
  return (
    <View
      accessible
      accessibilityLabel={`${label ? `${label}: ` : ''}${line.text || 'empty line'}`}
      style={{
        flexDirection: 'row',
        minHeight: LINE_HEIGHT,
        backgroundColor:
          line.kind === 'add'
            ? theme.code.addedBg
            : line.kind === 'del'
              ? theme.code.removedBg
              : 'transparent',
      }}
    >
      <Text
        size={12}
        lh={1.6}
        mono
        color={line.kind === 'context' ? theme.code.timestamp : color}
        style={{ width, textAlign: 'right' }}
      >
        {line.old ?? ''}
      </Text>
      <Text
        size={12}
        lh={1.6}
        mono
        color={line.kind === 'context' ? theme.code.timestamp : color}
        style={{ width, textAlign: 'right' }}
      >
        {line.new ?? ''}
      </Text>
      <Text size={12.5} lh={1.6} mono color={color} style={{ width: 22, textAlign: 'center' }}>
        {LINE_MARKS[line.kind]}
      </Text>
      <Text size={12.5} lh={1.6} mono color={color} numberOfLines={1} style={{ paddingRight: 16 }}>
        {tokens && line.kind === 'context'
          ? tokens.map((t, i) =>
              t.kind ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: a line's tokens are positional and never reorder
                <Text key={i} size={12.5} lh={1.6} mono color={theme.code[SYNTAX[t.kind]]}>
                  {t.text}
                </Text>
              ) : (
                t.text
              ),
            )
          : line.text}
      </Text>
    </View>
  );
});

export function PullRequestFileScreen({ route, navigation }: Props) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { slug } = useBurrowBase();
  const { number, repo, path } = route.params;
  const repoQuery = repo ? { repo } : {};
  const pr = usePullRequest({ params: { burrow: slug, number }, query: repoQuery });
  const query = usePullRequestFile({
    params: { burrow: slug, number },
    query: { ...repoQuery, path },
  });
  const list = useRef<FlatList<PrFileLine>>(null);
  const view = query.data;
  const lines = view?.shown === 'text' ? view.lines : [];
  const starts = useMemo(() => changeStarts(lines), [lines]);
  const tokens = useMemo(() => tokenizeFileLines(lines, path), [lines, path]);
  const digits = gutterDigits(lines);
  const files = pr.data?.pr.files ?? [];
  const counts = files.find((f) => f.path === path);
  const { previous, next } = neighbours(files, path);
  const add = view?.add ?? counts?.add;
  const del = view?.del ?? counts?.del;
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const open = (p: string) =>
    navigation.replace('PullRequestFile', { number, path: p, ...(repo ? { repo } : {}) });
  const first = starts[0];
  // Opens at the first change when it is below the first screen (the web's file view), once.
  const opened = useRef(false);
  const openAtFirstChange = () => {
    if (opened.current || first === undefined || first < 20) return;
    opened.current = true;
    scrollToRow(list.current, { index: first, viewPosition: 0.3, animated: false });
  };

  let body: ReactNode;
  if (view && view.shown !== 'text') body = <QuietText>{PR_FILE_SHOWN_TEXT[view.shown]}</QuietText>;
  else if (view && lines.length === 0) body = <QuietText>{tMobile('screens.this-file-is-empty')}</QuietText>;
  else if (view)
    body = (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flex: 1 }}>
        <FlatList
          ref={list}
          data={lines}
          keyExtractor={(_, i) => String(i)}
          renderItem={({ item, index }) => (
            <FileLine line={item} digits={digits} tokens={tokens[index] ?? null} />
          )}
          onLayout={openAtFirstChange}
          onScrollToIndexFailed={(info) => {
            // Not laid out that far yet: jump near it by the average line, then to the line itself.
            list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
            setTimeout(() => scrollToRow(list.current, { index: info.index, viewPosition: 0.3 }), 50);
          }}
          initialNumToRender={60}
          windowSize={11}
          contentContainerStyle={{ paddingVertical: 12 }}
          accessibilityLabel={`${path}, view only`}
        />
      </ScrollView>
    );
  else if (query.error instanceof ApiError && query.error.status === 404)
    body = <ErrorState text={`This pull request doesn’t change ${path}.`} />;
  else if (query.error)
    body = (
      <ErrorState
        text={tMobile('screens.couldnt-open-this-file-try-again-in-a')}
        onRetry={() => void query.refetch()}
      />
    );
  else body = <SkeletonRows count={8} lines={1} label={tMobile('screens.loading-the-file')} />;

  return (
    <Screen>
      <BackBar label={tMobile('screens.files-changed')} onPress={goBack} />
      <View style={{ gap: 6, paddingHorizontal: 22, paddingBottom: 12 }}>
        <Text size={14} weight={500} mono numberOfLines={2} accessibilityRole="header">
          {path}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {add !== undefined && del !== undefined ? (
            <Text size={12} weight={500} mono>
              <Text size={12} weight={500} mono color={theme.colors.ok}>
                {formatAdditions(add)}
              </Text>{' '}
              <Text size={12} weight={500} mono color={theme.colors.bad}>
                {formatDeletions(del)}
              </Text>
            </Text>
          ) : null}
          {view && view.status !== 'modified' ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {view.status === 'added' ? tMobile('screens.new-file') : tMobile('screens.deleted')}
            </Text>
          ) : null}
          <Text size={11.5} mono color={theme.colors.mut}>
            {tMobile('screens.view-only')}
          </Text>
          {starts.length > 0 ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {`${starts.length} ${starts.length === 1 ? 'change' : 'changes'}`}
            </Text>
          ) : null}
        </View>
      </View>
      <View style={{ flex: 1, backgroundColor: theme.colors.code }}>{body}</View>
      {previous || next ? (
        <View
          style={{
            flexDirection: 'row',
            gap: 10,
            paddingTop: 12,
            paddingHorizontal: 22,
            paddingBottom: bottomPadding(36, insets.bottom, 14),
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          <Button
            label={tMobile('screens.previous-file')}
            variant="secondary"
            disabled={!previous}
            onPress={() => previous && open(previous)}
            style={{ flex: 1 }}
          />
          <Button
            label={tMobile('screens.next-file')}
            variant="secondary"
            disabled={!next}
            onPress={() => next && open(next)}
            style={{ flex: 1 }}
          />
        </View>
      ) : null}
    </Screen>
  );
}
