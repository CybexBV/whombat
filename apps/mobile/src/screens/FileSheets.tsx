/**
 * The Files sheets (files-space.md FS-05…FS-07; AP-772…; not mocked), in the message menu's language: a file's action
 * sheet (Download, Open message, Rename, Move to folder…, Remove from Files — each only where it applies, Remove last in
 * the bad tone), Rename with the name in a field, Move with the space's folders as a list and a path field for a new
 * one, and New folder with a name field. Every refusal is the Whombat's sentence, under the field.
 */

import type { FileEntry } from '@whombat/core';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import {
  canRename,
  type FileAction,
  type FileActionKind,
  type MoveChoice,
  renameProblem,
} from '../data/files';
import { filesCopy } from '../data/filesCopy';
import { useI18n, useMobileT } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import {
  Check,
  Folder,
  FolderInput,
  type LucideIcon,
  MessageSquare,
  Pencil,
  Share2,
  Trash,
} from '../ui/icons';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { Touchable } from '../ui/Touchable';

const ICONS: Record<FileActionKind, LucideIcon> = {
  download: Share2,
  open_message: MessageSquare,
  rename: Pencil,
  move: FolderInput,
  remove: Trash,
};

/** A file's actions: its name on top, then 52dp rows. */
export function FileActionSheet({
  entry,
  actions,
  onClose,
  onAction,
}: {
  /** The file the sheet is for; null when it is closed. */
  entry: FileEntry | null;
  actions: readonly FileAction[];
  onClose: () => void;
  onAction: (kind: FileActionKind) => void;
}) {
  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  return (
    <Sheet visible={entry !== null} onClose={onClose} label={tMobile('screens.file-actions')}>
      <Text
        size={13.5}
        lh={1.4}
        color={theme.colors.mut}
        numberOfLines={2}
        style={{ paddingHorizontal: 22, paddingBottom: 12 }}
      >
        {entry?.attachment.name ?? ''}
      </Text>
      {actions.map((a) => {
        const Icon = ICONS[a.kind];
        return (
          <Touchable
            key={a.kind}
            onPress={() => onAction(a.kind)}
            feedback="wash"
            accessibilityLabel={a.label}
            accessibilityHint={a.accessibilityHint}
            style={{
              minHeight: 52,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 14,
              paddingHorizontal: 22,
              borderTopWidth: 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <Icon size={19} color={a.destructive ? theme.colors.bad : theme.colors.ink2} strokeWidth={1.75} />
            <Text size={16} weight={500} color={a.destructive ? theme.colors.bad : theme.colors.ink}>
              {a.label}
            </Text>
          </Touchable>
        );
      })}
    </Sheet>
  );
}

/** Rename a file saved straight into Files (FS-05): the name in a field, Save while it differs. */
export function RenameFileSheet({
  entry,
  busy,
  error,
  onSave,
  onClose,
}: {
  entry: FileEntry | null;
  busy: boolean;
  /** Why the last save didn't go through. */
  error: string | null;
  onSave: (name: string) => void;
  onClose: () => void;
}) {
  const { rawLocale, tClient } = useI18n();
  const filesCopyHere = filesCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const [draft, setDraft] = useState('');
  useEffect(() => {
    if (entry) setDraft(entry.attachment.name);
  }, [entry]);
  const original = entry?.attachment.name ?? '';
  const problem = draft ? renameProblem(draft, rawLocale) : null;
  return (
    <Sheet
      visible={entry !== null}
      onClose={onClose}
      title={filesCopyHere.rename.toUpperCase()}
      label={filesCopyHere.rename}
      closeLabel={tClient('reports.cancel')}
    >
      <View style={{ paddingHorizontal: 18, gap: 10 }}>
        <FormField
          label={tMobile('screens.name')}
          value={draft}
          onChangeText={setDraft}
          error={problem}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          onSubmitEditing={() => canRename(draft, original) && onSave(draft.trim())}
        />
        <FormMessage text={error} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={tClient('reports.cancel')}
            variant="secondary"
            onPress={onClose}
            style={{ flex: 1 }}
          />
          <Button
            label={tClient('limit.save')}
            busy={busy}
            disabled={!canRename(draft, original)}
            onPress={() => onSave(draft.trim())}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Sheet>
  );
}

/**
 * Move to folder… (FS-03, FS-05): the top and every folder of the space (indented by depth, the file's own checked) —
 * a tap moves it there — and a path field for a folder that doesn't exist yet (“Drawings/2024”).
 */
export function MoveFileSheet({
  entry,
  choices,
  busy,
  error,
  check,
  onMove,
  onClose,
}: {
  entry: FileEntry | null;
  choices: readonly MoveChoice[];
  busy: boolean;
  error: string | null;
  /** The typed path as a folder, or why it can't be one. */
  check: (raw: string) => { folder: string } | { problem: string };
  onMove: (folder: string) => void;
  onClose: () => void;
}) {
  const { rawLocale, tClient } = useI18n();
  const filesCopyHere = filesCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (entry) setTyped('');
  }, [entry]);
  const result = typed.trim() ? check(typed) : null;
  const problem = result && 'problem' in result ? result.problem : null;
  return (
    <Sheet
      visible={entry !== null}
      onClose={onClose}
      title={filesCopyHere.move.replace('…', '').toUpperCase()}
      label={filesCopyHere.move}
      closeLabel={tClient('reports.cancel')}
      maxHeight="90%"
    >
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 4 }}>
        <View accessibilityRole="radiogroup" accessibilityLabel={tMobile('screens.folders')}>
          {choices.map((c) => (
            <Touchable
              key={c.path || '(top)'}
              onPress={() => (c.current ? onClose() : onMove(c.path))}
              disabled={busy}
              feedback="wash"
              accessibilityRole="radio"
              accessibilityState={{ selected: c.current, disabled: busy }}
              accessibilityLabel={c.path ? c.path : c.label}
              style={{
                minHeight: 52,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingLeft: 22 + c.depth * 18,
                paddingRight: 22,
                borderTopWidth: 1,
                borderTopColor: theme.colors.line,
              }}
            >
              <Folder size={18} color={theme.colors.ink2} strokeWidth={1.75} />
              <Text size={16} weight={c.current ? 600 : 500} numberOfLines={1} style={{ flex: 1 }}>
                {c.label}
              </Text>
              {c.current ? <Check size={20} color={theme.colors.brand} strokeWidth={2.25} /> : null}
            </Touchable>
          ))}
        </View>
        <View style={{ paddingHorizontal: 18, paddingTop: 14, gap: 10 }}>
          <FormField
            label={tMobile('screens.or-a-new-folder')}
            value={typed}
            onChangeText={setTyped}
            error={problem}
            hint={problem ? null : tMobile('screens.a-path-like-drawings-2024')}
            placeholder={tMobile('screens.drawings-2024')}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="done"
            onSubmitEditing={() => result && 'folder' in result && onMove(result.folder)}
          />
          <FormMessage text={error} />
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button
              label={tClient('reports.cancel')}
              variant="secondary"
              onPress={onClose}
              style={{ flex: 1 }}
            />
            <Button
              label={tMobile('screens.move')}
              busy={busy}
              disabled={!result || 'problem' in result}
              onPress={() => result && 'folder' in result && onMove(result.folder)}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </ScrollView>
    </Sheet>
  );
}

/** New folder (FS-03): a name; the folder is a place to upload or move into until a file is in it. */
export function NewFolderSheet({
  visible,
  check,
  onCreate,
  onClose,
}: {
  visible: boolean;
  /** The name as a folder in the current one, or why it can't be one. */
  check: (raw: string) => { folder: string } | { problem: string };
  onCreate: (folder: string) => void;
  onClose: () => void;
}) {
  const { rawLocale, tClient } = useI18n();
  const filesCopyHere = filesCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const [name, setName] = useState('');
  const [tried, setTried] = useState(false);
  useEffect(() => {
    if (visible) {
      setName('');
      setTried(false);
    }
  }, [visible]);
  const result = check(name);
  const problem = (tried || name.trim()) && 'problem' in result ? result.problem : null;
  const create = () => {
    setTried(true);
    if ('folder' in result) onCreate(result.folder);
  };
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={filesCopyHere.newFolder.toUpperCase()}
      label={filesCopyHere.newFolder}
      closeLabel={tClient('reports.cancel')}
    >
      <View style={{ paddingHorizontal: 18, gap: 10 }}>
        <FormField
          label={tMobile('screens.folder-name')}
          value={name}
          onChangeText={setName}
          error={problem}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={create}
        />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={tClient('reports.cancel')}
            variant="secondary"
            onPress={onClose}
            style={{ flex: 1 }}
          />
          <Button
            label={tMobile('screens.create')}
            disabled={!name.trim()}
            onPress={create}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Sheet>
  );
}
