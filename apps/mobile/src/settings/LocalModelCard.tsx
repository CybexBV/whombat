/**
 * “A model on your network” in Settings → Advanced → AI on this Whombat (Whombat hermes-engine.md HE-32; contracts
 * 0.124 CT-1170…CT-1175; hermes-engine-app.md AP-5124, AP-5125): no mock, so it is drawn as the provider cards — the 20dp
 * card on `sf`, the dot and the name in the head, 13dp muted lines, 44dp buttons. On a runtime with `ai.local_model`
 * it shows always: a saved model is its name, “model · address” and what its last test found, with Check again, Change
 * and Remove (which asks first); none saved, or Change, is the form — Address, Model, Name (optional), API key
 * (optional, never shown again) with the contracts' hints — and Test and Save (Cancel while changing). Every rule is
 * `@whombat/client`'s `localModel.ts`, shared with the web.
 */

import {
  type LocalModelDraft,
  type LocalModelField,
  type LocalModelTone,
  localModelCheckLine,
  localModelDraft,
  localModelFields,
  localModelKeyChoice,
  localModelOf,
  localModelProblems,
  localModelRow,
  localModelSaved,
  localModelSetBody,
  localModelTestBody,
  localModelText,
} from '@whombat/client';
import { useClearLocalModel, useSetLocalModel, useTestLocalModel } from '@whombat/client/react';
import { type LocalModelCheck, type LocalModelView, localModelCopy } from '@whombat/core';
import { type ReactNode, useState } from 'react';
import { Alert, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { useI18n } from '../i18n';
import { errorText, outcomeText, showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import { Button, StatusDot } from '../ui/primitives';

/** A row of buttons each as wide as its word, the rest of the width shared (“Check again” isn't cut). */
const GROW = { flexGrow: 1 } as const;

function toneColor(theme: ReturnType<typeof useTheme>, tone: LocalModelTone): string {
  return tone === 'ok'
    ? theme.colors.ok
    : tone === 'warn'
      ? theme.colors.warn
      : tone === 'bad'
        ? theme.colors.bad
        : theme.colors.mut;
}

/** What a write's outcome says when it didn't go through; null when it did. */
function refusalOf(result: Parameters<typeof outcomeText>[0], locale: string): string | null {
  const text = outcomeText(result, locale);
  return text ? `${text.title}. ${text.body}` : null;
}

export function LocalModelCard() {
  const { slug, bootstrap } = useBurrow();
  const view = localModelOf(bootstrap.burrow);
  const [editing, setEditing] = useState(false);
  const [mismatch, setMismatch] = useState<string | null>(null);
  return (
    <Card>
      {view && !editing ? (
        <Saved
          slug={slug}
          view={view}
          notice={mismatch}
          onChange={() => {
            setMismatch(null);
            setEditing(true);
          }}
        />
      ) : (
        <Form
          slug={slug}
          view={view}
          onStart={() => setMismatch(null)}
          onMismatch={(msg) => {
            setMismatch(msg);
            setEditing(false);
          }}
          onDone={() => {
            setMismatch(null);
            setEditing(false);
          }}
        />
      )}
    </Card>
  );
}

function Card({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <View
      style={{
        borderRadius: 20,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
        paddingHorizontal: 16,
        paddingTop: 14,
        paddingBottom: 14,
        gap: 10,
      }}
    >
      {children}
    </View>
  );
}

/** The card's head: the dot (what the last test found) and the section's name, then its one sentence. */
function Head({ tone, status }: { tone: LocalModelTone; status: string }) {
  const { rawLocale } = useI18n();
  const localModelCopyHere = localModelCopy(rawLocale);

  const theme = useTheme();
  return (
    <>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={`${localModelCopyHere.title}. ${status}`}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        <StatusDot color={toneColor(theme, tone)} label={status} />
        <Text size={15.5} weight={600}>
          {localModelCopyHere.title}
        </Text>
      </View>
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        {localModelCopyHere.hint}
      </Text>
    </>
  );
}

function Saved({
  slug,
  view,
  notice,
  onChange,
}: {
  slug: string;
  view: LocalModelView;
  notice?: string | null;
  onChange: () => void;
}) {
  const { rawLocale } = useI18n();
  const localModelCopyHere = localModelCopy(rawLocale);

  const theme = useTheme();
  const test = useTestLocalModel(slug);
  const clear = useClearLocalModel(slug);
  const [problem, setProblem] = useState<string | null>(null);
  const row = localModelRow(view);
  const line = test.isPending
    ? { text: localModelText(rawLocale).testing, tone: 'mut' as const }
    : localModelCheckLine(view.check, view.model, rawLocale);
  const checkAgain = () => {
    setProblem(null);
    test.mutate(
      { params: { burrow: slug }, body: {} },
      {
        onSuccess: (r) => setProblem(refusalOf(r, rawLocale)),
        onError: (e) => setProblem(errorText(e, rawLocale)),
      },
    );
  };
  const remove = () =>
    Alert.alert(localModelCopyHere.removeTitle, localModelCopyHere.removeBody, [
      { text: localModelText(rawLocale).cancel, style: 'cancel' },
      {
        text: localModelCopyHere.remove,
        style: 'destructive',
        onPress: () => {
          setProblem(null);
          clear.mutate(
            { params: { burrow: slug } },
            {
              onSuccess: (r) => {
                const refused = refusalOf(r, rawLocale);
                if (refused) return setProblem(refused);
                if (r.status === 'ok' && r.data.burrow.localModel != null)
                  return setProblem(localModelText(rawLocale).failed);
                showNotice(localModelCopyHere.removed);
              },
              onError: (e) => setProblem(errorText(e, rawLocale)),
            },
          );
        },
      },
    ]);
  const busy = test.isPending || clear.isPending;
  return (
    <>
      <Head tone={line.tone} status={line.text} />
      <View accessible accessibilityLabel={`${row.name}. ${row.meta}. ${line.text}`} style={{ gap: 3 }}>
        <Text size={15} weight={600}>
          {row.name}
        </Text>
        <Text size={13} mono color={theme.colors.ink2} numberOfLines={2}>
          {row.meta}
        </Text>
        <Text
          size={13}
          lh={1.45}
          color={line.tone === 'ok' || line.tone === 'mut' ? theme.colors.mut : theme.colors.ink2}
        >
          {line.text}
        </Text>
      </View>
      <FormMessage text={problem ?? notice ?? null} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label={localModelCopyHere.checkAgain}
          variant="secondary"
          busy={test.isPending}
          disabled={busy}
          onPress={checkAgain}
          style={GROW}
        />
        <Button
          label={localModelText(rawLocale).change}
          variant="secondary"
          disabled={busy}
          onPress={onChange}
          style={GROW}
        />
        <Button
          label={localModelCopyHere.remove}
          variant="secondary"
          busy={clear.isPending}
          disabled={busy}
          accessibilityLabel={`${localModelCopyHere.remove} ${row.name}`}
          onPress={remove}
          style={GROW}
        />
      </View>
    </>
  );
}

/** The form's fields as TextInput takes them: what the keyboard offers and whether a value is masked. */
const FIELD_INPUT: Record<LocalModelField, { mono: boolean; secret: boolean; url: boolean; raw: boolean }> = {
  baseUrl: { mono: true, secret: false, url: true, raw: true },
  model: { mono: true, secret: false, url: false, raw: true },
  label: { mono: false, secret: false, url: false, raw: false },
  apiKey: { mono: true, secret: true, url: false, raw: true },
};

function Form({
  slug,
  view,
  onStart,
  onMismatch,
  onDone,
}: {
  slug: string;
  view: LocalModelView | null;
  onStart: () => void;
  onMismatch: (message: string) => void;
  onDone: () => void;
}) {
  const { rawLocale } = useI18n();
  const localModelCopyHere = localModelCopy(rawLocale);

  const theme = useTheme();
  const set = useSetLocalModel(slug);
  const test = useTestLocalModel(slug);
  const [draft, setDraft] = useState<LocalModelDraft>(() => localModelDraft(view));
  const [tried, setTried] = useState(false);
  const [found, setFound] = useState<{ check: LocalModelCheck; model: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const problems = localModelProblems(draft, rawLocale);
  const blocked = Object.keys(problems).length > 0;
  const keyKept = localModelKeyChoice(draft, view) === 'keep';
  const edit = (field: LocalModelField, value: string) => {
    setDraft((d) => ({ ...d, [field]: value }));
    setFound(null);
  };
  const run = () => {
    setTried(true);
    setProblem(null);
    if (blocked) return;
    const model = draft.model.trim();
    test.mutate(
      { params: { burrow: slug }, body: localModelTestBody(draft, view) },
      {
        onSuccess: (r) => {
          if (r.status === 'ok') setFound({ check: r.data.check, model });
          else setProblem(refusalOf(r, rawLocale));
        },
        onError: (e) => setProblem(errorText(e, rawLocale)),
      },
    );
  };
  const save = () => {
    setTried(true);
    setProblem(null);
    onStart();
    if (blocked) return;
    const body = localModelSetBody(draft, view);
    set.mutate(
      { params: { burrow: slug }, body },
      {
        onSuccess: (r) => {
          const refused = refusalOf(r, rawLocale);
          if (refused) return setProblem(refused);
          if (r.status !== 'ok' || !localModelSaved(body, r.data.localModel)) {
            setProblem(localModelText(rawLocale).failed);
            onMismatch(localModelText(rawLocale).failed);
            return;
          }
          showNotice(localModelCopyHere.saved);
          onDone();
        },
        onError: (e) => setProblem(errorText(e, rawLocale)),
      },
    );
  };
  const line = test.isPending
    ? { text: localModelText(rawLocale).testing, tone: 'mut' as const }
    : found
      ? localModelCheckLine(found.check, found.model, rawLocale)
      : view
        ? localModelCheckLine(view.check, view.model, rawLocale)
        : { text: localModelText(rawLocale).notTested, tone: 'mut' as const };
  const busy = set.isPending || test.isPending;
  return (
    <>
      <Head tone={line.tone} status={line.text} />
      {localModelFields(rawLocale).map(({ field, label, hint }) => {
        const input = FIELD_INPUT[field];
        return (
          <FormField
            key={field}
            label={label}
            value={draft[field]}
            onChangeText={(value) => edit(field, value)}
            error={tried ? (problems[field] ?? null) : null}
            hint={field === 'apiKey' ? (keyKept ? localModelCopyHere.apiKeySaved : null) : hint}
            mono={input.mono}
            secret={input.secret}
            editable={!busy}
            {...(input.raw ? { autoCapitalize: 'none' as const, autoCorrect: false } : {})}
            {...(input.url ? { keyboardType: 'url' as const, inputMode: 'url' as const } : {})}
          />
        );
      })}
      {found || test.isPending ? (
        <View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={line.text}
          style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
        >
          <View style={{ paddingTop: 5 }}>
            <StatusDot color={toneColor(theme, line.tone)} label={line.text} />
          </View>
          <Text size={13} lh={1.45} color={theme.colors.ink2} style={{ flex: 1 }}>
            {line.text}
          </Text>
        </View>
      ) : null}
      <FormMessage text={problem} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {view ? (
          <Button
            label={localModelText(rawLocale).cancel}
            variant="quiet"
            disabled={busy}
            onPress={onDone}
            style={GROW}
          />
        ) : null}
        <Button
          label={localModelCopyHere.test}
          variant="secondary"
          busy={test.isPending}
          disabled={busy}
          onPress={run}
          style={GROW}
        />
        <Button
          label={localModelCopyHere.save}
          busy={set.isPending}
          disabled={busy}
          onPress={save}
          style={GROW}
        />
      </View>
    </>
  );
}
