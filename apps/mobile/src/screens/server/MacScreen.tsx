/**
 * A Mac's Screen segment on the phone (Whombat macos-servers.md MAC-04…MAC-08; MAC-34, MAC-35): a still picture of the
 * screen (`hosts.screenLook`), taken when asked and again on “Look again” — phones have no live consoles, the web has the
 * screen —, Screen Sharing (how to switch it on when it is off), the lock with Unlock the screen, who is at the screen;
 * the Mac's password Whombat signs in with (Set, Check, Forget) in a sheet that never keeps it; Whombat Helper with its
 * Accessibility and “Open the setting on the Mac”. The words are the web's (`macScreenView`, `macStepText`).
 */

import {
  hostErrorInfo,
  MAC_WORDS,
  type MacLine,
  macAccountProblem,
  macScreenView,
  macStepText,
} from '@whombat/client/hosts';
import { useHostScreenLook, useHostScreenStep } from '@whombat/client/hosts/react';
import { HOST_SCREEN_LIMITS, type HostScreenBody, type HostServerDetail } from '@whombat/core';
import { type ReactNode, useState } from 'react';
import { ActivityIndicator, Image, View } from 'react-native';
import { useBurrowBase } from '../../data/BurrowProvider';
import { useI18n, useMobileT } from '../../i18n';
import { Text } from '../../theme/Text';
import { useTheme } from '../../theme/theme';
import { Dot, OneCard, OneRow } from '../../ui/assistant';
import { FormField, FormMessage } from '../../ui/formField';
import { OneSheet } from '../../ui/oneSheet';
import { Button } from '../../ui/primitives';
import { Sheet } from '../../ui/sheet';
import { showFailure, showNotice } from '../feedback';
import { CardQuiet } from '../guest/parts';

/** The picture's width: enough for a phone's screen and a fold's, small enough to come quickly. */
const LOOK_WIDTH = 1280;

const dotTone = (tone: MacLine['tone']) => (tone === 'mut' ? null : tone);

function Lines({ lines, first = false }: { lines: readonly MacLine[]; first?: boolean }) {
  return (
    <>
      {lines.map((l, i) => (
        <OneRow
          key={l.key}
          first={first && i === 0}
          leading={<Dot tone={dotTone(l.tone)} />}
          title={l.title}
          line={l.text}
          label={`${l.title}: ${l.text}`}
        />
      ))}
    </>
  );
}

function Buttons({ children }: { children: ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, padding: 14, paddingTop: 4 }}>
      {children}
    </View>
  );
}

const half = { flexGrow: 1, flexBasis: '45%' } as const;

export function MacScreenPart({
  serverId,
  serverName,
  detail,
  now,
}: {
  serverId: string;
  serverName: string;
  detail: HostServerDetail;
  now: number;
}) {
  const { rawLocale } = useI18n();

  const { t: tMobile } = useMobileT();
  const theme = useTheme();
  const { slug } = useBurrowBase();
  // The person may change their own servers; the server's switches decide the rest.
  const view = macScreenView(detail, { name: serverName, owner: true, now });
  const { step, busy } = useHostScreenStep(slug, serverId, serverName);
  const [looking, setLooking] = useState(false);
  const look = useHostScreenLook(
    looking && view?.screen.can
      ? { params: { burrow: slug, serverId }, query: { maxW: LOOK_WIDTH, format: 'jpeg' } }
      : null,
    { retry: false, staleTime: Number.POSITIVE_INFINITY },
  );
  const [asking, setAsking] = useState<'password' | 'forget' | null>(null);
  if (!view) return null;

  const run = async (body: HostScreenBody) => {
    const out = await step(body);
    if (out.ok) {
      if (out.text) showNotice(out.text);
      // What the screen shows now, when a picture is up.
      if (looking && (body.op === 'unlock' || body.op === 'ui.open')) void look.refetch();
    } else if (out.text) showFailure(out.text);
    return out;
  };

  const shot = look.data;
  const picture = shot?.ok && shot.imageB64 ? shot : null;
  const lookProblem = look.error
    ? hostErrorInfo(look.error, rawLocale).message
    : shot && !shot.ok
      ? macStepText({ op: 'look' }, shot, serverName).text
      : null;

  return (
    <>
      <OneCard label={MAC_WORDS.screenTitle}>
        {looking && view.screen.can ? (
          <View style={{ padding: 14, paddingBottom: 6 }}>
            {picture ? (
              <Image
                source={{ uri: `data:image/${picture.format ?? 'png'};base64,${picture.imageB64}` }}
                resizeMode="contain"
                accessible
                accessibilityLabel={MAC_WORDS.lookAlt(serverName)}
                style={{
                  width: '100%',
                  aspectRatio: picture.w && picture.h ? picture.w / picture.h : 16 / 9,
                  borderRadius: 10,
                  borderWidth: 1,
                  borderColor: theme.colors.line,
                  backgroundColor: theme.colors.sf2,
                }}
              />
            ) : lookProblem ? (
              <Text size={14} lh={1.45} color={theme.colors.mut}>
                {lookProblem}
              </Text>
            ) : (
              <View
                accessible
                accessibilityLabel={tMobile('screens.taking-a-picture-of-the-screen')}
                style={{
                  width: '100%',
                  aspectRatio: 16 / 9,
                  borderRadius: 10,
                  backgroundColor: theme.colors.sf2,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <ActivityIndicator color={theme.colors.mut} />
              </View>
            )}
          </View>
        ) : null}
        <Lines lines={view.lines} first={!looking} />
        <Buttons>
          <Button
            label={looking ? MAC_WORDS.lookAgain : MAC_WORDS.look}
            variant={looking ? 'secondary' : 'primary'}
            disabled={!view.screen.can}
            busy={look.isFetching}
            onPress={() => (looking ? void look.refetch() : setLooking(true))}
            style={half}
          />
          {view.maybeLocked && view.unlock.can ? (
            <Button
              label={MAC_WORDS.unlock}
              variant="secondary"
              busy={busy === 'unlock'}
              disabled={busy !== null}
              onPress={() => void run({ op: 'unlock' })}
              style={half}
            />
          ) : null}
        </Buttons>
        <CardQuiet>
          {[view.screen.can ? MAC_WORDS.phoneNoLive : view.screen.why, view.sharingHow, view.fileVaultNote]
            .filter(Boolean)
            .join(' ')}
        </CardQuiet>
      </OneCard>

      <OneCard label={MAC_WORDS.passwordTitle}>
        <Lines lines={[{ ...view.account, title: tMobile('screens.screen-sign-in') }]} first />
        {view.password.can ? (
          <Buttons>
            <Button
              label={view.hasAccount ? tMobile('screens.change-it') : MAC_WORDS.setPassword}
              variant={view.account.tone === 'ok' ? 'secondary' : 'primary'}
              disabled={busy !== null}
              onPress={() => setAsking('password')}
              style={half}
            />
            {view.hasAccount ? (
              <>
                <Button
                  label={MAC_WORDS.check}
                  variant="secondary"
                  busy={busy === 'account.check'}
                  disabled={busy !== null}
                  onPress={() => void run({ op: 'account.check' })}
                  style={half}
                />
                <Button
                  label={MAC_WORDS.forget}
                  variant="secondary"
                  disabled={busy !== null}
                  onPress={() => setAsking('forget')}
                  style={half}
                />
              </>
            ) : null}
          </Buttons>
        ) : null}
        <CardQuiet>{view.password.can ? MAC_WORDS.passwordHint : (view.password.why ?? '')}</CardQuiet>
      </OneCard>

      <OneCard label={MAC_WORDS.helperTitle}>
        <Lines lines={view.helper} first />
        {view.needsAccess && view.helperStep.can ? (
          <Buttons>
            <Button
              label={MAC_WORDS.openSetting}
              variant="secondary"
              busy={busy === 'ui.open'}
              disabled={busy !== null}
              onPress={() => void run({ op: 'ui.open', target: 'accessibility' })}
              style={{ flexGrow: 1 }}
            />
          </Buttons>
        ) : null}
        {view.helperNote ? <CardQuiet>{view.helperNote}</CardQuiet> : null}
      </OneCard>

      <PasswordSheet
        visible={asking === 'password'}
        serverName={serverName}
        user={view.accountUser}
        busy={busy === 'account.set'}
        onSave={async (user, password) => {
          const out = await step({ op: 'account.set', account: { user, password } });
          if (!out.ok) return out.text;
          showNotice(out.text);
          setAsking(null);
          return null;
        }}
        onClose={() => setAsking(null)}
      />
      <OneSheet
        visible={asking === 'forget'}
        onClose={() => busy === null && setAsking(null)}
        badge={serverName}
        tone="bad"
        title={MAC_WORDS.forgetTitle(serverName)}
        body={MAC_WORDS.forgetBody(serverName)}
        busy={busy === 'account.clear' ? 'go' : null}
        buttons={[
          {
            id: 'go',
            label: MAC_WORDS.forgetConfirm,
            variant: 'primary',
            onPress: () =>
              void run({ op: 'account.clear' }).then((out) => {
                if (out.ok) setAsking(null);
              }),
          },
          { id: 'cancel', label: 'Cancel', variant: 'quiet', onPress: () => setAsking(null) },
        ]}
      />
    </>
  );
}

/**
 * Set the Mac's password: the user and the password, sent once to the Mac, which keeps it only if it signs in with it.
 * The password lives in the sheet only while it is open, is cleared once sent, and never goes into navigation params.
 */
function PasswordSheet({
  visible,
  serverName,
  user,
  busy,
  onSave,
  onClose,
}: {
  visible: boolean;
  serverName: string;
  user: string;
  busy: boolean;
  /** Resolves to the problem to show, or null when it was saved. */
  onSave: (user: string, password: string) => Promise<string | null>;
  onClose: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={() => !busy && onClose()} label={MAC_WORDS.setPassword}>
      {visible ? (
        <PasswordForm serverName={serverName} user={user} busy={busy} onSave={onSave} onClose={onClose} />
      ) : null}
    </Sheet>
  );
}

function PasswordForm({
  serverName,
  user: initialUser,
  busy,
  onSave,
  onClose,
}: {
  serverName: string;
  user: string;
  busy: boolean;
  onSave: (user: string, password: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const { tClient } = useI18n();
  const theme = useTheme();
  const [user, setUser] = useState(initialUser);
  const [password, setPassword] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = async () => {
    const u = user.trim();
    const wrong = macAccountProblem(u, password);
    if (wrong) return setProblem(wrong);
    const typed = password;
    // The sheet doesn't keep it once it is on its way (nor does the step: `useHostScreenStep`).
    setPassword('');
    setProblem(null);
    setProblem(await onSave(u, typed));
  };
  return (
    <View style={{ paddingHorizontal: 22, paddingBottom: 8, gap: 14 }}>
      <View style={{ gap: 4 }}>
        <Text size={19} weight={700} tracking={-0.01} accessibilityRole="header">
          {MAC_WORDS.setPassword}
        </Text>
        <Text size={13.5} lh={1.4} color={theme.colors.mut}>
          {`The password of a user who may sign in at ${serverName}. Whombat keeps it on the Mac only, to open and unlock its screen.`}
        </Text>
      </View>
      <FormField
        label={MAC_WORDS.user}
        value={user}
        onChangeText={setUser}
        mono
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        importantForAutofill="no"
      />
      <FormField
        label={MAC_WORDS.password}
        value={password}
        onChangeText={(v) => {
          setPassword(v);
          setProblem(null);
        }}
        secret
        autoFocus
        maxLength={HOST_SCREEN_LIMITS.accountBytes}
        onSubmitEditing={() => void save()}
      />
      <FormMessage text={problem} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label={tClient('reports.cancel')}
          variant="secondary"
          disabled={busy}
          onPress={onClose}
          style={{ flex: 1 }}
        />
        <Button label={MAC_WORDS.save} busy={busy} onPress={() => void save()} style={{ flex: 1 }} />
      </View>
    </View>
  );
}
