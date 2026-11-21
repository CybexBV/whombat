/**
 * Files on iPhone and Android (files-space.md FS-07; AP-772…; the final design,
 * docs/design-handoff/council-ui-2026-11/16-final/files/, docs/decisions/final-settings-vault-files-usage.md): the one
 * Files home, the conversations whose files the viewer may see, newest file first, in one card — the person's Chat with
 * the agent's face, branch rooms with theirs — each with “4 files · 136 MB · Last added 23 Sep 11:20”. A row opens that
 * conversation's Files. A conversation the sidebar doesn't list (a task chat) is looked up on its own. Loading, no
 * files yet (with Go to Chat) and a failed read each have a card of their own.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { FILES_COPY, type FilesConversationRow, filesConversationRows } from '@whombat/client';
import { useConversation, useFilesSummary } from '@whombat/client/react';
import { useMemo } from 'react';
import { RefreshControl, ScrollView } from 'react-native';
import { useBurrow, useViewContext } from '../data/BurrowProvider';
import { filesListRow, filesRowFor } from '../data/files';
import { PLACE_WORDS } from '../data/places';
import { useAgentWords } from '../data/useAgent';
import { useFilesSpace } from '../data/useFiles';
import type { RootStackParamList } from '../navigation/routes';
import { useTheme } from '../theme/theme';
import { BackBar, Screen } from '../ui/headers';
import { Folder } from '../ui/icons';
import { PLACE_SIDE, PlaceCard, PlaceRow, PlaceState, PlaceTitle } from '../ui/place';
import { PlacesButton } from '../ui/places';
import { useBottomRoom } from '../ui/screenBottom';
import { FilesConversationMark } from './FilesParts';

type Props = NativeStackScreenProps<RootStackParamList, 'Files'>;

function FilesRow({ row, first, onOpen }: { row: FilesConversationRow; first: boolean; onOpen: () => void }) {
  const ctx = useViewContext();
  const view = filesListRow(row, ctx);
  return (
    <PlaceRow
      first={first}
      mark={<FilesConversationMark row={row} size={32} />}
      title={view.title}
      line={view.meta}
      label={view.accessibilityLabel}
      onPress={onOpen}
    />
  );
}

/** A conversation the sidebar doesn't list: named from the conversation itself once it is fetched. */
function UnlistedFilesRow({
  row,
  first,
  onOpen,
}: {
  row: FilesConversationRow;
  first: boolean;
  onOpen: () => void;
}) {
  const { slug } = useBurrow();
  const detail = useConversation({ params: { burrow: slug, conversationId: row.conversationId } });
  const named = useMemo(
    () => (detail.data ? filesRowFor(detail.data.summary, row) : row),
    [detail.data, row],
  );
  return <FilesRow row={named} first={first} onOpen={onOpen} />;
}

export function FilesScreen({ navigation, route }: Props) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug, bootstrap } = useBurrow();
  const on = useFilesSpace();
  const words = useAgentWords();
  const summary = useFilesSummary(on ? { params: { burrow: slug } } : null);
  const rows = useMemo(() => filesConversationRows(summary.data, bootstrap), [summary.data, bootstrap]);
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const open = (conversationId: string) => navigation.navigate('ConversationFiles', { conversationId });

  return (
    <Screen>
      <BackBar
        label={route.params?.back ?? 'Back'}
        onPress={goBack}
        right={<PlacesButton current="files" here={PLACE_WORDS.files} />}
      />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: PLACE_SIDE, paddingBottom: 28 + bottomRoom, gap: 18 }}
        refreshControl={
          <RefreshControl
            refreshing={summary.isRefetching}
            onRefresh={() => void summary.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <PlaceTitle title={FILES_COPY.title} intro={FILES_COPY.intro} />
        {!on ? null : summary.error && !summary.data ? (
          <PlaceState
            kind="failed"
            icon={Folder}
            title={FILES_COPY.readFailed}
            line={FILES_COPY.readFailedLine}
            retryLabel={FILES_COPY.retry}
            onRetry={() => void summary.refetch()}
          />
        ) : !summary.data ? (
          <PlaceState kind="loading" icon={Folder} title={FILES_COPY.loading} />
        ) : rows.length === 0 ? (
          <PlaceState
            kind="empty"
            icon={Folder}
            title={FILES_COPY.emptyTitle}
            line={FILES_COPY.emptyLine(words.Name)}
            action={{
              label: FILES_COPY.goToChat,
              onPress: () => navigation.navigate('Tabs', { screen: 'ChatRoom' }),
            }}
          />
        ) : (
          <PlaceCard>
            {rows.map((row, i) =>
              row.kind === 'unknown' ? (
                <UnlistedFilesRow
                  key={row.conversationId}
                  row={row}
                  first={i === 0}
                  onOpen={() => open(row.conversationId)}
                />
              ) : (
                <FilesRow
                  key={row.conversationId}
                  row={row}
                  first={i === 0}
                  onOpen={() => open(row.conversationId)}
                />
              ),
            )}
          </PlaceCard>
        )}
      </ScrollView>
    </Screen>
  );
}
