/**
 * *Add a screen* on the phone (Whombat desk-display.md DK-137, DK-146; desk-display-android.md AP-6001, AP-6002; the
 * mockups' `f-add`): a sheet — what to do on the tablet or computer, the six letters it shows in six boxes (one field
 * under them: the keyboard types capitals, a space or a dot from “KTR · MWP” is dropped), what to call it, *What pops
 * up on it* (*Problems only* first, as a screen elsewhere starts) and *Start with* a copy of this Whombat's screen or an
 * empty page; *Add screen*, and the refusal in words when the letters are wrong or ran out. In the demo world, which
 * has no tablet to read them from, the letters its tablet shows are said under the boxes.
 */
import {
  type DeskApi,
  type DeskPopups,
  deskScreensText,
  fillDeskWords,
  screensErrorText,
} from '@whombat/client/desk';
import { useDeskScreenActions } from '@whombat/client/desk/react';
import { useEffect, useState } from 'react';
import { ScrollView, TextInput, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { toasts } from '../../data/toast';
import { useAgentWords } from '../../data/useAgent';
import { demoDesk } from '../../fixtures/desk';
import { useI18n } from '../../i18n';
import { ErrorLine, Field } from '../../managed/ui';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Button, SectionLabel } from '../../ui/primitives';
import { Segmented } from '../../ui/Segmented';
import { Sheet } from '../../ui/sheet';
import { lettersProblem, popupOptions, screenLetters, screenName } from './screensList';
import { phoneScreensText } from './tiles';

export function AddScreenSheet({
  api,
  visible,
  onClose,
}: {
  api: DeskApi;
  visible: boolean;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();
  const T = deskScreensText(rawLocale).addDialog;
  const theme = useTheme();
  const assistant = useAgentWords().name;
  const { mode, me } = useBurrowBase();
  const actions = useDeskScreenActions(api);
  const [letters, setLetters] = useState('');
  const [name, setName] = useState('');
  const [popups, setPopups] = useState<DeskPopups>('problems');
  const [start, setStart] = useState<'copy' | 'empty'>('copy');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new sheet each time it opens.
  useEffect(() => {
    if (!visible) return;
    setLetters('');
    setName('');
    setPopups('problems');
    setStart('copy');
    setError(null);
  }, [visible]);
  const demoLetters = visible && mode === 'fixtures' ? demoDesk({ me }).waitingLetters() : null;
  const submit = () => {
    const problem = lettersProblem(letters);
    if (problem === 'short') return setError(T.needLetters);
    const clean = screenName(name);
    if (!clean) return setError(T.needName);
    if (problem === 'io') return setError(phoneScreensText(rawLocale).lettersIo);
    setBusy(true);
    setError(null);
    actions.add({ code: letters, name: clean, popups, start }).then(
      (screen) => {
        setBusy(false);
        onClose();
        toasts.show(fillDeskWords(T.added, { name: screen.name }));
      },
      (e: unknown) => {
        setBusy(false);
        setError(screensErrorText(e, undefined, rawLocale));
      },
    );
  };
  const popupHint = popups === 'problems' ? T.popupsHint : deskScreensText(rawLocale).page.popupsHint[popups];
  return (
    <Sheet visible={visible} onClose={onClose} label={T.title} maxHeight="92%">
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 8, gap: 16 }}
      >
        <View style={{ gap: 6 }}>
          <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
            {T.title}
          </Text>
          <Text size={14} lh={1.5} color={theme.colors.mut}>
            {T.intro1}
            <Text size={14} lh={1.5} weight={600}>
              {T.useAsScreen}
            </Text>
            {T.intro2}
          </Text>
        </View>
        <View style={{ gap: 6 }}>
          <LetterBoxes value={letters} onChange={(v) => setLetters(screenLetters(v))} />
          {demoLetters ? (
            <Text size={12.5} color={theme.colors.mut} style={{ paddingHorizontal: 2 }}>
              {fillDeskWords(phoneScreensText(rawLocale).demoLetters, {
                letters: `${demoLetters.slice(0, 3)} · ${demoLetters.slice(3)}`,
              })}
            </Text>
          ) : null}
        </View>
        <Field
          label={T.name}
          value={name}
          onChangeText={setName}
          placeholder={T.namePlaceholder}
          autoCapitalize="sentences"
          maxLength={60}
          returnKeyType="done"
        />
        <View style={{ gap: 8 }}>
          <SectionLabel>{T.popups.toUpperCase()}</SectionLabel>
          <Segmented<DeskPopups>
            options={popupOptions(rawLocale)}
            value={popups}
            onChange={setPopups}
            label={T.popups}
            lines={2}
          />
          <Text size={13} lh={1.4} color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
            {fillDeskWords(popupHint, { assistant })}
          </Text>
        </View>
        <View style={{ gap: 8 }}>
          <SectionLabel>{T.start.toUpperCase()}</SectionLabel>
          <Segmented<'copy' | 'empty'>
            options={[
              { value: 'copy', label: T.copy },
              { value: 'empty', label: T.empty },
            ]}
            value={start}
            onChange={setStart}
            label={T.start}
            lines={2}
          />
        </View>
        <ErrorLine text={error} />
        <View style={{ gap: 6 }}>
          <Button label={busy ? T.adding : T.submit} size="lg" busy={busy} onPress={submit} />
          <Button label={T.cancel} variant="quiet" onPress={onClose} />
        </View>
      </ScrollView>
    </Sheet>
  );
}

/**
 * The six boxes (the mockups' `f-add`): one field over them takes the typing — TalkBack reads it as “The six letters”
 * with what's typed — and the boxes show each letter, the next one to type outlined.
 */
function LetterBoxes({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const { rawLocale } = useI18n();
  const T = deskScreensText(rawLocale).addDialog;
  const theme = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View>
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: 'row', gap: 8 }}
      >
        {Array.from({ length: 6 }, (_, i) => {
          const next = focused && i === Math.min(value.length, 5);
          return (
            <View
              // biome-ignore lint/suspicious/noArrayIndexKey: the six boxes are places, not items
              key={i}
              style={{
                flex: 1,
                height: 54,
                borderRadius: 12,
                borderWidth: next ? 2 : 1,
                borderColor: next ? theme.colors.ink : theme.colors.line2,
                backgroundColor: theme.colors.sf,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text size={22} weight={600} mono>
                {value[i] ?? ''}
              </Text>
            </View>
          );
        })}
      </View>
      <TextInput
        value={value}
        onChangeText={onChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        accessibilityLabel={T.letters}
        autoCapitalize="characters"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        caretHidden
        contextMenuHidden
        // All but unseen, yet there: it takes the touches and the typing. Android draws a transparent text colour anyway,
        // and hides a view at opacity 0 from TalkBack.
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 54, opacity: 0.02 }}
      />
    </View>
  );
}
