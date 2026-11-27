/**
 * The sign-in card's form on the phone (Whombat vault-simplify.md VLT-40…VLT-44; app vault-asks.md AP-6650…): a
 * `server` card's three ways as radio tiles (the key put on first and chosen) with only the chosen way's fields, a
 * website login's optional authenticator key, a code's one field. Every secret is write-only: masked, kept out of
 * autofill and the keyboard's memory, never shown again, and dropped from the form as soon as it was sent, whatever the
 * answer. A private key is pasted from the clipboard or picked with the system's document picker, read as text and the
 * picker's cached copy deleted at once. The words are core's (`VAULT_ASK_TEXT`) and the client's.
 */
import {
  type GuideActInput,
  VAULT_ASK_FIRST_WAY,
  vaultAskKept,
  vaultAskKeyIn,
  vaultAskProblems,
  vaultAskShownFields,
  vaultAskValues,
  vaultAskWays,
} from '@whombat/client';
import { GUIDE_VALUE_MAX } from '@whombat/core/contracts';
import type { GuideField, GuideFormBlock, GuideVaultAsk, GuideVaultServerWay } from '@whombat/core/domain';
import { VAULT_ASK_FIELDS } from '@whombat/core/vault';
import * as Clipboard from 'expo-clipboard';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useAgentWords } from '../data/useAgent';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { textMetrics } from '../theme/type';
import { Check, FileText, Key } from './icons';
import { Button } from './primitives';
import { Touchable } from './Touchable';

/** What an act came to (the guide card's): `ok`, or not, with a form's field errors by id. */
export interface VaultAskOutcome {
  ok: boolean;
  fields?: Record<string, string>;
}

/** A private key file through the system's document picker, read as text and its cached copy deleted at once. */
async function pickKeyFile(): Promise<{ name: string; text: string | null } | null> {
  const result = await DocumentPicker.getDocumentAsync({
    // Private keys rarely have an extension (`id_ed25519`): any file, read as text.
    type: ['*/*'],
    copyToCacheDirectory: true,
    multiple: false,
  });
  const asset = result.canceled ? null : result.assets[0];
  if (!asset) return null;
  const file = new File(asset.uri);
  try {
    if ((asset.size ?? 0) > GUIDE_VALUE_MAX) return { name: asset.name, text: null };
    return { name: asset.name, text: await file.text() };
  } finally {
    // The key never stays on the phone.
    try {
      file.delete();
    } catch {
      // already gone
    }
  }
}

export function VaultAskForm({
  ask,
  block,
  act,
  busy,
}: {
  ask: GuideVaultAsk;
  block: GuideFormBlock;
  act: (input: GuideActInput) => Promise<VaultAskOutcome>;
  busy: boolean;
}) {
  const { rawLocale } = useI18n();
  const vaultAskKeyInHere = vaultAskKeyIn(rawLocale);
  const theme = useTheme();
  const assistant = useAgentWords().name;
  const [way, setWay] = useState<GuideVaultServerWay>(VAULT_ASK_FIRST_WAY);
  const [values, setValues] = useState<Record<string, string>>({});
  const [keyIn, setKeyIn] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const shown = vaultAskShownFields(ask, block, way);

  const set = (id: string, value: string) => {
    setValues((v) => ({ ...v, [id]: value }));
    setErrors(({ [id]: _, ...rest }) => rest);
  };

  const takeKey = (id: string, text: string, label: string) => {
    if (!text.trim()) return setErrors((e) => ({ ...e, [id]: vaultAskKeyInHere.nothing }));
    if (text.length > GUIDE_VALUE_MAX) return setErrors((e) => ({ ...e, [id]: vaultAskKeyInHere.tooBig }));
    set(id, text);
    setKeyIn(label);
  };

  const paste = async (id: string) => {
    let text = '';
    try {
      text = await Clipboard.getStringAsync();
    } catch {
      // nothing to paste
    }
    takeKey(id, text, vaultAskKeyInHere.pasted);
  };

  const pick = async (id: string) => {
    let picked: { name: string; text: string | null } | null;
    try {
      picked = await pickKeyFile();
    } catch {
      return setErrors((e) => ({ ...e, [id]: vaultAskKeyInHere.unreadable }));
    }
    if (!picked) return;
    if (picked.text === null) return setErrors((e) => ({ ...e, [id]: vaultAskKeyInHere.tooBig }));
    takeKey(id, picked.text, vaultAskKeyInHere.file(picked.name));
  };

  const submit = async () => {
    const local = vaultAskProblems(ask, shown, values, rawLocale);
    setErrors(local);
    setMessage(null);
    if (Object.keys(local).length) return;
    const sent = vaultAskValues(ask, shown, values, way);
    // Nothing secret stays on the phone once it went: a wrong password is typed again.
    setValues(vaultAskKept(shown, values));
    setKeyIn(null);
    const outcome = await act({ actionId: block.id, values: sent });
    if (outcome.ok || !outcome.fields) return;
    const ids = new Set(shown.map((f) => f.id));
    const onFields = Object.fromEntries(Object.entries(outcome.fields).filter(([id]) => ids.has(id)));
    setErrors(onFields);
    // A refusal about a field this way doesn't show still says what happened.
    if (Object.keys(onFields).length === 0) setMessage(Object.values(outcome.fields)[0] ?? null);
  };

  return (
    <View style={{ gap: 14 }}>
      {ask.kind === 'server' ? (
        <View accessibilityRole="radiogroup" style={{ gap: 8 }}>
          {vaultAskWays(assistant, rawLocale).map((w) => (
            <WayTile
              key={w.id}
              label={w.label}
              detail={w.detail}
              selected={w.id === way}
              disabled={busy}
              onPress={() => {
                setWay(w.id);
                setErrors({});
                setMessage(null);
              }}
            />
          ))}
        </View>
      ) : null}
      {shown.map((field) => (
        <View key={field.id} style={{ gap: 6 }}>
          <Text size={13} weight={500} color={theme.colors.ink2}>
            {field.optional ? `${field.label} (optional)` : field.label}
          </Text>
          {field.kind === 'key_file' ? (
            <KeyField
              field={field}
              keyIn={keyIn}
              invalid={!!errors[field.id]}
              busy={busy}
              onPaste={() => void paste(field.id)}
              onPick={() => void pick(field.id)}
              onClear={() => {
                set(field.id, '');
                setKeyIn(null);
              }}
            />
          ) : (
            <SecretInput
              field={field}
              value={values[field.id] ?? ''}
              invalid={!!errors[field.id]}
              busy={busy}
              onChange={(v) => set(field.id, v)}
            />
          )}
          <FieldError text={errors[field.id]} />
        </View>
      ))}
      <FieldError text={message ?? undefined} />
      <Button label={block.submitLabel} busy={busy} onPress={() => void submit()} />
    </View>
  );
}

function FieldError({ text }: { text: string | undefined }) {
  const theme = useTheme();
  if (!text) return null;
  return (
    <Text size={12.5} lh={1.4} color={theme.colors.bad} accessibilityLiveRegion="polite">
      {text}
    </Text>
  );
}

/** A way as a tile: the guide's option tile, a radio. */
function WayTile({
  label,
  detail,
  selected,
  disabled,
  onPress,
}: {
  label: string;
  detail: string;
  selected: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const theme = useTheme();
  const green = theme.faces.banjo.accent;
  return (
    <Touchable
      onPress={onPress}
      disabled={disabled}
      feedback="wash"
      ringRadius={12}
      accessibilityRole="radio"
      accessibilityLabel={`${label}, ${detail}`}
      accessibilityState={{ checked: selected, disabled }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 12,
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderRadius: 12,
        borderWidth: 1.5,
        borderColor: selected ? green : theme.colors.line2,
        backgroundColor: theme.colors.bg,
      }}
    >
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={15} weight={600} lh={1.3}>
          {label}
        </Text>
        <Text size={13.5} lh={1.42} color={theme.colors.ink2}>
          {detail}
        </Text>
      </View>
      {selected ? <Check size={20} color={green} strokeWidth={2.25} /> : null}
    </Touchable>
  );
}

/** A text, password, authenticator key or code field: write-only, nothing remembered or offered by the system. */
function SecretInput({
  field,
  value,
  invalid,
  busy,
  onChange,
}: {
  field: GuideField;
  value: string;
  invalid: boolean;
  busy: boolean;
  onChange: (value: string) => void;
}) {
  const theme = useTheme();
  const input = textMetrics({ size: 15 });
  const code = field.id === VAULT_ASK_FIELDS.code;
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={field.placeholder ?? undefined}
      placeholderTextColor={theme.colors.placeholder}
      accessibilityLabel={field.label}
      secureTextEntry={field.kind === 'secret'}
      // A code may be offered from the text message that brought it (iOS, Android); nothing else is autofilled or saved.
      {...(code
        ? { textContentType: 'oneTimeCode' as const, autoComplete: 'one-time-code' as const }
        : {
            textContentType: 'none' as const,
            autoComplete: 'off' as const,
            importantForAutofill: 'no' as const,
          })}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      contextMenuHidden={field.kind === 'secret'}
      editable={!busy}
      selectionColor={theme.colors.brand}
      cursorColor={theme.colors.ink}
      style={{
        minHeight: 44,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: invalid ? theme.colors.bad : theme.colors.line2,
        backgroundColor: theme.colors.bg,
        color: theme.colors.ink,
        fontFamily: input.fontFamily,
        fontSize: input.fontSize,
        includeFontPadding: false,
      }}
    />
  );
}

/** A private key: Paste or Pick the file, then only “Private key pasted” or the file's name, with Remove. */
function KeyField({
  field,
  keyIn,
  invalid,
  busy,
  onPaste,
  onPick,
  onClear,
}: {
  field: GuideField;
  keyIn: string | null;
  invalid: boolean;
  busy: boolean;
  onPaste: () => void;
  onPick: () => void;
  onClear: () => void;
}) {
  const { rawLocale } = useI18n();
  const vaultAskKeyInHere = vaultAskKeyIn(rawLocale);
  const theme = useTheme();
  const box = {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 12,
    borderRadius: 10,
    borderWidth: 1,
    borderStyle: 'dashed' as const,
    borderColor: invalid ? theme.colors.bad : theme.colors.line2,
  };
  if (keyIn)
    return (
      <View style={box}>
        <Check size={16} color={theme.faces.banjo.accent} strokeWidth={2.25} />
        <Text size={14.5} weight={500} numberOfLines={1} style={{ flex: 1 }}>
          {keyIn}
        </Text>
        <Touchable
          onPress={onClear}
          disabled={busy}
          feedback="wash"
          ringRadius={8}
          accessibilityRole="button"
          accessibilityLabel={`${vaultAskKeyInHere.remove}, ${field.label}`}
          style={{ minHeight: 44, minWidth: 44, justifyContent: 'center', paddingHorizontal: 6 }}
        >
          <Text size={14} weight={500} color={theme.colors.brand}>
            {vaultAskKeyInHere.remove}
          </Text>
        </Touchable>
      </View>
    );
  return (
    <View style={{ flexDirection: 'row', gap: 8 }}>
      <Touchable
        onPress={onPaste}
        disabled={busy}
        feedback="wash"
        ringRadius={10}
        accessibilityRole="button"
        accessibilityLabel={`${vaultAskKeyInHere.paste}, ${field.label}`}
        style={{ ...box, flex: 1 }}
      >
        <Key size={18} color={theme.colors.ink2} strokeWidth={1.75} />
        <Text size={14.5} weight={500}>
          {vaultAskKeyInHere.paste}
        </Text>
      </Touchable>
      <Touchable
        onPress={onPick}
        disabled={busy}
        feedback="wash"
        ringRadius={10}
        accessibilityRole="button"
        accessibilityLabel={`${vaultAskKeyInHere.pick}, ${field.label}`}
        style={{ ...box, flex: 1 }}
      >
        <FileText size={18} color={theme.colors.ink2} strokeWidth={1.75} />
        <Text size={14.5} weight={500}>
          {vaultAskKeyInHere.pick}
        </Text>
      </Touchable>
    </View>
  );
}
