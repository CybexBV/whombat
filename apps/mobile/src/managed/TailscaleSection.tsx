/**
 * TAILSCALE on This Whombat, after NETWORK (Whombat hermes-engine.md HE-51; hermes-engine-app.md AP-5378), the web's
 * section (AP-5326) on a phone: “Reach this Whombat over Tailscale”. One row in NETWORK's look — Off with **Turn on**;
 * Sign in to Tailscale with **Sign in** (Tailscale's own page in the browser), asked again every 2 s until it is on;
 * On, its name in its tailnet beneath, with **Turn off** (asked first). A box without Tailscale (development) shows
 * nothing. Every word is the client's `tailscaleTextHere`; `tailscaleView` decides the row.
 * Every target 44dp.
 */
import {
  type HostTailscaleOutput,
  type TailscaleAction,
  tailscaleAnswer,
  tailscaleErrorText,
  tailscaleText,
  tailscaleView,
} from '@whombat/client';
import { useCallback, useEffect, useState } from 'react';
import { Alert, View } from 'react-native';
import { mobileTranslator, useI18n } from '../i18n';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { Button } from '../ui/primitives';
import { LoginServerSheet } from './LoginServerSheet';
import { Card, Row } from './ui';
import { useForeground } from './useHostStatus';
import type { TailscaleHere } from './useTailscale';

function label(action: TailscaleAction, locale?: string | null): string {
  const T = tailscaleText(locale);
  switch (action) {
    case 'turn_on':
      return T.turnOn;
    case 'sign_in':
      return T.openSignIn;
    case 'new_link':
      return T.newLink;
    case 'turn_off':
      return T.turnOff;
    case 'try_again':
      return T.tryAgain;
  }
}

/** TAILSCALE, or nothing (no Whombat to ask, or one without Tailscale). */
export function TailscaleSection({ here }: { here: TailscaleHere | null }) {
  const { rawLocale } = useI18n();
  const T = tailscaleText(rawLocale);
  const theme = useTheme();
  const foreground = useForeground();
  const [answer, setAnswer] = useState<HostTailscaleOutput | null>(null);
  const [asked, setAsked] = useState(0);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const api = here?.api ?? null;

  const read = useCallback(() => {
    api?.state().then(setAnswer, () => setAnswer({ tailscale: null, reason: 'unavailable' }));
  }, [api]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `asked` asks again.
  useEffect(read, [read, asked]);
  const v = tailscaleView(answer, rawLocale);
  // While it starts, waits for a sign-in or for the tailnet's approval, it is asked again (in the foreground only);
  // each answer starts the wait over.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `answer` starts the next wait.
  useEffect(() => {
    if (!v.pollMs || !foreground) return;
    const t = setTimeout(() => setAsked((n) => n + 1), v.pollMs);
    return () => clearTimeout(t);
  }, [v.pollMs, answer, foreground]);

  if (!here || !api || !answer || v.hidden) return null;
  const ts = api;

  const change = async (run: () => ReturnType<typeof ts.on>) => {
    setBusy(true);
    setNote(null);
    try {
      setAnswer(tailscaleAnswer(await run()));
    } catch (error) {
      setNote(tailscaleErrorText(error, rawLocale));
    } finally {
      setBusy(false);
    }
  };
  const act = (action: TailscaleAction) => {
    if (action === 'turn_on') void change(() => ts.on());
    else if (action === 'new_link') void change(() => ts.signIn());
    else if (action === 'sign_in' && v.loginUrl) {
      here.openSignIn(v.loginUrl);
      setAsked((n) => n + 1);
    } else if (action === 'try_again') setAsked((n) => n + 1);
    else if (action === 'turn_off')
      Alert.alert(T.offConfirmTitle, T.offConfirm, [
        { text: mobileTranslator(rawLocale).t('managed2.cancel'), style: 'cancel' },
        { text: T.turnOff, style: 'destructive', onPress: () => void change(() => ts.off()) },
      ]);
  };

  const [main, ...rest] = v.actions;
  return (
    <Card label={T.section}>
      <Row
        first
        dot={v.dot}
        title={v.title}
        meta={v.meta}
        action={
          main ? (
            <Button
              label={label(main, rawLocale)}
              variant={main === 'turn_off' ? 'secondary' : 'primary'}
              disabled={busy}
              onPress={() => act(main)}
              style={{ paddingHorizontal: 14 }}
            />
          ) : null
        }
      />
      {note ? (
        <Text
          size={12}
          mono
          lh={1.45}
          color={theme.colors.bad}
          accessibilityLiveRegion="polite"
          style={{ paddingHorizontal: 16, paddingBottom: 12 }}
        >
          {note}
        </Text>
      ) : null}
      {rest.length > 0 ? (
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'flex-end',
            gap: 8,
            padding: 12,
            borderTopWidth: 1,
            borderTopColor: theme.colors.line,
          }}
        >
          {rest.map((action) => (
            <Button
              key={action}
              label={label(action, rawLocale)}
              variant="secondary"
              disabled={busy}
              onPress={() => act(action)}
              style={{ paddingHorizontal: 14 }}
            />
          ))}
        </View>
      ) : null}
      {here.loginServer ? (
        // Its own login server (community; CT-1306, AP-5476): Tailscale's own, or Headscale and the like.
        <Row
          dot="mut"
          dotLabel={T.loginServer}
          title={T.loginServer}
          meta={v.loginServer ? T.loginServerMeta(v.loginServer) : T.loginServerOwnMeta}
          action={
            <Button
              label={T.change}
              variant="secondary"
              disabled={busy}
              onPress={() => setChanging(true)}
              style={{ paddingHorizontal: 14 }}
            />
          }
        />
      ) : null}
      {here.loginServer ? (
        <LoginServerSheet
          visible={changing}
          current={v.loginServer}
          onClose={() => setChanging(false)}
          onSave={async (server) => {
            const next = await ts.on(server);
            setAnswer(tailscaleAnswer(next));
          }}
        />
      ) : null}
    </Card>
  );
}
