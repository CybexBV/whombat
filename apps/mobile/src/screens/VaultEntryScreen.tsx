/**
 * One of your Vault entries on Android (docs/decisions/vault.md VT-71, VT-73; not mocked): CONNECTION (how it
 * signs in, the last check, Check again; a website login has no check), SECRET (set or not, and
 * Replace in a sheet, AP-718), TOOLS of an MCP entry (a switch each,
 * “New” on a tool that appeared or changed), “Neo can use this” with On / Off, its hint and how the entry reaches the
 * agent in your chats (vault-self-serve.md VS-03, hermes-engine.md HE-43; AP-4030…AP-4033, AP-5280): an API's
 * environment variable, changed in a sheet (`vault.setKeyEnvName`, AP-5281), and RECENT USE. An SSH key (VT-S13;
 * AP-605) shows PUBLIC KEY (its fingerprint) and SERVERS read-only with their status, and which servers each key
 * covers. An old `secret` entry (packs used it; Whombat skill-store.md SST-09) has one line that nothing uses it and
 * Remove from Vault (skill-store.md AP-4156, AP-4157). Editing and removing other entries, an SSH key's servers and host
 * keys stay on the web; a production server carries PRODUCTION (AC-11), read-only.
 * Outcomes: an alert only when something didn't go through.
 */
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { VAULT_MCP_MOVE_TEXT, VAULT_TOTP_TEXT, vaultProblemOf } from '@whombat/client';
import { useVaultEntry, useVaultWrite } from '@whombat/client/react';
import { api } from '@whombat/core';
import {
  VAULT_COPY,
  VAULT_KEYS_COPY,
  VAULT_SSH_COPY,
  VAULT_TOTP_INPUT_MAX,
  type VaultAgentAccess,
  vaultTotpProblem,
} from '@whombat/core/vault';
import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo, Alert, RefreshControl, ScrollView, Switch, View } from 'react-native';
import { PrincipalAvatar } from '../avatars/Avatars';
import { useBurrowBase, useViewContext } from '../data/BurrowProvider';
import {
  VAULT_ENV_TEXT,
  VAULT_REMOVE_COPY,
  VAULT_SSH_ON_WEB,
  type VaultAgentAccessRow,
  vaultAccessChange,
  vaultEntryScreen,
  vaultEnvNameCheck,
} from '../data/vault';
import { VAULT_FORM_TEXT } from '../data/vaultForm';
import { connectionsScreenUrl } from '../navigation/connectionLinks';
import { openAppUrl } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { FormField, FormMessage } from '../ui/formField';
import { BackBar, Screen } from '../ui/headers';
import { ListRow } from '../ui/ListRow';
import { Button, CardNote, ErrorState, Section, SkeletonRows, StatusDot, toneColor } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { StatusPill } from '../ui/StatusPill';
import { useBottomRoom } from '../ui/screenBottom';
import { Sheet } from '../ui/sheet';
import { switchColors } from '../ui/switchColors';
import { errorText, outcomeText, showNotice } from './feedback';
import { ReplaceSecretSheet, type ReplaceTarget } from './ReplaceSecretSheet';

type Props = NativeStackScreenProps<RootStackParamList, 'VaultEntry'>;

export function VaultEntryScreen({ route, navigation }: Props) {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const ctx = useViewContext();
  const { entryId, title, back = 'Back' } = route.params;
  const query = useVaultEntry({ params: { burrow: slug, entryId } });
  const check = useVaultWrite(api.vault.check, slug);
  const setTool = useVaultWrite(api.vault.setTool, slug);
  const remove = useVaultWrite(api.vault.remove, slug);
  const [replacing, setReplacing] = useState<ReplaceTarget | null>(null);
  const [totpOpen, setTotpOpen] = useState(false);
  const setTotp = useVaultWrite(api.vault.setTotp, slug);
  const model = useMemo(
    () => (query.data ? vaultEntryScreen(query.data.entry, ctx) : null),
    [query.data, ctx],
  );
  const toolBusy = setTool.isPending ? setTool.variables?.params.tool : null;
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));

  const act = async (run: () => Promise<Parameters<typeof outcomeText>[0]>) => {
    try {
      const text = outcomeText(await run());
      if (text) Alert.alert(text.title, text.body);
    } catch (error) {
      Alert.alert('That didn’t go through', errorText(error));
    }
  };
  const runCheck = () =>
    void act(async () => {
      const result = await check.mutateAsync({ params: { burrow: slug, entryId } });
      // The CONNECTION line changes in place; say the new state too.
      if (result.status === 'ok') AccessibilityInfo.announceForAccessibility(result.data.result.summary);
      return result;
    });
  const toggleTool = (tool: string, enabled: boolean) =>
    void act(() => setTool.mutateAsync({ params: { burrow: slug, entryId, tool }, body: { enabled } }));
  // Only an old `secret` entry is removed here (AP-4157): asked first, then back to where it was opened from.
  const askRemove = (name: string) =>
    Alert.alert(VAULT_REMOVE_COPY.confirm(name), VAULT_REMOVE_COPY.confirmBody, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () =>
          void act(async () => {
            const result = await remove.mutateAsync({ params: { burrow: slug, entryId } });
            if (result.status === 'ok') {
              showNotice(VAULT_REMOVE_COPY.removed(name));
              goBack();
            }
            return result;
          }),
      },
    ]);
  const notFound = !!query.error && 'status' in query.error && query.error.status === 404;

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      <ReplaceSecretSheet target={replacing} onClose={() => setReplacing(null)} />
      <TotpSheet
        visible={totpOpen}
        name={model?.name ?? title}
        busy={setTotp.isPending}
        onClose={() => setTotpOpen(false)}
        onSave={async (totp) => {
          const result = await setTotp.mutateAsync({ params: { burrow: slug, entryId }, body: { totp } });
          if (result.status !== 'ok') {
            const text = outcomeText(result);
            if (text) Alert.alert(text.title, text.body);
            return false;
          }
          showNotice(VAULT_TOTP_TEXT.saved);
          return true;
        }}
      />
      <ScrollView
        style={{ flex: 1 }}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: 28 + bottomRoom }}
        refreshControl={
          <RefreshControl
            refreshing={query.isRefetching}
            onRefresh={() => void query.refetch()}
            colors={[theme.colors.ink]}
            progressBackgroundColor={theme.colors.sf}
          />
        }
      >
        <View style={{ paddingHorizontal: 22, paddingBottom: 14, gap: 4 }}>
          <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
            VAULT
          </Text>
          <Text size={25} weight={700} lh={1.15} tracking={-0.02} accessibilityRole="header">
            {model?.name ?? title}
          </Text>
          {model ? (
            <Text size={11.5} mono color={theme.colors.mut}>
              {model.meta}
            </Text>
          ) : null}
          {model?.description ? (
            <Text size={14} color={theme.colors.ink2} style={{ paddingTop: 4 }}>
              {model.description}
            </Text>
          ) : null}
        </View>

        {!model ? (
          notFound ? (
            // Another person's entry is a plain 404, exactly like one that was removed (VT-01).
            <ErrorState text="This entry isn’t in your Vault." />
          ) : query.error ? (
            <ErrorState text="This entry didn’t load." onRetry={() => void query.refetch()} />
          ) : (
            <SkeletonRows count={4} lines={2} label="Loading the entry" />
          )
        ) : (
          <>
            {model.moveToConnections ? (
              <Section title={VAULT_MCP_MOVE_TEXT.title.toUpperCase()}>
                <CardNote>{VAULT_MCP_MOVE_TEXT.body}</CardNote>
                <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                  <Button
                    label={VAULT_MCP_MOVE_TEXT.link}
                    variant="secondary"
                    onPress={() =>
                      openAppUrl(
                        connectionsScreenUrl(
                          `?tab=connections&connection=custom_mcp${
                            query.data?.entry.url ? `&url=${encodeURIComponent(query.data.entry.url)}` : ''
                          }`,
                        ),
                      )
                    }
                  />
                </View>
              </Section>
            ) : null}

            {model.connection ? (
              <Section title={VAULT_COPY.connection}>
                <ListRow
                  title={model.connection.address}
                  titleMono
                  trailing={
                    <StatusDot color={toneColor(theme, model.status.tone)} label={model.status.label} />
                  }
                  accessibilityLabel={[
                    `${model.connection.address}, ${model.status.label}`,
                    model.connection.signsIn,
                    model.connection.line,
                  ]
                    .filter(Boolean)
                    .join('. ')}
                >
                  {model.connection.signsIn ? (
                    <Text size={11.5} mono color={theme.colors.mut}>
                      {model.connection.signsIn}
                    </Text>
                  ) : null}
                  {model.connection.line ? (
                    <Text size={14} lh={1.45} color={theme.colors.ink2}>
                      {model.connection.line}
                    </Text>
                  ) : null}
                </ListRow>
                {model.connection.canCheck ? (
                  <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                    <Button
                      label={VAULT_COPY.checkAgain}
                      variant="secondary"
                      busy={check.isPending}
                      onPress={runCheck}
                    />
                  </View>
                ) : null}
              </Section>
            ) : null}

            {model.ssh ? (
              <>
                <Section title={VAULT_SSH_COPY.publicKey}>
                  <ListRow
                    title={model.ssh.fingerprint ?? model.secretLine}
                    titleMono
                    meta={model.ssh.keyMeta}
                  />
                </Section>
                <Section title={VAULT_SSH_COPY.servers}>
                  {model.ssh.empty ? <CardNote>{model.ssh.empty}</CardNote> : null}
                  {model.ssh.servers.map((s) => (
                    <ListRow
                      key={s.id}
                      title={s.name}
                      titleMono
                      meta={s.target}
                      trailing={
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                          {s.production ? <StatusPill text={s.production} tone="warn" /> : null}
                          <StatusDot color={toneColor(theme, s.status.tone)} label={s.status.label} />
                        </View>
                      }
                      accessibilityLabel={s.accessibilityLabel}
                    >
                      <Text
                        size={14}
                        lh={1.45}
                        color={s.status.tone === 'bad' ? theme.colors.bad : theme.colors.ink2}
                      >
                        {s.line}
                      </Text>
                      {s.keptPassword ? (
                        <Text size={13} lh={1.45} color={theme.colors.mut}>
                          {s.keptPassword}
                        </Text>
                      ) : null}
                      {s.hostKey ? (
                        <Text size={11.5} mono color={theme.colors.mut}>
                          {s.hostKey}
                        </Text>
                      ) : null}
                    </ListRow>
                  ))}
                  <CardNote>{VAULT_SSH_ON_WEB}</CardNote>
                </Section>
              </>
            ) : model.unused ? (
              <Section>
                <CardNote>{model.unused}</CardNote>
                <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                  <Button
                    label={VAULT_REMOVE_COPY.action}
                    variant="secondary"
                    busy={remove.isPending}
                    accessibilityHint={`Removes ${model.name} from your Vault`}
                    onPress={() => askRemove(model.name)}
                  />
                </View>
              </Section>
            ) : (
              <Section title={VAULT_COPY.secret}>
                {query.data?.entry.auth?.type === 'none' ? (
                  <ListRow title={model.secretLine} body={VAULT_FORM_TEXT.signsInWithNothing} />
                ) : (
                  <>
                    <ListRow title={model.secretLine} />
                    <View style={{ paddingHorizontal: 16, paddingVertical: 8 }}>
                      <Button
                        label={VAULT_COPY.replace}
                        variant="secondary"
                        accessibilityHint={`Replaces the secret of ${model.name}`}
                        onPress={() => {
                          if (query.data)
                            setReplacing({ entryId, name: model.name, auth: query.data.entry.auth });
                        }}
                      />
                    </View>
                  </>
                )}
              </Section>
            )}

            {model.totp ? (
              <Section title={VAULT_TOTP_TEXT.label}>
                <ListRow title={model.totp.line} />
                <View style={{ flexDirection: 'row', gap: 8, paddingHorizontal: 16, paddingVertical: 8 }}>
                  <Button
                    label={model.totp.set ? VAULT_TOTP_TEXT.replace : VAULT_TOTP_TEXT.add}
                    variant="secondary"
                    accessibilityHint={`${VAULT_TOTP_TEXT.field}, ${model.name}`}
                    onPress={() => setTotpOpen(true)}
                    style={{ flex: 1 }}
                  />
                  {model.totp.set ? (
                    <Button
                      label={VAULT_TOTP_TEXT.remove}
                      variant="secondary"
                      busy={setTotp.isPending}
                      accessibilityHint={`${VAULT_TOTP_TEXT.field}, ${model.name}`}
                      onPress={() =>
                        void act(async () => {
                          const result = await setTotp.mutateAsync({
                            params: { burrow: slug, entryId },
                            body: { totp: null },
                          });
                          if (result.status === 'ok') showNotice(VAULT_TOTP_TEXT.removed);
                          return result;
                        })
                      }
                      style={{ flex: 1 }}
                    />
                  ) : null}
                </View>
              </Section>
            ) : null}

            {model.tools.length > 0 ? (
              <Section title={VAULT_COPY.tools}>
                {model.tools.map((t) => (
                  <ListRow
                    key={t.name}
                    title={t.name}
                    titleMono
                    trailing={t.isNew ? <StatusPill text={VAULT_COPY.newBadge} tone="warn" /> : null}
                    body={t.description}
                    accessibilityLabel={t.accessibilityLabel}
                    control={
                      <Switch
                        value={t.enabled}
                        disabled={toolBusy === t.name}
                        onValueChange={(v) => toggleTool(t.name, v)}
                        accessibilityLabel={t.name}
                        accessibilityRole="switch"
                        {...switchColors(theme, t.enabled)}
                        style={{ minHeight: 44 }}
                      />
                    }
                  />
                ))}
                {model.toolsIgnored ? <CardNote>{model.toolsIgnored}</CardNote> : null}
              </Section>
            ) : null}

            {model.access ? <AccessRow access={model.access} entryId={entryId} act={act} /> : null}

            {model.recentUse.length > 0 ? (
              <Section title={VAULT_COPY.recentUse}>
                {model.recentUse.map((u) => (
                  <ListRow
                    key={u.id}
                    title={u.agent}
                    trailing={u.when}
                    body={`${u.what} · ${u.outcome}`}
                    accessibilityLabel={u.line}
                  />
                ))}
              </Section>
            ) : null}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}

/**
 * “Neo can use this” (VS-03; HE-43; AP-4030…AP-4033, AP-4992, AP-5280): the agent, On / Off (44dp each with the control's
 * slop), the hint for the choice, the servers a key covers and how the entry reaches the agent in your chats — an API's
 * environment variable with Change (AP-5281). The choice shows at once while it saves and goes back if it didn't go
 * through. Off switches it off without a question (the hint says what it means and one tap switches it back on); an
 * entry that reached its commands says it may have kept a copy (AC-34), as the web does.
 */
function AccessRow({
  access,
  entryId,
  act,
}: {
  access: VaultAgentAccessRow;
  entryId: string;
  act: (run: () => Promise<Parameters<typeof outcomeText>[0]>) => Promise<void>;
}) {
  const theme = useTheme();
  const { slug } = useBurrowBase();
  const giveKey = useVaultWrite(api.vault.giveKey, slug);
  const takeKey = useVaultWrite(api.vault.takeKey, slug);
  const [saving, setSaving] = useState<VaultAgentAccess | null>(null);
  const [naming, setNaming] = useState(false);
  useEffect(() => {
    if (saving === access.value) setSaving(null);
  }, [saving, access.value]);
  const shown = saving ?? access.value;

  const choose = (to: VaultAgentAccess) => {
    if (saving) return;
    const change = vaultAccessChange(access.value, to);
    if (!change) return;
    setSaving(to);
    const params = { burrow: slug, entryId };
    void act(async () => {
      try {
        const result =
          'take' in change
            ? await takeKey.mutateAsync({ params })
            : await giveKey.mutateAsync({ params, body: change.give });
        if (result.status !== 'ok') setSaving(null);
        // Its commands may have kept a copy (AC-34): said once, under the hint's words.
        else if ('take' in change && access.offNotice) Alert.alert(access.hints.off, access.offNotice);
        return result;
      } catch (error) {
        setSaving(null);
        throw error;
      }
    });
  };

  return (
    <Section>
      <View
        style={{
          gap: 10,
          paddingVertical: 14,
          paddingHorizontal: 16,
          borderBottomWidth: 1,
          borderBottomColor: theme.colors.line,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <PrincipalAvatar principal={access.principal} size={32} />
          <Text size={15.5} weight={600} numberOfLines={1} style={{ flexShrink: 1 }}>
            {access.title}
          </Text>
        </View>
        <Segmented<VaultAgentAccess>
          label={access.title}
          value={shown}
          onChange={choose}
          options={access.options}
        />
        <Text size={13} lh={1.4} color={theme.colors.mut} accessibilityLiveRegion="polite">
          {access.hints[shown]}
        </Text>
        {access.servers ? (
          <Text size={12} mono color={theme.colors.mut}>
            {access.servers}
          </Text>
        ) : null}
        {access.env && shown === 'on' ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut}>
                {VAULT_KEYS_COPY.envName}
              </Text>
              <Text
                size={13}
                mono
                color={theme.colors.ink}
                accessibilityLabel={access.env.variables.join(', ')}
              >
                {access.env.variables.join(' · ')}
              </Text>
            </View>
            <Button
              label={VAULT_ENV_TEXT.change}
              variant="secondary"
              onPress={() => setNaming(true)}
              accessibilityHint={VAULT_ENV_TEXT.changeHint}
              style={{ paddingHorizontal: 18 }}
            />
          </View>
        ) : null}
        {access.how && shown === 'on' ? (
          <Text size={13} lh={1.4} color={theme.colors.ink2}>
            {access.how}
          </Text>
        ) : null}
      </View>
      {access.env ? (
        <EnvNameSheet
          visible={naming}
          entryId={entryId}
          current={access.env.name}
          onClose={() => setNaming(false)}
        />
      ) : null}
    </Section>
  );
}

/**
 * The environment variable an API's value is in for the agent's commands (AC-31, CT-1240; AP-5281): the name in a field
 * that checks it as the contract does, Save (`vault.setKeyEnvName`) and Cancel; a refusal stays under the field.
 */
function EnvNameSheet({
  visible,
  entryId,
  current,
  onClose,
}: {
  visible: boolean;
  entryId: string;
  current: string;
  onClose: () => void;
}) {
  const { slug } = useBurrowBase();
  const setEnv = useVaultWrite(api.vault.setKeyEnvName, slug);
  const [text, setText] = useState(current);
  const [problem, setProblem] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  if (visible && !shown) {
    setShown(true);
    setText(current);
    setProblem(null);
  }
  const close = () => {
    setShown(false);
    onClose();
  };
  const save = async () => {
    const checked = vaultEnvNameCheck(text);
    if (!checked.ok) return setProblem(checked.problem);
    if (checked.name === current) return close();
    try {
      const result = await setEnv.mutateAsync({
        params: { burrow: slug, entryId },
        body: { envName: checked.name },
      });
      if (result.status !== 'ok') return setProblem(VAULT_FORM_TEXT.failed);
      close();
    } catch (error) {
      setProblem(errorText(error));
    }
  };
  return (
    <Sheet visible={visible} onClose={close} title={VAULT_KEYS_COPY.envName} label={VAULT_ENV_TEXT.change}>
      <View style={{ paddingHorizontal: 22, gap: 12 }}>
        <FormField
          label={VAULT_KEYS_COPY.envName}
          value={text}
          onChangeText={(next) => {
            setText(next);
            if (problem) setProblem(null);
          }}
          mono
          autoCapitalize="characters"
          autoCorrect={false}
          hint={VAULT_KEYS_COPY.envNameHint}
          error={problem}
          autoFocus
        />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button label={VAULT_FORM_TEXT.cancel} variant="secondary" onPress={close} style={{ flex: 1 }} />
          <Button
            label={VAULT_ENV_TEXT.save}
            busy={setEnv.isPending}
            disabled={!text.trim()}
            onPress={() => void save()}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Sheet>
  );
}

/**
 * A website login's authenticator key in a sheet (VLT-46; AP-6661): the setup key or `otpauth://` link pasted into a
 * write-only field, checked here first, held only while the sheet is open and dropped once sent.
 */
function TotpSheet({
  visible,
  name,
  busy,
  onClose,
  onSave,
}: {
  visible: boolean;
  name: string;
  busy: boolean;
  onClose: () => void;
  onSave: (totp: string) => Promise<boolean>;
}) {
  const theme = useTheme();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const close = () => {
    setValue('');
    setProblem(null);
    setMessage(null);
    onClose();
  };
  const save = async () => {
    const local = vaultTotpProblem(value);
    setProblem(local);
    if (local || busy) return;
    const typed = value.trim();
    setValue('');
    try {
      if (await onSave(typed)) close();
    } catch (error) {
      const p = vaultProblemOf(error);
      setProblem(p.fields.totp ?? null);
      setMessage(p.message ?? (p.fields.totp ? null : VAULT_FORM_TEXT.failed));
    }
  };
  return (
    <Sheet visible={visible} onClose={close} title={VAULT_TOTP_TEXT.label} label={VAULT_TOTP_TEXT.field}>
      <View style={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}>
        <View style={{ gap: 4 }}>
          <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
            {`${VAULT_TOTP_TEXT.field} · ${name}`}
          </Text>
          <Text size={13.5} lh={1.4} color={theme.colors.mut}>
            {VAULT_TOTP_TEXT.hint}
          </Text>
        </View>
        <FormField
          label={VAULT_TOTP_TEXT.field}
          value={value}
          onChangeText={(v) => {
            setValue(v);
            setProblem(null);
            setMessage(null);
          }}
          error={problem}
          secret
          autoFocus
          maxLength={VAULT_TOTP_INPUT_MAX}
          placeholder={VAULT_TOTP_TEXT.placeholder}
        />
        <FormMessage text={message} />
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button
            label={VAULT_FORM_TEXT.cancel}
            variant="secondary"
            disabled={busy}
            onPress={close}
            style={{ flex: 1 }}
          />
          <Button
            label={VAULT_FORM_TEXT.save}
            busy={busy}
            disabled={!value.trim()}
            onPress={() => void save()}
            style={{ flex: 1 }}
          />
        </View>
      </View>
    </Sheet>
  );
}
