/**
 * Add a server on the phone (Whombat server-signin.md SI-01…SI-12; server-signin-mobile.md AP-1697…): what Whombat may
 * do on it (Watch only · Restart and consoles · Full control), chosen once above two ways in — **Sign in once**
 * (address, user name and the password, or a key from your Vault with the password for `sudo` if it asks, and
 * whether to leave a Vault key on it), **Run a command** (the pre-approved command for the chosen level) and **Windows
 * PC** (the same as one PowerShell line, with how to remove it again; windows-servers.md). Signing in
 * follows the job live (the `hosts.install` frame, every 2 s as well): its four steps, the key the server showed, then
 * “Open pve-03” or the reason with Try again and More detail. Servers that ran an older command wait for you on top
 * (Home's “wants to be added” opens here). A Whombat without `hosts.install` gets the command alone, as before. Rules and words are the web's (`@whombat/client/hosts` `install.ts`). Opened from Things, Home and the
 * assistant's card (`whombat://servers/add?address=…&user=…&control=…`), which fill it in and never send anything.
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import {
  addServerPrefill,
  commandCopy,
  commandOutcome,
  commitOutcomeText,
  hostControlQuestion,
  hostErrorInfo,
  type InstallStep,
  installBody,
  installFailureCard,
  installHostKeyNote,
  installKeyChangedAgain,
  installOutcome,
  installRunning,
  installSteps,
  installTitle,
  isHostsUnavailable,
  NEW_KEY,
  type SignInErrors,
  type SignInForm,
  signInCopy,
  signInFormDefaults,
  signInFormErrors,
  signInFormForRetry,
  windowsCopy,
  withKeyDefaults,
} from '@whombat/client/hosts';
import {
  useHostEnrollments,
  useHostInstall,
  useHostsChange,
  useHostsFleet,
  useHostsLive,
  useHostsStatus,
  useRefreshHosts,
} from '@whombat/client/hosts/react';
import { useVault, useVaultWrite } from '@whombat/client/react';
import {
  api,
  HOST_CONTROL_LEVELS,
  HOST_WINDOWS_UNINSTALL_COMMAND,
  type HostControlLevel,
  type HostEnrollment,
  type HostInstall,
  type HostPendingEnrollment,
  hostControlLevelWords,
  thingId,
} from '@whombat/core';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  addServerCopy,
  carriesOnText,
  type KeyRow,
  keyRows,
  type PendingRowView,
  pendingRows,
  serverNameProblem,
  stepSpoken,
} from '../data/addServer';
import { useBurrowBase, useNow } from '../data/BurrowProvider';
import { useI18n, useMobileT } from '../i18n';
import { backWordUnder } from '../navigation/backWord';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from '../ui/clipboard';
import { FormField, FormMessage } from '../ui/formField';
import { BackBar, Screen } from '../ui/headers';
import { Check, X } from '../ui/icons';
import { bottomPadding } from '../ui/insets';
import { KeyboardAvoidingView, useKeyboardPadding } from '../ui/keyboard';
import { Button, ErrorState, QuietText, SkeletonRows } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { Touchable } from '../ui/Touchable';
import { showNotice } from './feedback';

type Props = NativeStackScreenProps<RootStackParamList, 'AddServer'>;

type Way = 'signIn' | 'command' | 'windows';

export function AddServerScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const ADD_SERVER_COPY = addServerCopy(rawLocale);
  const signInCopyHere = signInCopy(rawLocale);
  const commandCopyHere = commandCopy(rawLocale);
  const { t: tMobile } = useMobileT();
  const insets = useSafeAreaInsets();
  const { slug, currentBootstrap } = useBurrowBase();
  const now = useNow().getTime();
  useHostsLive(currentBootstrap().burrow.id);
  const status = useHostsStatus({ params: { burrow: slug } }, { retry: false });
  const here = status.data?.present !== false;
  const pending = useHostEnrollments(
    here ? { params: { burrow: slug }, query: { state: 'pending' } } : null,
    {
      refetchInterval: 10_000,
    },
  );
  const [back] = useState(
    () => route.params?.back ?? backWordUnder(navigation.getState(), route.key, rawLocale),
  );
  const goBack = () => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Tabs'));
  const openServer = (serverId: string, name: string) =>
    navigation.replace('Thing', { thingId: thingId('server', serverId), title: name, back });

  // What the link filled in (the assistant's card, SI-10); a later link for another server fills it in again.
  const linked = route.params ?? {};
  const [prefill, setPrefill] = useState(() => addServerPrefill(linked));
  const [control, setControl] = useState<HostControlLevel>(prefill.control);
  const [way, setWay] = useState<Way>('signIn');
  const [form, setForm] = useState<SignInForm>(() => signInFormDefaults(prefill));
  const [job, setJob] = useState<HostInstall | null>(null);
  const [commands, setCommands] = useState<Partial<Record<HostControlLevel, HostEnrollment>>>({});
  const linkKey = `${linked.address ?? ''}|${linked.user ?? ''}|${linked.control ?? ''}|${linked.name ?? ''}`;
  const lastLink = useRef(linkKey);
  useEffect(() => {
    if (linkKey === lastLink.current) return;
    lastLink.current = linkKey;
    const next = addServerPrefill(route.params ?? {});
    setPrefill(next);
    setControl(next.control);
    setForm(signInFormDefaults(next));
    setWay('signIn');
    setJob(null);
  }, [linkKey, route.params]);

  const refusal =
    status.data && !status.data.present
      ? ADD_SERVER_COPY.absent
      : status.error && isHostsUnavailable(status.error)
        ? ADD_SERVER_COPY.unavailable
        : null;
  const items = pending.data?.items ?? [];

  if (job && here)
    return (
      <Screen>
        <BackBar label={back} onPress={goBack} />
        <JobView
          slug={slug}
          initial={job}
          bottomInset={insets.bottom}
          onHide={goBack}
          onRetry={() => {
            setForm((f) => signInFormForRetry(f));
            setJob(null);
          }}
          onCommand={() => {
            setJob(null);
            setWay('command');
          }}
          onOpen={openServer}
        />
      </Screen>
    );

  return (
    <Screen>
      <BackBar label={back} onPress={goBack} />
      {/* The keyboard pushes the footer up, so Add server stays in sight while the password is typed (AP-1697). */}
      <KeyboardAvoidingView style={{ flex: 1 }}>
        {refusal || status.isPending || !here ? (
          <ScrollView contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24, gap: 18 }}>
            <Title>{ADD_SERVER_COPY.title}</Title>
            {refusal ? (
              <QuietText>{refusal}</QuietText>
            ) : (
              <SkeletonRows count={4} lines={2} label={tMobile('managed.loading')} />
            )}
          </ScrollView>
        ) : way === 'signIn' ? (
          <SignInOnce
            header={header(items.length ? <WaitingForYou slug={slug} items={items} now={now} /> : null)}
            slug={slug}
            control={control}
            named={!!prefill.name}
            form={form}
            setForm={setForm}
            bottomInset={insets.bottom}
            onStarted={(started) => {
              // The password went with the job: the form doesn't keep it (SI-03).
              setForm((f) => signInFormForRetry(f));
              setJob(started);
            }}
          />
        ) : (
          <RunCommand
            header={header(items.length ? <WaitingForYou slug={slug} items={items} now={now} /> : null)}
            slug={slug}
            control={control}
            windows={way === 'windows'}
            commands={commands}
            onMade={(level, e) => setCommands((m) => ({ ...m, [level]: e }))}
            bottomInset={insets.bottom}
            onOpen={openServer}
            onDone={goBack}
          />
        )}
      </KeyboardAvoidingView>
    </Screen>
  );

  /** What both ways share at the top: the title, servers waiting for you, the level and the two ways. */
  function header(waiting: ReactNode) {
    return (
      <>
        <Title>{ADD_SERVER_COPY.title}</Title>
        {waiting}
        <LevelControl value={control} onChange={setControl} />
        <Segmented<Way>
          label={ADD_SERVER_COPY.ways}
          value={way}
          onChange={setWay}
          options={[
            { value: 'signIn', label: signInCopyHere.tab },
            { value: 'command', label: commandCopyHere.tab },
            { value: 'windows', label: windowsCopy(rawLocale).tab },
          ]}
        />
      </>
    );
  }
}

/** A way's page: the shared top and the way's own parts scroll, its buttons stay at the bottom. */
function Panel({ children, footer }: { children: ReactNode; footer: ReactNode }) {
  return (
    <>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24, gap: 18 }}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
      {footer}
    </>
  );
}

function Title({ children }: { children: string }) {
  return (
    <Text size={28} weight={700} tracking={-0.02} accessibilityRole="header">
      {children}
    </Text>
  );
}

function Footer({ bottomInset, children }: { bottomInset: number; children: ReactNode }) {
  const theme = useTheme();
  // With the keyboard up the gesture area is under it: the footer sits on the keyboard and moves with it (the
  // composer's rule).
  const padding = useKeyboardPadding(bottomPadding(36, bottomInset, 12), 12);
  return (
    <Reanimated.View
      style={[
        {
          gap: 10,
          paddingTop: 10,
          paddingHorizontal: 16,
          borderTopWidth: 1,
          borderTopColor: theme.colors.line,
          backgroundColor: theme.colors.bg,
        },
        padding,
      ]}
    >
      {children}
    </Reanimated.View>
  );
}

/* What Whombat may do (SI-06) --------------------------------------------------------------------------------------- */

/**
 * The three levels as one radio group (the mock's control: the chosen one raised and bold, two lines where a title
 * needs them), and the chosen level's line under it.
 */
function LevelControl({
  value,
  onChange,
}: {
  value: HostControlLevel;
  onChange: (v: HostControlLevel) => void;
}) {
  const { rawLocale } = useI18n();
  const hostControlLevelWordsHere = hostControlLevelWords(rawLocale);

  const theme = useTheme();
  return (
    <View style={{ gap: 8 }}>
      <Text size={13} weight={500} color={theme.colors.ink2}>
        {hostControlQuestion(rawLocale)}
      </Text>
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={hostControlQuestion(rawLocale)}
        style={{
          flexDirection: 'row',
          gap: 2,
          padding: 3,
          borderRadius: 12,
          backgroundColor: theme.colors.sf2,
        }}
      >
        {HOST_CONTROL_LEVELS.map((level) => {
          const selected = level === value;
          const words = hostControlLevelWordsHere[level];
          return (
            <Touchable
              key={level}
              accessibilityRole="radio"
              accessibilityState={{ selected, checked: selected }}
              accessibilityLabel={words.title}
              accessibilityHint={words.line}
              onPress={() => onChange(level)}
              feedback={selected ? 'none' : 'wash'}
              ringRadius={9}
              style={{
                flex: 1,
                minHeight: 48,
                paddingHorizontal: 6,
                paddingVertical: 6,
                borderRadius: 9,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: selected ? theme.colors.sf : 'transparent',
                borderWidth: selected ? 1 : 0,
                borderColor: theme.colors.line,
              }}
            >
              <Text
                size={13.5}
                lh={1.3}
                weight={selected ? 600 : 500}
                color={selected ? theme.colors.ink : theme.colors.ink2}
                numberOfLines={2}
                style={{ textAlign: 'center' }}
              >
                {words.title}
              </Text>
            </Touchable>
          );
        })}
      </View>
      <Text size={13} lh={1.45} color={theme.colors.mut} accessibilityLiveRegion="polite">
        {hostControlLevelWordsHere[value].line}
      </Text>
    </View>
  );
}

/* Sign in once (SI-02, SI-09) --------------------------------------------------------------------------------------- */

/** No autofill, autocorrect or suggestions on the address and the user name (and no “save password?” afterwards). */
const PLAIN_INPUT = {
  autoCapitalize: 'none',
  autoCorrect: false,
  autoComplete: 'off',
  importantForAutofill: 'no',
  spellCheck: false,
  textContentType: 'none',
} as const;

function SignInOnce({
  header,
  slug,
  control,
  named,
  form: f,
  setForm,
  bottomInset,
  onStarted,
}: {
  header: ReactNode;
  slug: string;
  control: HostControlLevel;
  /** The link named the server: its name is a field (the web's). */
  named: boolean;
  form: SignInForm;
  setForm: (update: (f: SignInForm) => SignInForm) => void;
  bottomInset: number;
  onStarted: (job: HostInstall) => void;
}) {
  const { rawLocale } = useI18n();
  const ADD_SERVER_COPY = addServerCopy(rawLocale);
  const signInCopyHere = signInCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const start = useHostsChange(api.hosts.startInstall);
  const [errors, setErrors] = useState<SignInErrors>({});
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needKeys = f.method === 'vault' || f.keepKey;
  const vault = useVault(needKeys ? { params: { burrow: slug } } : null);
  const keys = useMemo(() => keyRows(vault.data?.entries ?? []), [vault.data]);
  const set = <K extends keyof SignInForm>(k: K, v: SignInForm[K]) => {
    setForm((x) => ({ ...x, [k]: v }));
    setErrors((e) => (k in e ? { ...e, [k]: undefined } : e));
    setRefusal(null);
  };
  // The pickers show their defaults until the person picks (SI-09 starts at the key they sign in with): computed, so a
  // key list read again never overrides a choice (the web's `withKeyDefaults`).
  const g = useMemo(() => withKeyDefaults(f, keys), [f, keys]);

  const submit = async () => {
    if (busy) return;
    const errs = signInFormErrors(g, rawLocale);
    setErrors(errs);
    setRefusal(null);
    if (Object.values(errs).some(Boolean)) return;
    setBusy(true);
    try {
      const r = await start.mutateAsync({ params: { burrow: slug }, body: installBody(g, control) });
      if (r.status === 'ok') onStarted(r.data);
      else setRefusal(commitOutcomeText(r, rawLocale));
    } catch (err) {
      const info = hostErrorInfo(err, rawLocale);
      const fields: SignInErrors = {};
      for (const k of ['address', 'username', 'name'] as const)
        if (info.fields[k]) fields[k] = info.fields[k];
      if (info.fields['auth.password']) fields.password = info.fields['auth.password'];
      setErrors(fields);
      setRefusal(Object.keys(fields).length ? null : info.message);
    } finally {
      // The password lives in the form only until it is sent (SI-03): the mutation forgets its input too.
      start.reset();
      setBusy(false);
    }
  };

  return (
    <Panel
      footer={
        <Footer bottomInset={bottomInset}>
          <FormMessage text={refusal} />
          <Button
            label={busy ? signInCopyHere.adding : signInCopyHere.add}
            size="lg"
            busy={busy}
            onPress={() => void submit()}
          />
        </Footer>
      }
    >
      {header}
      <View style={{ gap: 16 }}>
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'flex-start' }}>
          <View style={{ flex: 1.75, minWidth: 0 }}>
            <FormField
              label={signInCopyHere.address}
              value={f.address}
              onChangeText={(v) => set('address', v)}
              placeholder={signInCopyHere.addressPlaceholder}
              error={errors.address}
              mono
              keyboardType="url"
              maxLength={255}
              returnKeyType="next"
              {...PLAIN_INPUT}
            />
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <FormField
              label={signInCopyHere.username}
              value={f.username}
              onChangeText={(v) => set('username', v)}
              error={errors.username}
              mono
              maxLength={64}
              returnKeyType="next"
              {...PLAIN_INPUT}
            />
          </View>
        </View>
        {f.method === 'password' ? (
          <View style={{ gap: 2 }}>
            <FormField
              label={signInCopyHere.password}
              value={f.password}
              onChangeText={(v) => set('password', v)}
              error={errors.password}
              hint={signInCopyHere.passwordHint}
              secret
              maxLength={1024}
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
            />
            <TextLink label={ADD_SERVER_COPY.useKey} onPress={() => set('method', 'vault')} />
          </View>
        ) : (
          <View style={{ gap: 8 }}>
            <Text size={13} weight={500} color={theme.colors.ink2}>
              {signInCopyHere.key}
            </Text>
            {vault.isPending ? (
              <SkeletonRows count={2} lines={1} label={tMobile('screens.loading-your-keys')} />
            ) : keys.length ? (
              <KeyChoices
                label={signInCopyHere.key}
                keys={keys}
                value={g.entryId}
                onChange={(id) => set('entryId', id)}
              />
            ) : (
              <QuietText>{signInCopyHere.noKeys}</QuietText>
            )}
            <FormMessage text={errors.entryId} />
            <TextLink label={signInCopyHere.usePassword} onPress={() => set('method', 'password')} />
            <FormField
              label={signInCopyHere.sudoPassword}
              value={f.sudoPassword}
              onChangeText={(v) => set('sudoPassword', v)}
              secret
              maxLength={1024}
              returnKeyType="go"
              onSubmitEditing={() => void submit()}
            />
          </View>
        )}
        {named ? (
          <FormField
            label={signInCopyHere.name}
            value={f.name}
            onChangeText={(v) => set('name', v)}
            error={errors.name}
            mono
            maxLength={63}
            {...PLAIN_INPUT}
          />
        ) : null}
        <View style={{ gap: 10 }}>
          <Tickbox label={signInCopyHere.keepKey} on={f.keepKey} onPress={() => set('keepKey', !f.keepKey)} />
          {f.keepKey ? (
            <View style={{ gap: 8, paddingLeft: 34 }}>
              <Text size={13} weight={500} color={theme.colors.ink2}>
                {signInCopyHere.keepKeyWhich}
              </Text>
              <KeyChoices
                label={signInCopyHere.keepKeyWhich}
                keys={keys}
                value={g.keepKeyEntry || NEW_KEY}
                onChange={(id) => set('keepKeyEntry', id)}
                withNew
              />
            </View>
          ) : null}
        </View>
      </View>
    </Panel>
  );
}

/** A 44dp text button in `brand` (“Or use a key from the Vault”). */
function TextLink({ label, onPress }: { label: string; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="fade"
      ringRadius={8}
      style={{ minHeight: 44, justifyContent: 'center', alignSelf: 'flex-start' }}
    >
      <Text size={14} weight={500} color={theme.colors.brand}>
        {label}
      </Text>
    </Touchable>
  );
}

/** SI-09's checkbox (off at first): the box and its words, one 44dp checkbox for TalkBack. */
function Tickbox({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  const theme = useTheme();
  return (
    <Touchable
      onPress={onPress}
      feedback="wash"
      ringRadius={10}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={label}
      style={{ minHeight: 44, flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 4 }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          marginTop: 1,
          borderRadius: 6,
          borderWidth: on ? 0 : 1.5,
          borderColor: theme.colors.line2,
          backgroundColor: on ? theme.colors.btn : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {on ? <Check size={15} color={theme.colors.btnfg} strokeWidth={2.5} /> : null}
      </View>
      <Text size={14.5} lh={1.45} style={{ flex: 1 }}>
        {label}
      </Text>
    </Touchable>
  );
}

/** The person's SSH keys as radio rows (name over its short fingerprint); with `withNew` “Make a new key” last. */
function KeyChoices({
  label,
  keys,
  value,
  onChange,
  withNew = false,
}: {
  label: string;
  keys: readonly KeyRow[];
  value: string;
  onChange: (id: string) => void;
  withNew?: boolean;
}) {
  const { rawLocale } = useI18n();
  const signInCopyHere = signInCopy(rawLocale);
  const theme = useTheme();
  const options = [
    ...keys.map((k) => ({
      id: k.id,
      title: k.name,
      line: k.short,
      spoken: `${k.name}, ${k.fingerprint}`,
      mono: true,
    })),
    ...(withNew
      ? [
          {
            id: NEW_KEY,
            title: signInCopyHere.newKey,
            line: signInCopyHere.newKeyHint,
            spoken: `${signInCopyHere.newKey}. ${signInCopyHere.newKeyHint}`,
            mono: false,
          },
        ]
      : []),
  ];
  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      style={{
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.line2,
        backgroundColor: theme.colors.sf,
        overflow: 'hidden',
      }}
    >
      {options.map((o, i) => {
        const selected = o.id === value;
        return (
          <Touchable
            key={o.id}
            onPress={() => onChange(o.id)}
            feedback="wash"
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, selected }}
            accessibilityLabel={o.spoken}
            style={{
              minHeight: 52,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 12,
              paddingVertical: 9,
              paddingHorizontal: 12,
              borderTopWidth: i === 0 ? 0 : 1,
              borderTopColor: theme.colors.line,
            }}
          >
            <View
              style={{
                width: 20,
                height: 20,
                borderRadius: 10,
                borderWidth: selected ? 6 : 1.5,
                borderColor: selected ? theme.colors.btn : theme.colors.line2,
              }}
            />
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              <Text size={15} weight={600} numberOfLines={1}>
                {o.title}
              </Text>
              {o.line ? (
                <Text size={o.mono ? 12 : 13} mono={o.mono} color={theme.colors.mut} numberOfLines={2}>
                  {o.line}
                </Text>
              ) : null}
            </View>
          </Touchable>
        );
      })}
    </View>
  );
}

/* Run a command (SI-01, SI-06, SI-07) ------------------------------------------------------------------------------- */

/** The command's code block and its copy button, or “Making the command…”, or why it couldn't be made. */
function CommandBlock({
  enrollment,
  error,
  windows = false,
}: {
  enrollment: HostEnrollment | undefined;
  error: string | null;
  /** The Windows PC's PowerShell line instead, with how to remove the agent again. */
  windows?: boolean;
}) {
  const { rawLocale } = useI18n();
  const commandCopyHere = commandCopy(rawLocale);
  const windowsCopyHere = windowsCopy(rawLocale);
  const theme = useTheme();
  // A Whombat from before Windows PCs, or one without a Windows agent yet, makes no PowerShell line.
  const line = windows ? enrollment?.installCommandWindows : enrollment?.installCommand;
  if (enrollment && !line)
    return (
      <Text size={15} lh={1.5} color={theme.colors.ink2}>
        {windowsCopyHere.none}
      </Text>
    );
  if (enrollment && line)
    return (
      <>
        <View style={{ backgroundColor: theme.colors.code, borderRadius: 10, padding: 12 }}>
          <Text size={12.5} lh={1.55} mono color={theme.code.text} selectable>
            {line}
          </Text>
        </View>
        <Button
          label={commandCopyHere.copy}
          variant="secondary"
          onPress={() => void copyToClipboard(line, commandCopyHere.copied, rawLocale)}
        />
        <Text size={13} lh={1.45} color={theme.colors.mut}>
          {windows ? windowsCopyHere.valid : commandCopyHere.valid}
        </Text>
        {windows ? (
          <View style={{ gap: 8, marginTop: 6 }}>
            <Text size={14} weight={600}>
              {windowsCopyHere.removeTitle}
            </Text>
            <Text size={13} lh={1.45} color={theme.colors.mut}>
              {windowsCopyHere.remove}
            </Text>
            <View style={{ backgroundColor: theme.colors.code, borderRadius: 10, padding: 12 }}>
              <Text size={12.5} lh={1.55} mono color={theme.code.text} selectable>
                {HOST_WINDOWS_UNINSTALL_COMMAND}
              </Text>
            </View>
            <Button
              label={windowsCopyHere.copyRemove}
              variant="secondary"
              onPress={() =>
                void copyToClipboard(HOST_WINDOWS_UNINSTALL_COMMAND, commandCopyHere.copied, rawLocale)
              }
            />
          </View>
        ) : null}
      </>
    );
  if (error) return <ErrorState text={error} />;
  return (
    <View
      accessible
      accessibilityLabel={commandCopyHere.making}
      style={{ backgroundColor: theme.colors.code, borderRadius: 10, padding: 12 }}
    >
      <Text size={12.5} mono color={theme.code.command}>
        {commandCopyHere.making}
      </Text>
    </View>
  );
}

/** Makes an enrollment once per `key` (a level, or the old command); the error when it couldn't. */
function useCommand(
  slug: string,
  key: string,
  body: { control: HostControlLevel } | null,
  made: HostEnrollment | undefined,
  onMade: (e: HostEnrollment) => void,
): string | null {
  const { rawLocale } = useI18n();

  const create = useHostsChange(api.hosts.createEnrollment);
  const createRef = useRef(create.mutateAsync);
  createRef.current = create.mutateAsync;
  const onMadeRef = useRef(onMade);
  onMadeRef.current = onMade;
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(new Set<string>());
  const control = body?.control ?? null;
  useEffect(() => {
    if (made || asked.current.has(key)) return;
    asked.current.add(key);
    setError(null);
    createRef
      .current(control ? { params: { burrow: slug }, body: { control } } : { params: { burrow: slug } })
      .then((r) => {
        if (r.status === 'ok') onMadeRef.current(r.data);
        else setError(commitOutcomeText(r, rawLocale) ?? addServerCopy(rawLocale).commandFailed);
      })
      .catch((err: unknown) => {
        asked.current.delete(key);
        setError(hostErrorInfo(err, rawLocale).message);
      });
  }, [slug, key, control, made, rawLocale]);
  return error;
}

/**
 * The pre-approved command for the chosen level (a new one when the level changes; one made earlier for a level shows
 * again), and once it has run the server it added (“web-04 is added.”, Open web-04).
 */
function RunCommand({
  header,
  slug,
  control,
  windows,
  commands,
  onMade,
  bottomInset,
  onOpen,
  onDone,
}: {
  header: ReactNode;
  slug: string;
  control: HostControlLevel;
  /** The same enrollment's PowerShell line for a Windows PC. */
  windows: boolean;
  commands: Partial<Record<HostControlLevel, HostEnrollment>>;
  onMade: (level: HostControlLevel, e: HostEnrollment) => void;
  bottomInset: number;
  onOpen: (serverId: string, name: string) => void;
  onDone: () => void;
}) {
  const { rawLocale } = useI18n();
  const ADD_SERVER_COPY = addServerCopy(rawLocale);
  const commandCopyHere = commandCopy(rawLocale);
  const theme = useTheme();
  const enrollment = commands[control];
  const error = useCommand(slug, control, { control }, enrollment, (e) => onMade(control, e));
  // Pre-approved: once the command has run the server is added; the list says which (its frame, else every 10 s).
  const all = useHostEnrollments(enrollment ? { params: { burrow: slug }, query: { state: 'all' } } : null, {
    refetchInterval: 10_000,
  });
  const done = commandOutcome(enrollment?.id ?? null, all.data?.items ?? [], rawLocale);
  return (
    <Panel
      footer={
        done ? (
          <Footer bottomInset={bottomInset}>
            <Button
              label={ADD_SERVER_COPY.open(done.serverId)}
              size="lg"
              onPress={() => onOpen(done.serverId, done.serverId)}
            />
            <Button label={ADD_SERVER_COPY.done} size="lg" variant="secondary" onPress={onDone} />
          </Footer>
        ) : null
      }
    >
      {header}
      <View style={{ gap: 12 }}>
        <Text size={15} lh={1.5} color={theme.colors.ink2}>
          {windows ? `${windowsCopy(rawLocale).lead} ${windowsCopy(rawLocale).how}` : commandCopyHere.lead}
        </Text>
        <CommandBlock enrollment={enrollment} error={error} windows={windows} />
        {done ? (
          <Text size={15} lh={1.5} weight={500} accessibilityLiveRegion="polite">
            {done.text}
          </Text>
        ) : null}
      </View>
    </Panel>
  );
}

/* Waiting for you (commands made before SI-07) ---------------------------------------------------------------------- */

function WaitingForYou({
  slug,
  items,
  now,
  old = false,
}: {
  slug: string;
  items: readonly HostPendingEnrollment[];
  now: number;
  old?: boolean;
}) {
  const { rawLocale } = useI18n();
  const ADD_SERVER_COPY = addServerCopy(rawLocale);
  const commandCopyHere = commandCopy(rawLocale);
  const theme = useTheme();
  const rows = pendingRows(items, now, rawLocale);
  return (
    <View style={{ gap: 8 }}>
      <Text size={11} weight={500} mono tracking={0.05} color={theme.colors.mut} accessibilityRole="header">
        {commandCopyHere.waiting.toUpperCase()}
      </Text>
      {rows.length ? (
        rows.map((row) => <PendingRow key={row.id} slug={slug} row={row} />)
      ) : old ? (
        <Text size={14} lh={1.45} color={theme.colors.ink2}>
          {ADD_SERVER_COPY.noneWaiting}
        </Text>
      ) : null}
    </View>
  );
}

function PendingRow({ slug, row }: { slug: string; row: PendingRowView }) {
  const { rawLocale } = useI18n();
  const ADD_SERVER_COPY = addServerCopy(rawLocale);

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const approve = useHostsChange(api.hosts.approveEnrollment);
  const reject = useHostsChange(api.hosts.rejectEnrollment);
  const [name, setName] = useState(row.hostname ?? '');
  const [busy, setBusy] = useState(false);
  const bad = serverNameProblem(name, rawLocale);
  const run = async (go: () => Promise<Parameters<typeof commitOutcomeText>[0]>, done: string) => {
    setBusy(true);
    try {
      const r = await go();
      if (r.status === 'ok') showNotice(done);
      else Alert.alert(tMobile('screens.not-yet'), commitOutcomeText(r, rawLocale) ?? '');
    } catch (err) {
      Alert.alert(tMobile('managed.that-didnt-go-through'), hostErrorInfo(err, rawLocale).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View
      style={{
        gap: 10,
        padding: 14,
        borderRadius: 16,
        borderWidth: 1,
        borderColor: theme.colors.line,
        backgroundColor: theme.colors.sf,
      }}
    >
      <View style={{ gap: 2 }}>
        <Text size={14.5} weight={500} mono>
          {row.title}
        </Text>
        {row.meta ? (
          <Text size={13} color={theme.colors.mut}>
            {row.meta}
          </Text>
        ) : null}
        {row.asked ? (
          <Text size={11.5} mono color={theme.colors.mut}>
            {row.asked}
          </Text>
        ) : null}
      </View>
      <FormField
        label={ADD_SERVER_COPY.name}
        value={name}
        onChangeText={setName}
        error={name ? bad : null}
        mono
        maxLength={63}
        {...PLAIN_INPUT}
      />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          label={ADD_SERVER_COPY.notThisOne}
          variant="secondary"
          disabled={busy}
          style={{ flex: 1 }}
          onPress={() =>
            void run(
              () => reject.mutateAsync({ params: { burrow: slug, enrollmentId: row.id } }),
              ADD_SERVER_COPY.turnedAway(row.hostname ?? 'it'),
            )
          }
        />
        <Button
          label={ADD_SERVER_COPY.addIt}
          disabled={busy || !!bad}
          style={{ flex: 1 }}
          onPress={() =>
            void run(
              () =>
                approve.mutateAsync({
                  params: { burrow: slug, enrollmentId: row.id },
                  body: { name: name.trim() },
                }),
              ADD_SERVER_COPY.added(name.trim()),
            )
          }
        />
      </View>
    </View>
  );
}

/* The job, step by step (SI-02, SI-04, SI-07, SI-08, SI-11) --------------------------------------------------------- */

function JobView({
  slug,
  initial,
  bottomInset,
  onHide,
  onRetry,
  onCommand,
  onOpen,
}: {
  slug: string;
  initial: HostInstall;
  bottomInset: number;
  onHide: () => void;
  onRetry: () => void;
  /** Run a command instead (a server that can't reach the Whombat this way, connect-in-chat.md). */
  onCommand: () => void;
  onOpen: (serverId: string, name: string) => void;
}) {
  const { rawLocale } = useI18n();
  const ADD_SERVER_COPY = addServerCopy(rawLocale);

  const theme = useTheme();
  const followed = useHostInstall(slug, initial.id);
  const fleet = useHostsFleet({ params: { burrow: slug } }, { retry: false });
  const refresh = useRefreshHosts();
  const view = followed.data ?? initial;
  const running = installRunning(view);
  const names = (fleet.data?.servers ?? []).flatMap((x) => [x.id, x.name]);
  const steps = installSteps(view, rawLocale);
  const note = installHostKeyNote(view, rawLocale);
  const outcome = installOutcome(view, names, rawLocale);
  const lost = followed.error && !followed.data ? hostErrorInfo(followed.error, rawLocale).message : null;
  const failed = lost ? { text: lost, detail: null } : outcome?.kind === 'failed' ? outcome : null;
  const added = outcome && outcome.kind !== 'failed' ? outcome : null;
  // One plain card with the one step that helps (connect-in-chat.md); a lost job only says so.
  const card = !lost && outcome?.kind === 'failed' ? installFailureCard(view, outcome, rawLocale) : null;
  const trust = useVaultWrite(api.vault.trustSshHostKey, slug);
  const [trustProblem, setTrustProblem] = useState<string | null>(null);
  const [detail, setDetail] = useState(false);

  /** Trusts the key the server showed on every Vault server that trusted the old one, then back to the form. */
  async function trustNewKey() {
    const fingerprint = view.hostKey?.fingerprint;
    if (!fingerprint) return;
    setTrustProblem(null);
    try {
      for (const pin of view.pins ?? [])
        await trust.mutateAsync({ params: { burrow: slug, ...pin }, body: { fingerprint } });
      onRetry();
    } catch {
      setTrustProblem(installKeyChangedAgain(rawLocale));
    }
  }
  useEffect(() => {
    if (!running) refresh(['hosts.fleet', 'hosts.status', 'home.overview']);
  }, [running, refresh]);
  // Leaving while it runs: Whombat carries on (the web's note on Hide).
  const leaving = useRef({ running, name: view.serverName, locale: rawLocale });
  leaving.current = { running, name: view.serverName, locale: rawLocale };
  useEffect(
    () => () => {
      if (leaving.current.running) showNotice(carriesOnText(leaving.current.name, leaving.current.locale));
    },
    [],
  );
  return (
    <>
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 24, gap: 16 }}
        showsVerticalScrollIndicator={false}
      >
        <Title>{installTitle(view, rawLocale)}</Title>
        <View accessibilityLiveRegion="polite">
          {steps.map((step, i) => (
            <StepRow key={step.key} step={step} first={i === 0} />
          ))}
        </View>
        {note ? (
          <View
            accessible
            accessibilityLabel={`${note.before}${note.fingerprint}${note.after}`}
            style={{
              padding: 12,
              borderRadius: 12,
              borderWidth: 1,
              borderColor: theme.colors.line,
              backgroundColor: theme.colors.sf,
            }}
          >
            <Text size={13.5} lh={1.5} color={theme.colors.ink2}>
              {note.before}
              <Text size={12.5} lh={1.5} mono weight={600} color={theme.colors.ink}>
                {note.fingerprint}
              </Text>
              {note.after}
            </Text>
          </View>
        ) : null}
        {added ? (
          <Text size={15} lh={1.5} weight={500} accessibilityLiveRegion="polite">
            {added.text}
          </Text>
        ) : null}
        {card ? (
          <View style={{ gap: 4 }} accessibilityLiveRegion="polite">
            <Text size={15} lh={1.5} weight={500}>
              {card.title}
            </Text>
            {card.text ? (
              <Text size={14} lh={1.5} color={theme.colors.ink2}>
                {card.text}
              </Text>
            ) : null}
            {trustProblem ? (
              <Text size={14} lh={1.5} color={theme.colors.bad}>
                {trustProblem}
              </Text>
            ) : null}
          </View>
        ) : failed ? (
          <Text size={15} lh={1.5} weight={500} color={theme.colors.bad} accessibilityLiveRegion="polite">
            {failed.text}
          </Text>
        ) : null}
        {failed?.detail ? (
          <View style={{ gap: 4 }}>
            <TextLink
              label={detail ? ADD_SERVER_COPY.lessDetail : ADD_SERVER_COPY.moreDetail}
              onPress={() => setDetail((d) => !d)}
            />
            {detail ? (
              <View style={{ backgroundColor: theme.colors.code, borderRadius: 10, padding: 12 }}>
                <Text size={12} lh={1.55} mono color={theme.code.text} selectable>
                  {failed.detail}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
      <Footer bottomInset={bottomInset}>
        {added ? (
          <>
            <Button
              label={ADD_SERVER_COPY.open(added.serverName)}
              size="lg"
              onPress={() => onOpen(added.serverId, added.serverName)}
            />
            <Button label={ADD_SERVER_COPY.done} size="lg" variant="secondary" onPress={onHide} />
          </>
        ) : card ? (
          <>
            <Button
              label={card.label}
              size="lg"
              disabled={trust.isPending}
              onPress={() =>
                card.step === 'command' ? onCommand() : card.step === 'trust' ? void trustNewKey() : onRetry()
              }
            />
            <Button
              label={card.step === 'trust' ? ADD_SERVER_COPY.no : ADD_SERVER_COPY.close}
              size="lg"
              variant="secondary"
              onPress={onHide}
            />
          </>
        ) : failed ? (
          <>
            <Button label={ADD_SERVER_COPY.tryAgain} size="lg" onPress={onRetry} />
            <Button label={ADD_SERVER_COPY.close} size="lg" variant="secondary" onPress={onHide} />
          </>
        ) : (
          <Button label={ADD_SERVER_COPY.hide} size="lg" variant="secondary" onPress={onHide} />
        )}
      </Footer>
    </>
  );
}

/** A step: its mark (✓ done, a spinner now, an empty ring next or not yet, ✗ where it stopped), words, what it runs. */
function StepRow({ step, first }: { step: InstallStep; first: boolean }) {
  const { rawLocale } = useI18n();
  const theme = useTheme();
  const mark = (() => {
    switch (step.state) {
      case 'done':
        return (
          <View style={[MARK, { backgroundColor: theme.colors.ok }]}>
            <Check size={14} color={theme.colors.bg} strokeWidth={3} />
          </View>
        );
      case 'failed':
        return (
          <View style={[MARK, { backgroundColor: theme.colors.bad }]}>
            <X size={14} color={theme.colors.bg} strokeWidth={3} />
          </View>
        );
      case 'active':
        return (
          <View style={MARK}>
            <ActivityIndicator size="small" color={theme.colors.brand} />
          </View>
        );
      case 'late':
        return <View style={[MARK, { borderWidth: 1.5, borderColor: theme.colors.warn }]} />;
      case 'todo':
        return <View style={[MARK, { borderWidth: 1.5, borderColor: theme.colors.line2 }]} />;
    }
  })();
  const quiet = step.state === 'todo';
  return (
    <View
      accessible
      accessibilityLabel={stepSpoken(step, rawLocale)}
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 12,
        paddingVertical: 12,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      {/* Keyed by state: a view that gains a background after the spinner otherwise loses its round corners. */}
      <View key={step.state}>{mark}</View>
      <View style={{ flex: 1, minWidth: 0, gap: 3, paddingTop: 1 }}>
        <Text size={15.5} lh={1.35} color={quiet ? theme.colors.mut : theme.colors.ink}>
          {step.label}
        </Text>
        {step.sub && !quiet ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {step.sub}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const MARK = {
  width: 22,
  height: 22,
  borderRadius: 11,
  alignItems: 'center' as const,
  justifyContent: 'center' as const,
};
