/**
 * Add to Vault on Android (AP-718; the web's modal, docs/decisions/vault.md VT-70, VT-D29): the templates as list rows,
 * then the form — name, “What should agents know?”, the address, how it signs in, a username and the secret in a
 * write-only field. Save creates the entry and then runs “Check connection” (`vault.create` doesn't check), so the
 * entry opens with its first result. An SSH key is added on the web, and a website login is tested there. The form
 * lives only while the sheet is open: the secret goes with it, and never into navigation params.
 */
import { VAULT_AUTH_LABELS, vaultProblemOf } from '@whombat/client';
import { useVaultWrite } from '@whombat/client/react';
import { api } from '@whombat/core/contracts';
import {
  VAULT_COPY,
  VAULT_DESCRIPTION_MAX,
  VAULT_NAME_MAX,
  VAULT_SECRET_MAX,
  type VaultNetwork,
} from '@whombat/core/vault';
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import {
  checksAfterAdd,
  emptyVaultForm,
  FIRST_PHONE_TEMPLATE,
  type FieldProblems,
  type PhoneVaultTemplate,
  phoneVaultTemplates,
  VAULT_FORM_TEXT,
  type VaultForm,
  vaultAddressHint,
  vaultCreateBody,
  vaultFormFields,
  vaultFormProblems,
  vaultTemplateChoice,
} from '../data/vaultForm';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import { ListRow } from '../ui/ListRow';
import { Button, CardNote, Chip } from '../ui/primitives';
import { Sheet } from '../ui/sheet';
import { outcomeText, showNotice } from './feedback';

export function AddToVaultSheet({
  visible,
  onClose,
  networks,
  onAdded,
}: {
  visible: boolean;
  onClose: () => void;
  /** The home network list, so the address field can say what's reachable (VT-12). */
  networks: readonly VaultNetwork[];
  /** The new entry, to open it. */
  onAdded: (entry: { id: string; name: string }) => void;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={VAULT_FORM_TEXT.kicker}
      label={VAULT_COPY.add}
      maxHeight="92%"
    >
      {visible ? <AddForm networks={networks} onClose={onClose} onAdded={onAdded} /> : null}
    </Sheet>
  );
}

function AddForm({
  networks,
  onClose,
  onAdded,
}: {
  networks: readonly VaultNetwork[];
  onClose: () => void;
  onAdded: (entry: { id: string; name: string }) => void;
}) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const create = useVaultWrite(api.vault.create, slug);
  const check = useVaultWrite(api.vault.check, slug);
  const [template, setTemplate] = useState<PhoneVaultTemplate | null>(null);
  const [form, setForm] = useState<VaultForm>(emptyVaultForm(FIRST_PHONE_TEMPLATE));
  const [problems, setProblems] = useState<FieldProblems>({});
  const [message, setMessage] = useState<string | null>(null);
  const busy = create.isPending || check.isPending;
  const set = <K extends keyof VaultForm>(key: K, value: VaultForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    setMessage(null);
  };

  // A new template keeps what was typed for every template, never the secret.
  const choose = (next: PhoneVaultTemplate | null) => {
    setTemplate(next);
    setForm((f) => ({
      ...emptyVaultForm(next ?? FIRST_PHONE_TEMPLATE),
      name: f.name,
      description: f.description,
      url: f.url,
    }));
    setProblems({});
    setMessage(null);
  };

  const save = async () => {
    if (!template || busy) return;
    const local = vaultFormProblems(template, form);
    setProblems(local);
    setMessage(null);
    if (Object.keys(local).length) return;
    try {
      const created = await create.mutateAsync({
        params: { burrow: slug },
        body: vaultCreateBody(template, form),
      });
      if (created.status !== 'ok') {
        const text = outcomeText(created);
        if (text) Alert.alert(text.title, text.body);
        return;
      }
      const entry = created.data.entry;
      setForm((f) => ({ ...f, secret: '' }));
      let summary: string | null = null;
      if (checksAfterAdd(entry.kind)) {
        try {
          const checked = await check.mutateAsync({ params: { burrow: slug, entryId: entry.id } });
          if (checked.status === 'ok') summary = checked.data.result.summary;
        } catch {
          // The entry is saved; its screen says “Not checked yet” and offers “Check again”.
        }
      }
      showNotice(
        summary ? VAULT_FORM_TEXT.addedChecked(entry.name, summary) : VAULT_FORM_TEXT.added(entry.name),
      );
      onAdded({ id: entry.id, name: entry.name });
    } catch (error) {
      const p = vaultProblemOf(error);
      setProblems(p.fields);
      setMessage(p.message ?? (Object.keys(p.fields).length ? null : VAULT_FORM_TEXT.failed));
    }
  };

  if (template === null)
    return (
      <ScrollView contentContainerStyle={{ paddingBottom: 8, gap: 12 }}>
        <View style={{ paddingHorizontal: 22, gap: 4 }}>
          <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
            {VAULT_COPY.add}
          </Text>
          <Text size={14} color={theme.colors.ink2}>
            {VAULT_FORM_TEXT.chooseTemplate}
          </Text>
        </View>
        <View
          style={{
            marginHorizontal: 16,
            borderRadius: 20,
            borderWidth: 1,
            borderColor: theme.colors.line,
            backgroundColor: theme.colors.sf,
            overflow: 'hidden',
          }}
        >
          {phoneVaultTemplates().map((t) => {
            const choice = vaultTemplateChoice(t);
            return (
              <ListRow
                key={t}
                title={choice.title}
                trailing="›"
                body={choice.body}
                onPress={() => choose(t)}
                accessibilityLabel={`${choice.title}. ${choice.body}`}
              />
            );
          })}
          <CardNote>{VAULT_FORM_TEXT.sshOnWeb}</CardNote>
        </View>
        <View style={{ paddingHorizontal: 22 }}>
          <Button label={VAULT_FORM_TEXT.cancel} variant="secondary" onPress={onClose} />
        </View>
      </ScrollView>
    );

  const fields = vaultFormFields(template, form);
  const choice = vaultTemplateChoice(template);
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}
    >
      <View style={{ gap: 4 }}>
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          {VAULT_COPY.add}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text size={13.5} lh={1.4} color={theme.colors.ink2} style={{ flex: 1 }}>
            {`${choice.title} · ${choice.body}`}
          </Text>
          <Button
            label={VAULT_FORM_TEXT.change}
            variant="quiet"
            disabled={busy}
            accessibilityHint="Choose what you’re adding again"
            onPress={() => choose(null)}
          />
        </View>
      </View>
      <FormField
        label={VAULT_FORM_TEXT.name}
        value={form.name}
        onChangeText={(v) => set('name', v)}
        error={problems.name}
        maxLength={VAULT_NAME_MAX}
        placeholder={VAULT_FORM_TEXT.namePlaceholder[template]}
      />
      <FormField
        label={fields.addressLabel}
        value={form.url}
        onChangeText={(v) => set('url', v)}
        error={problems.url}
        hint={
          fields.httpWarning
            ? `${fields.httpWarning} ${vaultAddressHint(networks)}`
            : vaultAddressHint(networks)
        }
        mono
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder={VAULT_FORM_TEXT.addressPlaceholder[template]}
      />
      <FormField
        label={VAULT_COPY.descriptionLabel}
        value={form.description}
        onChangeText={(v) => set('description', v)}
        error={problems.description}
        multiline
        maxLength={VAULT_DESCRIPTION_MAX}
        placeholder={VAULT_FORM_TEXT.descriptionPlaceholder}
      />
      {fields.auths.length > 0 ? (
        <View style={{ gap: 8 }}>
          <Text size={13} weight={500} color={theme.colors.ink2}>
            {VAULT_FORM_TEXT.signsIn}
          </Text>
          <View
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, paddingVertical: 4 }}
            accessibilityRole="radiogroup"
            accessibilityLabel={VAULT_FORM_TEXT.signsIn}
          >
            {fields.auths.map((a) => (
              <Chip
                key={a}
                label={VAULT_AUTH_LABELS[a]}
                active={form.auth === a}
                onPress={() => set('auth', a)}
              />
            ))}
          </View>
          <FormMessage text={problems.auth} />
        </View>
      ) : null}
      {fields.headerName ? (
        <FormField
          label={VAULT_FORM_TEXT.headerName}
          value={form.headerName}
          onChangeText={(v) => set('headerName', v)}
          error={problems['auth.name']}
          mono
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="X-API-Key"
        />
      ) : null}
      {fields.queryName ? (
        <FormField
          label={VAULT_FORM_TEXT.queryName}
          value={form.queryName}
          onChangeText={(v) => set('queryName', v)}
          error={problems['auth.name']}
          hint={fields.queryWarning}
          mono
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="api_key"
        />
      ) : null}
      {fields.username ? (
        <FormField
          label={VAULT_FORM_TEXT.username}
          value={form.username}
          onChangeText={(v) => set('username', v)}
          error={problems['auth.username']}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          importantForAutofill="no"
        />
      ) : null}
      {fields.secret ? (
        <FormField
          label={fields.secretLabel}
          value={form.secret}
          onChangeText={(v) => set('secret', v)}
          error={problems.secret}
          hint={VAULT_FORM_TEXT.secretHint}
          secret
          maxLength={VAULT_SECRET_MAX}
          placeholder={VAULT_FORM_TEXT.secretPlaceholder}
        />
      ) : null}
      <FormMessage text={message} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label={VAULT_FORM_TEXT.cancel}
          variant="secondary"
          disabled={busy}
          onPress={onClose}
          style={{ flex: 1 }}
        />
        <Button label={VAULT_FORM_TEXT.save} busy={busy} onPress={() => void save()} style={{ flex: 1 }} />
      </View>
    </ScrollView>
  );
}
