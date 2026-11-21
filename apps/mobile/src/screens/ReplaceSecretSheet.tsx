/**
 * Replace a Vault entry's secret on Android (AP-718; the web's SECRET → Replace, docs/decisions/vault.md VT-04, VT-71):
 * the new secret in a write-only field, and for basic auth or a website login the username with it. The value lives
 * only while the sheet is open (cleared on Save and on close), is never logged and never goes into navigation params.
 */
import { useVaultWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import { VAULT_COPY, VAULT_SECRET_MAX, type VaultAuth } from '@whombat/core/vault';
import { useState } from 'react';
import { Alert, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import {
  type FieldProblems,
  replaceProblemOf,
  replaceSecretModel,
  setSecretBody,
  VAULT_FORM_TEXT,
} from '../data/vaultForm';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import { Button } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { outcomeText, showNotice } from './feedback';

export interface ReplaceTarget {
  entryId: string;
  name: string;
  auth: VaultAuth | null;
}

export function ReplaceSecretSheet({
  target,
  onClose,
}: {
  target: ReplaceTarget | null;
  onClose: () => void;
}) {
  return (
    <Sheet visible={target !== null} onClose={onClose} title={VAULT_COPY.secret} label={VAULT_COPY.replace}>
      {target ? <ReplaceForm target={target} onClose={onClose} /> : null}
    </Sheet>
  );
}

function ReplaceForm({ target, onClose }: { target: ReplaceTarget; onClose: () => void }) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const setSecret = useVaultWrite(api.vault.setSecret, slug);
  const model = replaceSecretModel(target.auth);
  const [value, setValue] = useState('');
  const [username, setUsername] = useState(model.username);
  const [problems, setProblems] = useState<FieldProblems>({});
  const [message, setMessage] = useState<string | null>(null);

  const save = async () => {
    if (setSecret.isPending) return;
    if (!value) return setProblems({ secret: 'Paste the secret.' });
    setProblems({});
    setMessage(null);
    try {
      const result = await setSecret.mutateAsync({
        params: { burrow: slug, entryId: target.entryId },
        body: setSecretBody(target.auth, value, username),
      });
      if (result.status !== 'ok') {
        const text = outcomeText(result);
        if (text) Alert.alert(text.title, text.body);
        return;
      }
      setValue('');
      showNotice(VAULT_FORM_TEXT.secretReplaced);
      onClose();
    } catch (error) {
      const p = replaceProblemOf(error);
      setProblems(p.fields);
      setMessage(p.message);
    }
  };

  return (
    <View style={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}>
      <View style={{ gap: 4 }}>
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          {`${VAULT_COPY.replace} · ${target.name}`}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.mut}>
          {VAULT_FORM_TEXT.replaceHint}
        </Text>
      </View>
      {model.withUsername ? (
        <FormField
          label={VAULT_FORM_TEXT.username}
          value={username}
          onChangeText={setUsername}
          error={problems.username}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
        />
      ) : null}
      <FormField
        label={model.label}
        value={value}
        onChangeText={(v) => {
          setValue(v);
          setMessage(null);
        }}
        error={problems.secret}
        hint={VAULT_FORM_TEXT.secretHint}
        secret
        autoFocus
        maxLength={VAULT_SECRET_MAX}
        placeholder={VAULT_FORM_TEXT.secretPlaceholder}
      />
      <FormMessage text={message} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label={VAULT_FORM_TEXT.cancel}
          variant="secondary"
          disabled={setSecret.isPending}
          onPress={onClose}
          style={{ flex: 1 }}
        />
        <Button
          label={VAULT_FORM_TEXT.save}
          busy={setSecret.isPending}
          disabled={!value}
          onPress={() => void save()}
          style={{ flex: 1 }}
        />
      </View>
    </View>
  );
}
