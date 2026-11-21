/**
 * “Web search” in Settings → Advanced → AI on this Whombat (Whombat web-search.md), under “A model on your network” and
 * drawn as it is: the 20dp card on `sf`, the name in the head, 13dp muted lines, 44dp buttons. The person's whole job
 * is to open Brave's API keys page, copy a key, paste it and Save. Off: the hint and the steps, “Get a Brave Search
 * key” (Brave's page in the browser), “No account yet? Sign up”, the key field and Save; a key Brave turns away says so
 * under the field. On: the dot, “On, with your Brave Search key.”, what the last check found, and Check again, Use
 * another key (the field again, with Cancel) and Remove (which asks first). The key is never shown again.
 */
import {
  BRAVE_SEARCH_KEYS_URL,
  BRAVE_SEARCH_SIGNUP_URL,
  WEB_SEARCH_COPY,
  type WebSearchView,
} from '@whombat/core';
import { type ReactNode, useState } from 'react';
import { Alert, View } from 'react-native';
import { useBurrow } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { useClearWebSearch, useSetWebSearch, useTestWebSearch } from '../data/useWebSearch';
import { openOutside, TextLink } from '../screens/connect/parts';
import { errorText, outcomeText, showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import { Button, StatusDot } from '../ui/primitives';
import { type WebSearchTone, webSearchCheckLine, webSearchKeyProblem, webSearchWords } from './webSearch';

/** A row of buttons each as wide as its word, the rest of the width shared (“Use another key” isn't cut). */
const GROW = { flexGrow: 1 } as const;
const CANCEL = 'Cancel';

function toneColor(theme: ReturnType<typeof useTheme>, tone: WebSearchTone): string {
  return tone === 'ok'
    ? theme.colors.ok
    : tone === 'warn'
      ? theme.colors.warn
      : tone === 'bad'
        ? theme.colors.bad
        : theme.colors.mut;
}

/** What a write's outcome says when it didn't go through; null when it did. */
function refusalOf(result: Parameters<typeof outcomeText>[0]): string | null {
  const text = outcomeText(result);
  return text ? `${text.title}. ${text.body}` : null;
}

export function WebSearchCard() {
  const theme = useTheme();
  const { slug, bootstrap } = useBurrow();
  const view = bootstrap.burrow.webSearch ?? null;
  const words = webSearchWords(useAgentWords());
  return (
    <Card>
      {view ? (
        <On slug={slug} view={view} hint={words.hint} removeBody={words.removeBody} />
      ) : (
        <>
          <Head hint={words.hint} />
          <Text size={13} lh={1.45} color={theme.colors.ink2}>
            {WEB_SEARCH_COPY.steps}
          </Text>
          <Button
            label={WEB_SEARCH_COPY.getKey}
            accessibilityHint="Opens Brave’s API keys page in your browser"
            onPress={() => openOutside(BRAVE_SEARCH_KEYS_URL)}
          />
          <TextLink
            label={WEB_SEARCH_COPY.signUp}
            external
            onPress={() => openOutside(BRAVE_SEARCH_SIGNUP_URL)}
          />
          <KeyForm slug={slug} onDone={() => {}} />
        </>
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

/** The card's head: the dot while it is on (what the last check found) and the section's name, then its sentence. */
function Head({ hint, dot }: { hint: string; dot?: { tone: WebSearchTone; label: string } }) {
  const theme = useTheme();
  return (
    <>
      <View
        accessible
        accessibilityRole="header"
        accessibilityLabel={dot ? `${WEB_SEARCH_COPY.title}. ${dot.label}` : WEB_SEARCH_COPY.title}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
      >
        {dot ? <StatusDot color={toneColor(theme, dot.tone)} label={dot.label} /> : null}
        <Text size={15.5} weight={600}>
          {WEB_SEARCH_COPY.title}
        </Text>
      </View>
      <Text size={13} lh={1.45} color={theme.colors.mut}>
        {hint}
      </Text>
    </>
  );
}

function On({
  slug,
  view,
  hint,
  removeBody,
}: {
  slug: string;
  view: WebSearchView;
  hint: string;
  removeBody: string;
}) {
  const theme = useTheme();
  const [replacing, setReplacing] = useState(false);
  const test = useTestWebSearch(slug);
  const clear = useClearWebSearch(slug);
  const [problem, setProblem] = useState<string | null>(null);
  const line = webSearchCheckLine(view.check);
  const status = line.text ?? WEB_SEARCH_COPY.on;
  const checkAgain = () => {
    setProblem(null);
    test.mutate(
      { params: { burrow: slug } },
      {
        onSuccess: (r) => setProblem(refusalOf(r)),
        onError: (e) => setProblem(errorText(e)),
      },
    );
  };
  const remove = () =>
    Alert.alert(WEB_SEARCH_COPY.removeTitle, removeBody, [
      { text: CANCEL, style: 'cancel' },
      {
        text: WEB_SEARCH_COPY.remove,
        style: 'destructive',
        onPress: () => {
          setProblem(null);
          clear.mutate(
            { params: { burrow: slug } },
            {
              onSuccess: (r) => {
                const refused = refusalOf(r);
                if (refused) setProblem(refused);
                else showNotice(WEB_SEARCH_COPY.removed);
              },
              onError: (e) => setProblem(errorText(e)),
            },
          );
        },
      },
    ]);
  const busy = test.isPending || clear.isPending;
  return (
    <>
      <Head hint={hint} dot={{ tone: line.tone, label: status }} />
      <View
        accessible
        accessibilityLabel={line.text ? `${WEB_SEARCH_COPY.on} ${line.text}` : WEB_SEARCH_COPY.on}
        style={{ gap: 3 }}
      >
        <Text size={15} weight={600}>
          {WEB_SEARCH_COPY.on}
        </Text>
        {line.text ? (
          <Text
            size={13}
            lh={1.45}
            color={line.tone === 'ok' ? theme.colors.mut : theme.colors.ink2}
            accessibilityLiveRegion="polite"
          >
            {line.text}
          </Text>
        ) : null}
      </View>
      <FormMessage text={problem} />
      {replacing ? (
        <KeyForm slug={slug} onDone={() => setReplacing(false)} onCancel={() => setReplacing(false)} />
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          <Button
            label={WEB_SEARCH_COPY.checkAgain}
            variant="secondary"
            busy={test.isPending}
            disabled={busy}
            onPress={checkAgain}
            style={GROW}
          />
          <Button
            label={WEB_SEARCH_COPY.replace}
            variant="secondary"
            disabled={busy}
            onPress={() => {
              setProblem(null);
              setReplacing(true);
            }}
            style={GROW}
          />
          <Button
            label={WEB_SEARCH_COPY.remove}
            variant="secondary"
            busy={clear.isPending}
            disabled={busy}
            accessibilityLabel={`${WEB_SEARCH_COPY.remove} ${WEB_SEARCH_COPY.title.toLowerCase()}`}
            onPress={remove}
            style={GROW}
          />
        </View>
      )}
    </>
  );
}

/** The key field and Save (and Cancel while replacing a saved key). Save checks the key with Brave first. */
function KeyForm({ slug, onDone, onCancel }: { slug: string; onDone: () => void; onCancel?: () => void }) {
  const set = useSetWebSearch(slug);
  const [key, setKey] = useState('');
  const [keyProblem, setKeyProblem] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const empty = key.trim() === '';
  const save = () => {
    if (empty) return;
    setKeyProblem(null);
    setProblem(null);
    set.mutate(
      { params: { burrow: slug }, body: { apiKey: key.trim() } },
      {
        onSuccess: (r) => {
          const refused = refusalOf(r);
          if (refused) return setProblem(refused);
          setKey('');
          showNotice(WEB_SEARCH_COPY.saved);
          onDone();
        },
        onError: (e) => {
          const onKey = webSearchKeyProblem(e);
          if (onKey) setKeyProblem(onKey);
          else setProblem(errorText(e));
        },
      },
    );
  };
  return (
    <>
      <FormField
        label={WEB_SEARCH_COPY.apiKey}
        value={key}
        onChangeText={(value) => {
          setKey(value);
          setKeyProblem(null);
        }}
        error={keyProblem}
        mono
        secret
        autoCapitalize="none"
        autoCorrect={false}
        editable={!set.isPending}
        returnKeyType="done"
        onSubmitEditing={save}
      />
      <FormMessage text={problem} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        {onCancel ? (
          <Button label={CANCEL} variant="quiet" disabled={set.isPending} onPress={onCancel} style={GROW} />
        ) : null}
        <Button
          label={WEB_SEARCH_COPY.save}
          busy={set.isPending}
          disabled={empty}
          accessibilityLabel={`${WEB_SEARCH_COPY.save} ${WEB_SEARCH_COPY.apiKey}`}
          onPress={save}
          style={GROW}
        />
      </View>
    </>
  );
}
