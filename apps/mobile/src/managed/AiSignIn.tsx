/**
 * A provider's sign-in on the phone (Whombat first-day.md): its name and what it takes, then — once started — the same
 * flow as the web's Settings → AI over the session: ChatGPT's device code (copy the code, open OpenAI's page in the
 * in-app browser) or Claude Code's own sign-in (open claude.ai, approve, paste the code it shows back here). Claude Code
 * is installed first when it isn't. Connect your AI uses it; any screen with a client can (Settings → AI).
 */
import type { createClient } from '@whombat/client';
import { connectAiText } from '@whombat/client/managed';
import {
  CLIENT_NAMES,
  type ConsoleDriver,
  type ConsoleDriverState,
  consoleApiOf,
  consoleStep,
  createConsoleDriver,
  createSignInOutputWatcher,
  deviceStep,
  isCodeShaped,
  readSignInOutput,
  SIGNIN_TEXT,
  type SignInOutput,
  SUBSCRIPTION_MODE,
} from '@whombat/client/signins';
import type { LiveProvider, ProviderLogin } from '@whombat/core/domain';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from '../ui/clipboard';
import { Button, Loading } from '../ui/primitives';
import { openSignInPage } from './openSignInPage';
import { Card, ErrorLine, Field, Note } from './ui';

const S = SIGNIN_TEXT;
type Client = Pick<ReturnType<typeof createClient>, 'signins' | 'clients'>;

/** How often a device code's state is asked (the web's `DEVICE_POLL`). */
const DEVICE_POLL_MS = 3_000;

function ok<R>(r: { status: string; data?: R; message?: string }): R {
  if (r.status !== 'ok') throw new Error(r.message ?? S.failed);
  return r.data as R;
}

export function AiSignInCard({
  provider,
  client,
  ready,
  installed,
  installing,
  onChanged,
}: {
  provider: LiveProvider;
  client: Client;
  ready: boolean;
  installed: boolean;
  installing: boolean;
  onChanged: () => void;
}) {
  const theme = useTheme();
  const [started, setStarted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const name = CLIENT_NAMES[provider];
  const install = async () => {
    setProblem(null);
    try {
      ok(await client.clients.install({ params: { provider } }));
      onChanged();
    } catch (error) {
      setProblem(error instanceof Error ? error.message : S.failed);
    }
  };
  return (
    <Card>
      <View style={{ padding: 16, gap: 10 }}>
        <Text size={17} weight={700}>
          {name}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.ink2}>
          {S.clientBlurb[provider]}
        </Text>
        {ready ? (
          <Note text={S.signedInOther} />
        ) : installing ? (
          <Loading label={S.installing(null)} />
        ) : !installed ? (
          <>
            <Note text={S.needsInstall(name)} />
            <Button label={S.install} variant="secondary" onPress={() => void install()} />
          </>
        ) : started ? (
          provider === 'codex' ? (
            <DeviceSignIn client={client} onSignedIn={onChanged} onClose={() => setStarted(false)} />
          ) : (
            <ConsoleSignIn client={client} onSignedIn={onChanged} onClose={() => setStarted(false)} />
          )
        ) : (
          <Button label={S.subscription} onPress={() => setStarted(true)} />
        )}
        <ErrorLine text={problem} />
      </View>
    </Card>
  );
}

/** ChatGPT: the code to copy, OpenAI's page to open, until it is signed in or the code runs out. */
function DeviceSignIn({
  client,
  onSignedIn,
  onClose,
}: {
  client: Client;
  onSignedIn: () => void;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();
  const T = connectAiText(rawLocale);
  const theme = useTheme();
  const [login, setLogin] = useState<ProviderLogin | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [attempt, setAttempt] = useState(0);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt asks for a new code
  useEffect(() => {
    let live = true;
    setLogin(null);
    setProblem(null);
    client.signins
      .loginStart({ body: { provider: 'codex', authMode: SUBSCRIPTION_MODE.codex } })
      .then(ok<ProviderLogin>)
      .then(
        (l) => live && setLogin(l),
        (error: unknown) => live && setProblem(error instanceof Error ? error.message : S.failed),
      );
    return () => {
      live = false;
    };
  }, [client, attempt]);

  // Ask how it's going until it's over, and count down.
  useEffect(() => {
    if (login?.state !== 'awaiting_user') return;
    const poll = setTimeout(() => {
      client.signins.loginStatus({ params: { loginId: login.loginId } }).then(
        (l) => {
          setLogin(l);
          if (l.state === 'completed') signedIn.current();
        },
        () => setLogin({ ...login }),
      );
    }, DEVICE_POLL_MS);
    const tick = setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      clearTimeout(poll);
      clearInterval(tick);
    };
  }, [client, login]);

  if (problem)
    return <Over text={problem} action={S.device.newCode} onAgain={() => setAttempt((n) => n + 1)} />;
  if (!login) return <Loading label={S.device.waiting} />;
  const at = deviceStep(login, now);
  if (at.kind === 'done') return <Note text={S.device.completed} />;
  if (at.kind === 'over')
    return <Over text={at.text} action={S.device.newCode} onAgain={() => setAttempt((n) => n + 1)} />;
  return (
    <View style={{ gap: 10 }}>
      <Text size={12} weight={500} mono color={theme.colors.mut}>
        {S.device.enter.toUpperCase()}
      </Text>
      <Text size={28} weight={700} mono selectable accessibilityLabel={`${S.device.enter}: ${at.code}`}>
        {at.code}
      </Text>
      <Button
        label={S.device.copy}
        variant="secondary"
        onPress={() => void copyToClipboard(at.code, S.device.copied)}
      />
      <Button label={S.device.open(at.host)} onPress={() => void openSignInPage(at.url)} />
      <Note text={T.phone.deviceHint} />
      <Note text={`${S.device.waiting} · ${S.device.expiresIn(at.expiresIn)}`} />
      <Text size={12.5} lh={1.4} color={theme.colors.mut}>
        {S.device.hint}
      </Text>
      <Button label={S.device.cancel} variant="quiet" onPress={onClose} />
    </View>
  );
}

/** Claude Code: claude.ai's page to open, the code it shows pasted back, until Claude Code says it's signed in. */
function ConsoleSignIn({
  client,
  onSignedIn,
  onClose,
}: {
  client: Client;
  onSignedIn: () => void;
  onClose: () => void;
}) {
  const { rawLocale } = useI18n();
  const T = connectAiText(rawLocale);
  const [state, setState] = useState<ConsoleDriverState>({ phase: 'starting', console: null, error: null });
  const [output, setOutput] = useState<SignInOutput>(() => readSignInOutput(''));
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const driver = useRef<ConsoleDriver | null>(null);
  const promptsAtSend = useRef(0);
  const signedIn = useRef(onSignedIn);
  signedIn.current = onSignedIn;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt starts a new sign-in
  useEffect(() => {
    const watcher = createSignInOutputWatcher();
    setState({ phase: 'starting', console: null, error: null });
    setOutput(readSignInOutput(''));
    setSent(false);
    setCode('');
    const d = createConsoleDriver({
      api: consoleApiOf(client),
      // The phone shows no terminal: Claude Code's own size is enough for its link and prompt.
      cols: 80,
      rows: 24,
      onOutput: (bytes) => setOutput(watcher.push(bytes)),
      onState: (s) => {
        setState(s);
        if (s.phase === 'completed') signedIn.current();
      },
    });
    driver.current = d;
    return () => {
      driver.current = null;
      void d.close();
    };
  }, [client, attempt]);

  // Claude Code asked for the code again (the last one didn't take): back to the field.
  useEffect(() => {
    if (sent && output.prompts > promptsAtSend.current) setSent(false);
  }, [sent, output.prompts]);

  const at = consoleStep({ state, output, sent });
  const send = () => {
    const value = code.trim();
    if (!value) return;
    promptsAtSend.current = output.prompts;
    // The code, then Enter: Claude Code's prompt acts only on Enter.
    driver.current?.input(`${value}\r`);
    setCode('');
    setSent(true);
  };
  const paste = async () => {
    const text = (await Clipboard.getStringAsync().catch(() => '')).trim();
    if (text && isCodeShaped(text)) setCode(text);
  };

  if (at.kind === 'done') return <Note text={S.console.completed} />;
  if (at.kind === 'over')
    return <Over text={at.text} action={at.action} onAgain={() => setAttempt((n) => n + 1)} />;
  if (at.kind === 'starting') return <Loading label={S.console.starting} />;
  if (at.kind === 'checking') return <Loading label={S.console.checking} />;
  return (
    <View style={{ gap: 10 }}>
      <Button label={S.console.open} onPress={() => void openSignInPage(at.url)} />
      <Note text={T.phone.consoleHint} />
      <Field
        label={S.console.code}
        value={code}
        onChangeText={setCode}
        mono
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={send}
      />
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <Button
          label={S.console.paste}
          variant="secondary"
          onPress={() => void paste()}
          style={{ flex: 1 }}
        />
        <Button label={S.console.signIn} onPress={send} disabled={!code.trim()} style={{ flex: 1 }} />
      </View>
      <Button label={S.console.cancel} variant="quiet" onPress={onClose} />
    </View>
  );
}

function Over({ text, action, onAgain }: { text: string; action: string; onAgain: () => void }) {
  return (
    <View style={{ gap: 10 }}>
      <ErrorLine text={text} />
      <Button label={action} variant="secondary" onPress={onAgain} />
    </View>
  );
}
