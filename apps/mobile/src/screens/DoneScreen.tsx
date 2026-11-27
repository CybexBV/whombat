/**
 * Everything I did (Whombat home-redesign HR-24, HR-05; home-redesign-mobile.md AP-2261): every change the assistant
 * made for the viewer, newest first (`changes.list`, as the web's `/done`), a page at a time with “Show older”; each with
 * Undo while it can be undone, Review where there is something to look at, or “Undone”. Opened from Home's Done recently
 * (“All”) and by the web's address (`/done`, `whombat://done`).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useChanges } from '@whombat/client/react';
import type { ChangeEntry } from '@whombat/core';
import { useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { DONE_COPY } from '../data/done';
import { OVERVIEW_TITLE } from '../data/shell';
import { useAgentWords } from '../data/useAgent';
import { useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { OneCard } from '../ui/assistant';
import { BackBar, Screen } from '../ui/headers';
import { Button, ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { DoneItem, useDoneRows, useUndo } from './home/DoneParts';

/** A page of changes (`changes.list` takes at most 100). */
const PAGE = 20;

type Props = NativeStackScreenProps<RootStackParamList, 'Done'>;

export function DoneScreen({ navigation, route }: Props) {
  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const words = useAgentWords();
  const [cursors, setCursors] = useState<string[]>([]);
  const { busy, run } = useUndo();
  const first = useChanges({ params: { burrow: slug }, query: { limit: PAGE } });
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  return (
    <Screen>
      <BackBar label={route.params?.back ?? OVERVIEW_TITLE} onPress={goBack} />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 28 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={first.isRefetching}
            onRefresh={() => {
              setCursors([]);
              void first.refetch();
            }}
            colors={[theme.colors.ink]}
            tintColor={theme.colors.mut}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ paddingHorizontal: 22, paddingBottom: 14, gap: 6 }}>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {DONE_COPY.screenTitle}
          </Text>
          <Text size={14} lh={1.45} color={theme.colors.ink2}>
            {DONE_COPY.intro(words.Name)}
          </Text>
        </View>
        <View style={{ paddingHorizontal: 18 }}>
          {first.isPending ? (
            <SkeletonRows count={6} lines={2} label={tMobile('screens.loading-what-i-did')} />
          ) : !first.data ? (
            <ErrorState text={DONE_COPY.failed} onRetry={() => void first.refetch()} />
          ) : !first.data.changes.length ? (
            <QuietText>{DONE_COPY.screenEmpty(words.Name)}</QuietText>
          ) : (
            <OneCard>
              <DonePage
                changes={first.data.changes}
                next={cursors.length === 0 ? first.data.before : null}
                firstPage
                busy={busy}
                onUndo={run}
                onMore={(c) => setCursors([c])}
              />
              {cursors.map((c, i) => (
                <OlderPage
                  key={c}
                  before={c}
                  last={i === cursors.length - 1}
                  busy={busy}
                  onUndo={run}
                  onMore={(next) => setCursors((list) => [...list, next])}
                />
              ))}
            </OneCard>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}

/** A page after the first, read when “Show older” asked for it. */
function OlderPage({
  before,
  last,
  busy,
  onUndo,
  onMore,
}: {
  before: string;
  last: boolean;
  busy: string | null;
  onUndo: (change: ChangeEntry) => void;
  onMore: (cursor: string) => void;
}) {
  const { t: tMobile } = useMobileT();
  const { slug } = useBurrowBase();
  const list = useChanges({ params: { burrow: slug }, query: { limit: PAGE, before } }, { retry: false });
  if (list.isPending)
    return <SkeletonRows count={2} lines={2} label={tMobile('screens.loading-older-changes')} />;
  if (!list.data) return null;
  return (
    <DonePage
      changes={list.data.changes}
      next={last ? list.data.before : null}
      busy={busy}
      onUndo={onUndo}
      onMore={onMore}
    />
  );
}

function DonePage({
  changes,
  next,
  firstPage = false,
  busy,
  onUndo,
  onMore,
}: {
  changes: readonly ChangeEntry[];
  /** The cursor for “Show older”, on the last page read only. */
  next: string | null;
  firstPage?: boolean;
  busy: string | null;
  onUndo: (change: ChangeEntry) => void;
  onMore: (cursor: string) => void;
}) {
  const rows = useDoneRows(changes);
  return (
    <>
      {rows.map((r, i) => (
        <DoneItem
          key={r.id}
          row={r}
          first={firstPage && i === 0}
          busy={busy === r.id}
          onUndo={() => onUndo(r.change)}
        />
      ))}
      {next ? (
        <View style={{ paddingHorizontal: 14, paddingVertical: 8 }}>
          <Button label={DONE_COPY.showOlder} variant="quiet" onPress={() => onMore(next)} />
        </View>
      ) : null}
    </>
  );
}
