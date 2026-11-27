/**
 * The notes in the assistant's Memory part (mobile-parity.md MQ-01; one-agent.md AP-4970; hermes-engine-app.md AP-5272;
 * the web's Notes in Memory; Whombat hermes-engine.md HE-39; one-person-android.md AP-5762): what the agent should know
 * in every chat — one text you write, how much of its 1,500 characters it uses and when you changed it last — edited
 * in a sheet (the count, Save and Cancel). Beside what it remembers about you, so what it knows is in one place.
 */

import { memoryText } from '@whombat/client';
import { useAgentNotes, useSetAgentNotes } from '@whombat/client/react';
import { memoryUsageText } from '@whombat/core';
import { useState } from 'react';
import { View } from 'react-native';
import { notesCopy, notesCount, notesEdit, notesMeta } from '../../data/agentParity';
import { useBurrowBase, useNow } from '../../data/BurrowProvider';
import { useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { RowButtons } from '../../ui/facts';
import { FormField, FormMessage } from '../../ui/formField';
import { Button, ErrorState, Section, SkeletonRows } from '../../ui/primitives';
import { Sheet } from '../../ui/sheet';
import { errorText, showNotice } from '../feedback';
import type { PartProps } from './parts';

export function NotesSection({ profile }: Pick<PartProps, 'profile'>) {
  const { rawLocale } = useI18n();
  const memoryTextHere = memoryText(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { slug, timeZone } = useBurrowBase();
  const now = useNow();
  const copy = notesCopy(profile.agent.name, rawLocale);
  const query = useAgentNotes({ params: { burrow: slug } });
  const save = useSetAgentNotes(slug);
  const [editing, setEditing] = useState(false);
  const data = query.data;
  const meta = data ? notesMeta(data, timeZone, now, rawLocale) : null;

  return (
    <>
      <View style={{ paddingTop: 10 }}>
        <View style={{ paddingHorizontal: 22, paddingBottom: 14, gap: 6 }}>
          <Text size={15} lh={1.5} color={theme.colors.ink2}>
            {copy.intro}
          </Text>
          {data ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {memoryUsageText(data.used, data.limit, rawLocale)}
            </Text>
          ) : null}
        </View>
        {!data ? (
          query.error ? (
            <ErrorState text={memoryTextHere.loadFailed} onRetry={() => void query.refetch()} />
          ) : (
            <SkeletonRows count={2} lines={1} label={tMobile('screens.loading-the-notes')} />
          )
        ) : (
          <Section title={copy.title}>
            <View style={{ gap: 6, paddingVertical: 14, paddingHorizontal: 16 }}>
              <View
                accessible
                accessibilityLabel={[data.text || copy.empty, meta].filter(Boolean).join('. ')}
                style={{ gap: 4 }}
              >
                <Text size={15} lh={1.45} color={data.text ? theme.colors.ink : theme.colors.mut}>
                  {data.text || copy.empty}
                </Text>
                {meta ? (
                  <Text size={11.5} mono color={theme.colors.mut}>
                    {meta}
                  </Text>
                ) : null}
              </View>
              <RowButtons>
                <Button
                  label={copy.edit}
                  variant="secondary"
                  disabled={save.isPending}
                  onPress={() => setEditing(true)}
                  style={{ paddingHorizontal: 18 }}
                />
              </RowButtons>
            </View>
          </Section>
        )}
      </View>
      <NotesEditor
        visible={editing}
        text={data?.text ?? ''}
        copy={copy}
        saving={save.isPending}
        onClose={() => setEditing(false)}
        onSave={(text) =>
          new Promise<string | null>((resolve) =>
            save.mutate(
              { params: { burrow: slug }, body: { text } },
              {
                onSuccess: (result) => {
                  if (result.status !== 'ok') return resolve(memoryTextHere.failed);
                  showNotice(memoryTextHere.notesSaved);
                  resolve(null);
                },
                onError: (error) => resolve(errorText(error, rawLocale)),
              },
            ),
          )
        }
      />
    </>
  );
}

/** Edit the notes: their text in a box, the count, Save and Cancel. */
function NotesEditor({
  visible,
  text: saved,
  copy,
  saving,
  onClose,
  onSave,
}: {
  visible: boolean;
  text: string;
  copy: ReturnType<typeof notesCopy>;
  saving: boolean;
  onClose: () => void;
  onSave: (text: string) => Promise<string | null>;
}) {
  const { rawLocale } = useI18n();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  // Opening starts from the saved notes.
  if (visible && !shown) {
    setShown(true);
    setText(saved);
    setProblem(null);
  }
  const close = () => {
    setShown(false);
    onClose();
  };
  const save = async () => {
    const edit = notesEdit(saved, text, rawLocale);
    if (edit.kind === 'too_long') return setProblem(edit.problem);
    if (edit.kind === 'unchanged') return close();
    const result = await onSave(edit.text);
    if (result) setProblem(result);
    else close();
  };
  return (
    <Sheet visible={visible} onClose={close} title={copy.title} label={copy.edit}>
      <View style={{ paddingHorizontal: 22, gap: 12 }}>
        <FormField
          label={copy.tab}
          value={text}
          onChangeText={(next) => {
            setText(next);
            if (problem) setProblem(null);
          }}
          multiline
          placeholder={copy.placeholder}
          hint={notesCount(text, rawLocale)}
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
