/**
 * Tailscale's login server, in a sheet (contracts CT-1306; Whombat hermes-engine.md HE-64; hermes-engine-app.md
 * AP-5476): on a community box you name Headscale or a company's server instead of Tailscale's own — or empties the
 * field for Tailscale's own again. Moving servers signs the box out of its tailnet and starts a fresh sign-in there, so
 * the sheet says that before Save; plain `http://` is said to be fine on your own network. Checked with the
 * shared `readLoginServer`; its words are `TAILSCALE_TEXT`'s. Every target 44dp.
 */

import { readLoginServer, TAILSCALE_TEXT, tailscaleErrorText } from '@whombat/client';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { ErrorLine, Field, Note } from './ui';

const T = TAILSCALE_TEXT;

export function LoginServerSheet({
  visible,
  current,
  onClose,
  onSave,
}: {
  visible: boolean;
  /** The box's login server now (null: Tailscale's own). */
  current: string | null;
  onClose: () => void;
  /** Turns Tailscale on at `server` (null: Tailscale's own); rejects with what went wrong. */
  onSave: (server: string | null) => Promise<void>;
}) {
  const { tClient } = useI18n();
  const theme = useTheme();
  const [text, setText] = useState(current ?? '');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setText(current ?? '');
    setProblem(null);
  }, [visible, current]);
  const read = readLoginServer(text);
  const save = async () => {
    if (!read.ok) return setProblem(read.problem);
    if (read.value === current) return onClose();
    setBusy(true);
    setProblem(null);
    try {
      await onSave(read.value);
      onClose();
    } catch (error) {
      setProblem(tailscaleErrorText(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet visible={visible} onClose={onClose} label={T.changeTitle} closeLabel={tClient('reports.cancel')}>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}
      >
        <View style={{ gap: 4 }}>
          <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
            {T.changeTitle}
          </Text>
          <Text size={13.5} lh={1.45} color={theme.colors.mut}>
            {T.changeLead}
          </Text>
        </View>
        <Field
          label={T.field}
          hint={T.fieldHint}
          value={text}
          onChangeText={(v) => {
            setText(v);
            setProblem(null);
          }}
          mono
          placeholder="https://headscale.example.com"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          keyboardType="url"
          onSubmitEditing={() => void save()}
        />
        {read.ok && read.plainHttp ? <Note text={T.plainHttp} /> : null}
        <ErrorLine text={problem} />
        {read.ok && read.value !== current ? <Note text={T.moves} /> : null}
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={tClient('reports.cancel')}
            variant="secondary"
            onPress={onClose}
            style={{ flex: 1 }}
          />
          <Button label={T.save} busy={busy} onPress={() => void save()} style={{ flex: 1 }} />
        </View>
      </ScrollView>
    </Sheet>
  );
}
