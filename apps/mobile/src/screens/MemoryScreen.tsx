/**
 * What the agent remembers about you (Whombat hermes-engine.md HE-39, one-agent.md OA-10; contracts 0.125 CT-1200…CT-1204;
 * hermes-engine-app.md AP-5271): a card per file in the contracts' order — what it remembers about working with you,
 * and about you — each with its hint, how full it is (the usage line and a thin bar: amber from 90 %, red over), its
 * entries with Edit (a sheet) and Remove, and Add. Every change writes the whole file with the version it started from,
 * so a change the agent made meanwhile is said (`changed`) and read again instead of lost. Forget everything, asked
 * first, empties both. It lives in the assistant's Memory part (`MemoryPart`) beside the notes it reads in every chat;
 * `Memory`, its old address, opens that part.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  MEMORY_TEXT,
  memoryEntryFits,
  memoryFileEntries,
  memoryUsage,
  memoryWithEdit,
  memoryWithEntry,
  memoryWithout,
  memoryWriteProblem,
} from '@whombat/client';
import { useMemoryWrite, useMyMemory } from '@whombat/client/react';
import { api, MEMORY_FILES, type MemoryFile, type MemoryFileView, memoryCopy } from '@whombat/core';
import { useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { RowButtons } from '../ui/facts';
import { FormField, FormMessage } from '../ui/formField';
import { Screen } from '../ui/headers';
import { Button, CardNote, ErrorState, Section, SkeletonRows, toneColor } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { showNotice } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'Memory'>;

type Copy = ReturnType<typeof memoryCopy>;

/** What the editor sheet is for: a new entry of a file, or entry `index` of it. */
type Editing = { file: MemoryFile; index: number | null } | null;

/** The old address of Memory: the assistant's Memory part, in its place. */
export function MemoryScreen({ navigation }: Props) {
  useEffect(() => {
    navigation.replace('SettingsAgent', { part: 'memory' });
  }, [navigation]);
  return <Screen>{null}</Screen>;
}

/** The memory files' cards, Forget everything and the entry sheet; the part around them scrolls and refreshes. */
export function MemoryFiles() {
  const { rawLocale } = useI18n();

  const theme = useTheme();
  const { slug } = useBurrowBase();
  const words = useAgentWords();
  const copy = memoryCopy(words.name, rawLocale);
  const query = useMyMemory({ params: { burrow: slug } });
  const write = useMemoryWrite(api.memory.write, slug);
  const clear = useMemoryWrite(api.memory.clear, slug);
  const [editing, setEditing] = useState<Editing>(null);
  const [problem, setProblem] = useState<{ file: MemoryFile; text: string } | null>(null);
  const data = query.data;

  /** Write one file's new text; null when it went through, else what to say (the file is read again). */
  const save = async (file: MemoryFile, view: MemoryFileView, text: string): Promise<string | null> => {
    setProblem(null);
    try {
      const result = await write.mutateAsync({
        params: { burrow: slug, file },
        body: { text, ...(view.version ? { ifVersion: view.version } : {}) },
      });
      return result.status === 'ok' ? null : MEMORY_TEXT.failed;
    } catch (error) {
      void query.refetch();
      return memoryWriteProblem(error, copy.changed);
    }
  };

  const removeEntry = (file: MemoryFile, view: MemoryFileView, index: number) =>
    void save(file, view, memoryWithout(view, index)).then((said) =>
      said ? setProblem({ file, text: said }) : showNotice(MEMORY_TEXT.removed),
    );

  const forget = () =>
    Alert.alert(copy.clearQuestion, undefined, [
      { text: copy.cancel, style: 'cancel' },
      {
        text: copy.clear,
        style: 'destructive',
        onPress: () =>
          clear.mutate(
            { params: { burrow: slug }, query: {} },
            {
              onSuccess: (result) => (result.status === 'ok' ? showNotice(copy.cleared) : undefined),
              onError: (error) => Alert.alert(memoryWriteProblem(error, copy.changed)),
            },
          ),
      },
    ]);

  const editingView = editing && data ? data[editing.file] : null;

  return (
    <>
      <View style={{ paddingHorizontal: 22, paddingBottom: 14 }}>
        <Text size={15} lh={1.5} color={theme.colors.ink2}>
          {copy.intro}
        </Text>
      </View>
      {!data ? (
        query.error ? (
          <ErrorState text={MEMORY_TEXT.loadFailed} onRetry={() => void query.refetch()} />
        ) : (
          <SkeletonRows count={3} lines={2} label={copy.title} />
        )
      ) : (
        <>
          {MEMORY_FILES.map((file) => (
            <MemoryFileCard
              key={file}
              file={file}
              view={data[file]}
              copy={copy}
              busy={write.isPending || clear.isPending}
              problem={problem?.file === file ? problem.text : null}
              onAdd={() => {
                setProblem(null);
                setEditing({ file, index: null });
              }}
              onEdit={(index) => {
                setProblem(null);
                setEditing({ file, index });
              }}
              onRemove={(index) => removeEntry(file, data[file], index)}
            />
          ))}
          {data.memory.text || data.user.text ? (
            <View style={{ paddingHorizontal: 16 }}>
              <Button
                label={copy.clear}
                variant="quiet"
                busy={clear.isPending}
                disabled={write.isPending}
                onPress={forget}
              />
            </View>
          ) : null}
        </>
      )}
      <EntrySheet
        editing={editing}
        view={editingView}
        copy={copy}
        agent={words.name}
        saving={write.isPending}
        onClose={() => setEditing(null)}
        onSave={async (text) => {
          if (!editing || !editingView) return null;
          const next =
            editing.index === null
              ? memoryWithEntry(editingView, text)
              : memoryWithEdit(editingView, editing.index, text);
          const said = await save(editing.file, editingView, next);
          if (!said) showNotice(MEMORY_TEXT.saved);
          return said;
        }}
      />
    </>
  );
}

/**
 * One file's card: its title and hint, the usage line and bar, its entries (Edit, Remove), and Add — off with `full`
 * when nothing more fits.
 */
function MemoryFileCard({
  file,
  view,
  copy,
  busy,
  problem,
  onAdd,
  onEdit,
  onRemove,
}: {
  file: MemoryFile;
  view: MemoryFileView;
  copy: Copy;
  busy: boolean;
  problem: string | null;
  onAdd: () => void;
  onEdit: (index: number) => void;
  onRemove: (index: number) => void;
}) {
  const theme = useTheme();
  const entries = memoryFileEntries(view);
  const usage = memoryUsage(view);
  const tone = usage.tone === 'ok' ? theme.colors.mut : toneColor(theme, usage.tone);
  const fits = memoryEntryFits(view, '');
  const title = file === 'memory' ? copy.memory : copy.user;
  return (
    <Section>
      <View
        style={{
          gap: 4,
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <Text size={15.5} weight={600} lh={1.3} accessibilityRole="header">
          {title}
        </Text>
        <Text size={13} lh={1.4} color={theme.colors.mut}>
          {file === 'memory' ? copy.memoryHint : copy.userHint}
        </Text>
        <View style={{ gap: 6, paddingTop: 6 }}>
          <Text size={11.5} mono color={tone}>
            {usage.text}
          </Text>
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.sf2, overflow: 'hidden' }}
          >
            <View
              style={{
                width: `${Math.round(usage.fraction * 100)}%`,
                height: 4,
                borderRadius: 2,
                backgroundColor: usage.tone === 'ok' ? theme.colors.ink2 : tone,
              }}
            />
          </View>
        </View>
      </View>
      {entries.length === 0 ? <CardNote>{copy.empty}</CardNote> : null}
      {entries.map((entry, index) => (
        <View
          // Entries are unique (Hermes keeps a repeated one once): the text keys its row.
          key={entry}
          style={{
            gap: 6,
            paddingVertical: 12,
            paddingHorizontal: 16,
            borderBottomWidth: 1,
            borderBottomColor: theme.colors.line,
          }}
        >
          <Text size={15} lh={1.45}>
            {entry}
          </Text>
          <RowButtons>
            <Button
              label={copy.edit}
              variant="secondary"
              disabled={busy}
              accessibilityHint={`${copy.edit}: ${entry}`}
              onPress={() => onEdit(index)}
              style={{ paddingHorizontal: 18 }}
            />
            <Button
              label={MEMORY_TEXT.remove}
              variant="quiet"
              disabled={busy}
              accessibilityHint={`${MEMORY_TEXT.remove}: ${entry}`}
              onPress={() => onRemove(index)}
              style={{ paddingHorizontal: 18 }}
            />
          </RowButtons>
        </View>
      ))}
      <View style={{ gap: 8, paddingVertical: 12, paddingHorizontal: 16 }}>
        <FormMessage text={problem} />
        {fits ? null : (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {copy.full}
          </Text>
        )}
        <RowButtons>
          <Button
            label={MEMORY_TEXT.add}
            variant="secondary"
            disabled={busy || !fits}
            accessibilityHint={title}
            onPress={onAdd}
            style={{ paddingHorizontal: 18 }}
          />
        </RowButtons>
      </View>
    </Section>
  );
}

/** Add or edit one entry: its text in a box, Save and Cancel; what doesn't fit or didn't go through stays under it. */
function EntrySheet({
  editing,
  view,
  copy,
  agent,
  saving,
  onClose,
  onSave,
}: {
  editing: Editing;
  view: MemoryFileView | null;
  copy: Copy;
  agent: string;
  saving: boolean;
  onClose: () => void;
  onSave: (text: string) => Promise<string | null>;
}) {
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  const key = editing ? `${editing.file}:${editing.index ?? 'new'}` : null;
  // A new entry starts empty, an edit from the entry's text.
  if (key && shown !== key) {
    setShown(key);
    setText(editing && view && editing.index !== null ? (memoryFileEntries(view)[editing.index] ?? '') : '');
    setProblem(null);
  }
  const close = () => {
    setShown(null);
    onClose();
  };
  const save = async () => {
    if (!editing || !view) return;
    const clean = text.trim();
    if (!clean && editing.index === null) return close();
    const before = editing.index === null ? null : memoryFileEntries(view)[editing.index];
    if (clean === before) return close();
    const rest = editing.index === null ? view : { ...view, text: memoryWithout(view, editing.index) };
    if (clean && !memoryEntryFits(rest, clean)) return setProblem(copy.full);
    const said = await onSave(clean);
    if (said) setProblem(said);
    else close();
  };
  const title = editing?.file === 'user' ? copy.user : copy.memory;
  return (
    <Sheet
      visible={editing !== null}
      onClose={close}
      title={title}
      label={editing?.index === null ? MEMORY_TEXT.add : copy.edit}
    >
      <View style={{ paddingHorizontal: 22, gap: 12 }}>
        <FormField
          label={editing?.index === null ? MEMORY_TEXT.add : copy.edit}
          value={text}
          onChangeText={(next) => {
            setText(next);
            if (problem) setProblem(null);
          }}
          multiline
          placeholder={editing ? MEMORY_TEXT.placeholder(editing.file, agent) : undefined}
          autoFocus
        />
        <FormMessage text={problem} />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label={copy.cancel} variant="secondary" onPress={close} style={{ flex: 1 }} />
          <Button label={copy.save} busy={saving} onPress={() => void save()} style={{ flex: 1 }} />
        </View>
      </View>
    </Sheet>
  );
}
