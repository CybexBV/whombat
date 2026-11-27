/**
 * One conversation's Files on Android (files-space.md FS-01…FS-07; AP-772…; not mocked): the conversation as the kicker,
 * “Files” (or the folder's name) as the title, breadcrumbs up to the top, Upload and New folder, then the folders (by
 * name, with what is in them) and the files (newest first: a thumbnail or the kind's icon, the name, when, who and
 * whether it came “In a message” or was “Saved to Files”). A tap opens a file the way a message's file opens (pictures
 * full screen, the rest through the share sheet); ⋮ and a long press open its actions (Download, Open message, Rename,
 * Move to folder…, Remove from Files — as the Whombat allows this viewer, FS-05). Uploads go into the folder on screen,
 * one row each with progress; New folder is a place on the phone until a file is in it (FS-03). Back (the bar or the
 * system's) goes up a folder before it leaves.
 */

import { useFocusEffect } from '@react-navigation/native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  ApiError,
  type FilesUpload,
  fileMessageLink,
  filesAtFolder,
  filesErrorText,
  filesUploadStatusText,
  folderCrumbs,
  folderName,
  movedText,
  parentFolder,
  pendingPlaces,
  sidebarSummaries,
} from '@whombat/client';
import { useConversation, useFileRemove, useFilesList, useFileUpdate } from '@whombat/client/react';
import { type Attachment, type FileEntry, filesFolderKey, isPageSet } from '@whombat/core';
import * as DocumentPicker from 'expo-document-picker';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, BackHandler, RefreshControl, ScrollView, View } from 'react-native';
import { PrincipalAvatar } from '../avatars/Avatars';
import { fromDocumentAsset, type PickedFile } from '../data/attachments';
import { useBurrow, useBurrowBase, useViewContext } from '../data/BurrowProvider';
import { useFileAccess } from '../data/fileAccess';
import {
  type FileActionKind,
  fileActions,
  fileRowView,
  filesKicker,
  filesRowFor,
  filesTargetId,
  filesWhere,
  folderRowMeta,
  moveChoices,
  newFolder,
  reachableFolder,
  removeConfirm,
  typedFolder,
} from '../data/files';
import { filesCopy } from '../data/filesCopy';
import { fileMenu, type NativeMenuSpec } from '../data/nativeMenu';
import { pagesCopy } from '../data/pageSets';
import { useFilesSpace, useFilesUploads } from '../data/useFiles';
import { useI18n, useMobileT } from '../i18n';
import { useOpenLink } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ImageViewer, opensInViewer, shareAttachment } from '../ui/attachments';
import { BackBar, Screen } from '../ui/headers';
import { EllipsisVertical, X } from '../ui/icons';
import { ListRow, RowChevron } from '../ui/ListRow';
import { hasNativeMenu, NativeMenu } from '../ui/nativeMenu';
import { PageSetViewer } from '../ui/pageSetViewer';
import { Button, CardNote, ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { Touchable } from '../ui/Touchable';
import { FileActionSheet, MoveFileSheet, NewFolderSheet, RenameFileSheet } from './FileSheets';
import { FilesConversationMark, FilesGroup, FilesTitle, FileTile, FolderTile } from './FilesParts';
import { showNotice, useDecisionFeedback } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'ConversationFiles'>;

/** “Files › Drawings › 2024”: every step above the folder on screen opens it. */
function Breadcrumbs({ folder, onOpen }: { folder: string; onOpen: (path: string) => void }) {
  const { rawLocale } = useI18n();
  const filesCopyHere = filesCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const crumbs = [{ name: filesCopyHere.title, path: '' }, ...folderCrumbs(folder)];
  return (
    <View
      accessibilityRole="list"
      accessibilityLabel={tMobile('screens.folders-above')}
      style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', marginLeft: -6 }}
    >
      {crumbs.slice(0, -1).map((c) => (
        <View key={c.path || '(top)'} style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Touchable
            onPress={() => onOpen(c.path)}
            feedback="wash"
            ringRadius={8}
            accessibilityRole="link"
            accessibilityLabel={
              c.path ? tMobile('screens2.files.folder', { name: c.name }) : filesCopyHere.top
            }
            style={{ minHeight: 44, paddingHorizontal: 6, justifyContent: 'center' }}
          >
            <Text size={14} weight={500} color={theme.colors.brand} numberOfLines={1}>
              {c.name}
            </Text>
          </Touchable>
          <RowChevron />
        </View>
      ))}
    </View>
  );
}

/** One upload into Files: its name and how it goes; Try again where it can help, × to cancel or let it go. */
function UploadRow({
  item,
  canRetry,
  onRetry,
  onDismiss,
}: {
  item: FilesUpload;
  canRetry: boolean;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const { t: tMobile } = useMobileT();
  const { rawLocale, tClient } = useI18n();
  const theme = useTheme();
  const status = filesUploadStatusText(item, rawLocale);
  const failed = item.state === 'failed';
  const going = item.state === 'uploading' || item.state === 'saving';
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        paddingVertical: 8,
        paddingLeft: 16,
        paddingRight: 6,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <View
        style={{ flex: 1, minWidth: 0, gap: 3 }}
        accessible
        accessibilityLabel={`${item.name}, ${status}`}
      >
        <Text size={14.5} weight={500} numberOfLines={1}>
          {item.name}
        </Text>
        <Text
          size={11.5}
          mono
          lh={1.4}
          color={failed ? theme.colors.bad : item.state === 'saved' ? theme.colors.ok : theme.colors.mut}
          accessibilityLiveRegion={failed ? 'polite' : 'none'}
        >
          {status}
        </Text>
        {item.state === 'uploading' ? (
          <View style={{ height: 3, borderRadius: 2, backgroundColor: theme.colors.sf2, overflow: 'hidden' }}>
            <View
              style={{
                height: 3,
                width: `${Math.round(item.progress * 100)}%`,
                backgroundColor: theme.colors.brand,
              }}
            />
          </View>
        ) : null}
      </View>
      {failed && canRetry ? (
        <Button label={tClient('settings.retry')} variant="secondary" onPress={onRetry} />
      ) : null}
      {item.state === 'saved' ? null : (
        <Touchable
          onPress={onDismiss}
          feedback="wash"
          ringRadius={22}
          accessibilityLabel={tMobile(going ? 'screens2.attach.cancel' : 'screens2.files.dismiss', {
            name: item.name,
          })}
          style={{ width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' }}
        >
          <X size={18} color={theme.colors.ink2} strokeWidth={2} />
        </Touchable>
      )}
    </View>
  );
}

/**
 * A file: a tap opens it, ⋮ (or a long press) opens its actions — on iPhone iOS's own menu (`menu`), elsewhere the
 * sheet (`onMore`).
 */
function FileRow({
  entry,
  busy,
  menu,
  onPick,
  onOpen,
  onMore,
}: {
  entry: FileEntry;
  busy: boolean;
  menu: NativeMenuSpec;
  onPick: (id: string) => void;
  onOpen: () => void;
  onMore: () => void;
}) {
  const { rawLocale } = useI18n();
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const ctx = useViewContext();
  const { people } = useBurrowBase();
  const access = useFileAccess();
  const view = fileRowView(entry, ctx);
  const moreFace = busy ? (
    <ActivityIndicator color={theme.colors.mut} />
  ) : (
    <EllipsisVertical size={19} color={theme.colors.ink2} strokeWidth={1.75} />
  );
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.line,
      }}
    >
      <NativeMenu spec={menu} onPick={onPick} style={GROWS}>
        <Touchable
          onPress={onOpen}
          {...(hasNativeMenu ? null : { onLongPress: onMore })}
          feedback="wash"
          accessibilityLabel={view.accessibilityLabel}
          accessibilityHint={
            isPageSet(entry.attachment)
              ? pagesCopy(rawLocale).openHint
              : opensInViewer(entry.attachment)
                ? tMobile('screens.opens-the-picture')
                : tMobile('screens.opens-the-share-sheet')
          }
          style={{
            ...GROWS,
            minHeight: 44,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 12,
            paddingLeft: 16,
            paddingRight: 4,
          }}
        >
          <FileTile attachment={entry.attachment} access={access} />
          <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6 }}>
              <Text size={15.5} weight={600} numberOfLines={1} style={{ flexShrink: 1, flexGrow: 1 }}>
                {view.name}
              </Text>
              <Text size={11.5} mono color={theme.colors.mut}>
                {view.time}
              </Text>
            </View>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <PrincipalAvatar principal={people.get(view.uploaderId)} size={16} />
              <Text
                size={11.5}
                mono
                color={theme.colors.mut}
                numberOfLines={1}
                style={{ flex: 1, minWidth: 0 }}
              >
                {`${view.uploader} · ${view.size} · ${view.origin}`}
              </Text>
            </View>
          </View>
        </Touchable>
      </NativeMenu>
      {hasNativeMenu ? (
        <NativeMenu
          spec={menu}
          onPick={onPick}
          trigger="tap"
          label={tMobile('screens2.files.actionsFor', { name: view.name })}
          style={MORE_BUTTON}
        >
          <View style={MORE_FACE}>{moreFace}</View>
        </NativeMenu>
      ) : (
        <Touchable
          onPress={onMore}
          feedback="wash"
          ringRadius={22}
          accessibilityLabel={tMobile('screens2.files.actionsFor', { name: view.name })}
          style={MORE_BUTTON}
        >
          {moreFace}
        </Touchable>
      )}
    </View>
  );
}

/** The row's part that a tap opens: the room the ⋮ leaves (sized by its content, so it holds the same in a menu). */
const GROWS = { flexGrow: 1, flexShrink: 1, minWidth: 0 } as const;
/** A file's ⋮: 44dp, a little in from the edge. */
const MORE_FACE = {
  width: 44,
  height: 44,
  borderRadius: 22,
  alignItems: 'center',
  justifyContent: 'center',
} as const;
const MORE_BUTTON = { ...MORE_FACE, marginRight: 6 } as const;

export function ConversationFilesScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const filesCopyHere = filesCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug, bootstrap } = useBurrow();
  const on = useFilesSpace();
  const access = useFileAccess();
  const openLink = useOpenLink();
  const feedback = useDecisionFeedback();
  const params = route.params;
  const conversationId = filesTargetId(params, bootstrap);

  // The conversation: from the sidebar, else asked for (a task chat).
  const listed = useMemo(
    () => sidebarSummaries(bootstrap.sidebar).find((s) => s.id === conversationId) ?? null,
    [bootstrap.sidebar, conversationId],
  );
  const fetched = useConversation(
    on && conversationId && !listed ? { params: { burrow: slug, conversationId } } : null,
  );
  const summary = listed ?? fetched.data?.summary ?? null;
  const row = useMemo(() => (summary ? filesRowFor(summary) : null), [summary]);
  const where = filesWhere(row, rawLocale);

  const list = useFilesList(slug, on ? conversationId : null);
  const entries = useMemo(() => list.data?.files ?? [], [list.data]);
  const [folder, setFolder] = useState(params.folder ?? '');
  // “New folder”s of this visit: places to upload or move into until a file is in them (FS-03).
  const [places, setPlaces] = useState<string[]>([]);
  useEffect(() => {
    setPlaces((p) => {
      const kept = pendingPlaces(entries, p);
      return kept.length === p.length ? p : kept;
    });
  }, [entries]);
  // A folder that is gone (moved away, emptied elsewhere): the nearest one above it that is still there.
  useEffect(() => {
    if (!list.data) return;
    const shown = reachableFolder(entries, folder, places);
    if (shown !== folder) setFolder(shown);
  }, [list.data, entries, folder, places]);
  const view = useMemo(() => filesAtFolder(entries, folder, places), [entries, folder, places]);

  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Files'));
  const up = folder ? () => setFolder(parentFolder(folder)) : null;
  // The system's back goes up a folder first.
  useFocusEffect(
    useCallback(() => {
      if (!folder) return undefined;
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        setFolder(parentFolder(folder));
        return true;
      });
      return () => sub.remove();
    }, [folder]),
  );

  /* Uploads ------------------------------------------------------------------------------------- */
  const uploads = useFilesUploads(slug, conversationId);
  const pickFiles = async () => {
    const result = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true });
    if (result.canceled) return;
    uploads.add(
      result.assets.map(fromDocumentAsset).filter((f): f is PickedFile => f !== null),
      folder,
    );
  };
  const [naming, setNaming] = useState(false);

  /* A file's actions ---------------------------------------------------------------------------- */
  const [menuFor, setMenuFor] = useState<FileEntry | null>(null);
  const [renaming, setRenaming] = useState<FileEntry | null>(null);
  const [moving, setMoving] = useState<FileEntry | null>(null);
  const [sheetError, setSheetError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<Attachment | null>(null);
  const [sharing, setSharing] = useState<string | null>(null);
  const update = useFileUpdate();
  const remove = useFileRemove(conversationId ?? '');

  const share = (a: Attachment) => {
    if (!access || sharing) return;
    setSharing(a.id);
    shareAttachment(a, access, rawLocale)
      .catch(() =>
        Alert.alert(
          tMobile('screens.couldnt-open-it'),
          tMobile('screens2.files.didntDownload', { name: a.name }),
        ),
      )
      .finally(() => setSharing(null));
  };
  // Pictures and page sets open in their viewer here too; everything else goes to the share sheet.
  const open = (entry: FileEntry) =>
    (opensInViewer(entry.attachment) || isPageSet(entry.attachment)) && access
      ? setViewing(entry.attachment)
      : share(entry.attachment);

  const write = (entry: FileEntry, body: { name?: string; folder?: string }, done: () => void) => {
    setSheetError(null);
    update.mutate(
      { params: { burrow: slug, attachmentId: entry.attachment.id }, body },
      {
        onSuccess: (result) => {
          if (result.status !== 'ok') {
            feedback.onResult(result);
            return;
          }
          done();
        },
        onError: (error) => setSheetError(filesErrorText(error, tMobile('screens2.files.writeFailed'))),
      },
    );
  };

  /** An action on the file whose menu it was: the sheet's (`menuFor`), or iOS's own menu's (`picked`). */
  const act = (kind: FileActionKind, picked: FileEntry | null = menuFor) => {
    const entry = picked;
    setMenuFor(null);
    if (!entry) return;
    setSheetError(null);
    switch (kind) {
      case 'download':
        share(entry.attachment);
        return;
      case 'open_message': {
        const link = row?.link ? fileMessageLink(entry, row.link) : null;
        if (link) openLink(link, filesCopyHere.title);
        return;
      }
      case 'rename':
        setRenaming(entry);
        return;
      case 'move':
        setMoving(entry);
        return;
      case 'remove': {
        const confirm = removeConfirm(entry, where, rawLocale);
        Alert.alert(confirm.title, confirm.body, [
          { text: tMobile('screens2.common.cancel'), style: 'cancel' },
          {
            text: confirm.cta,
            style: 'destructive',
            onPress: () =>
              remove.mutate(
                { params: { burrow: slug, attachmentId: entry.attachment.id } },
                {
                  onSuccess: feedback.onResult,
                  onError: (error) =>
                    feedback.onText(filesErrorText(error, tMobile('screens2.files.writeFailed'))),
                },
              ),
          },
        ]);
        return;
      }
    }
  };

  const notFound = list.error instanceof ApiError && list.error.status === 404;
  const empty = view.folders.length === 0 && view.files.length === 0;
  const kicker = filesKicker(row);

  return (
    <Screen>
      <BackBar
        label={up ? folderName(parentFolder(folder), rawLocale) : tMobile('managed.back')}
        onPress={up ?? goBack}
      />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 28 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={list.isRefetching}
            onRefresh={() => void list.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <FilesTitle
          kicker={kicker}
          mark={row ? <FilesConversationMark row={row} size={18} /> : null}
          title={folder ? folderName(folder, rawLocale) : filesCopyHere.title}
        >
          {folder ? <Breadcrumbs folder={folder} onOpen={setFolder} /> : null}
          {conversationId && list.data ? (
            <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
              <Button
                label={filesCopyHere.upload}
                onPress={() => void pickFiles().catch((error: unknown) => feedback.onError(error))}
                style={{ flex: 1 }}
                accessibilityHint={tMobile('screens2.files.uploadsTo', {
                  place: folder ? folderName(folder, rawLocale) : filesCopyHere.title,
                })}
              />
              <Button
                label={filesCopyHere.newFolder}
                variant="secondary"
                onPress={() => setNaming(true)}
                style={{ flex: 1 }}
              />
            </View>
          ) : null}
        </FilesTitle>

        {uploads.items.length > 0 ? (
          <FilesGroup>
            {uploads.items.map((item) => (
              <UploadRow
                key={item.localId}
                item={item}
                canRetry={uploads.canRetry(item)}
                onRetry={() => uploads.retry(item.localId)}
                onDismiss={() => uploads.dismiss(item.localId)}
              />
            ))}
          </FilesGroup>
        ) : null}

        {!on ? null : !conversationId || notFound ? (
          <QuietText>{filesCopyHere.notHere}</QuietText>
        ) : list.error && !list.data ? (
          <ErrorState text={filesCopyHere.loadError} onRetry={() => void list.refetch()} />
        ) : !list.data ? (
          <SkeletonRows count={5} avatarSize={44} label={tMobile('screens.loading-these-files')} />
        ) : empty ? (
          <QuietText>{folder ? filesCopyHere.folderEmpty : filesCopyHere.spaceEmpty}</QuietText>
        ) : (
          <FilesGroup>
            {view.folders.map((f) => (
              <ListRow
                key={f.path}
                leading={<FolderTile />}
                title={f.name}
                meta={folderRowMeta(f, rawLocale)}
                trailing="›"
                accessibilityLabel={`${f.name}, folder, ${folderRowMeta(f, rawLocale)}`}
                onPress={() => setFolder(f.path)}
              />
            ))}
            {view.files.map((entry) => (
              <FileRow
                key={entry.attachment.id}
                entry={entry}
                busy={sharing === entry.attachment.id}
                menu={fileMenu(entry.attachment.name, fileActions(entry, rawLocale))}
                onPick={(id) => {
                  const kind = fileActions(entry, rawLocale).find((a) => a.kind === id)?.kind;
                  if (kind) act(kind, entry);
                }}
                onOpen={() => open(entry)}
                onMore={() => setMenuFor(entry)}
              />
            ))}
            {list.data.truncated ? (
              <CardNote>{tMobile('screens.only-the-newest-10-000-files-show-here')}</CardNote>
            ) : null}
          </FilesGroup>
        )}
      </ScrollView>

      <FileActionSheet
        entry={menuFor}
        actions={menuFor ? fileActions(menuFor, rawLocale) : []}
        onClose={() => setMenuFor(null)}
        onAction={act}
      />
      <RenameFileSheet
        entry={renaming}
        busy={update.isPending}
        error={sheetError}
        onClose={() => setRenaming(null)}
        onSave={(name) => renaming && write(renaming, { name }, () => setRenaming(null))}
      />
      <MoveFileSheet
        entry={moving}
        choices={moving ? moveChoices(entries, places, moving.folder, rawLocale) : []}
        busy={update.isPending}
        error={sheetError}
        check={(raw) => typedFolder(raw, entries, places, rawLocale)}
        onClose={() => setMoving(null)}
        onMove={(target) =>
          moving &&
          write(moving, { folder: target }, () => {
            setMoving(null);
            showNotice(movedText(target, rawLocale));
          })
        }
      />
      <NewFolderSheet
        visible={naming}
        check={(raw) => newFolder(raw, folder, entries, places, rawLocale)}
        onClose={() => setNaming(false)}
        onCreate={(path) => {
          setNaming(false);
          setPlaces((p) => (p.some((x) => filesFolderKey(x) === filesFolderKey(path)) ? p : [...p, path]));
          setFolder(path);
        }}
      />
      {access && viewing && isPageSet(viewing) ? (
        <PageSetViewer
          attachment={viewing}
          access={access}
          onClose={() => setViewing(null)}
          onDownload={() => shareAttachment(viewing, access, rawLocale)}
        />
      ) : access && viewing ? (
        <ImageViewer attachment={viewing} access={access} onClose={() => setViewing(null)} />
      ) : null}
    </Screen>
  );
}
