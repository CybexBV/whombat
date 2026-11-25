/**
 * This Whombat → About → REACH and “Updates from” on the phone (Whombat docs/decisions/whombat-link.md LNK-42, LNK-44,
 * LNK-06a; one-environment.md), as on the web, in the installer's words: Easy · Whombat Link in plain words with what it
 * gives, its address, Expert · Tailscale or Headscale with what to know and **Turn on Tailscale** while it isn't on; the
 * update channel, Production or Beta. On Android, Link is turned on here (the box shows a code to type at the account
 * site) and off, with the offer sentence; on the iPhone only its state and what it gives are said: no price, no sign-up,
 * no way to buy (LNK-44).
 */
import {
  addressRowView,
  CHANNEL_TEXT,
  channelErrorText,
  channelView,
  linkRowView,
  REACH_CHOICE_TEXT,
  REACH_TEXT,
  readUpdatesChannel,
  tailscaleRowView,
  type UpdatesChannelOutput,
} from '@whombat/client/managed';
import { type ApplianceSession, sessionOps } from '@whombat/client/session';
import { useEffect, useState } from 'react';
import { Alert, type LayoutChangeEvent, Linking, View } from 'react-native';
import { showNotice } from '../screens/feedback';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { ChevronDown } from '../ui/icons';
import { Button } from '../ui/primitives';
import { Segmented } from '../ui/Segmented';
import { Touchable } from '../ui/Touchable';
import { Card, Note, Row } from './ui';
import { OFFER_LINK, type PhoneReach, useTailscaleTurnOn } from './useReach';

const T = REACH_TEXT;
const C = REACH_CHOICE_TEXT;

/** “What you get” or “What to know” under a way to reach the Whombat: its points, folded. */
function ReachMore({ label, points }: { label: string; points: readonly string[] }) {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Touchable
        feedback="wash"
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((was) => !was)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44, alignSelf: 'flex-start' }}
      >
        <Text size={13.5} weight={600} color={theme.colors.brand}>
          {label}
        </Text>
        <View style={{ transform: [{ rotate: open ? '180deg' : '0deg' }] }}>
          <ChevronDown size={15} color={theme.colors.brand} strokeWidth={2} />
        </View>
      </Touchable>
      {open ? (
        <View style={{ gap: 4, paddingBottom: 4 }}>
          {points.map((point) => (
            <Text key={point} size={13.5} lh={1.45} color={theme.colors.ink2}>
              {`•  ${point}`}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function ReachCard({
  session,
  reach,
  connection,
  onLayout,
}: {
  session: ApplianceSession;
  reach: PhoneReach;
  /**
   * This phone's own connection, first (“Connected · end-to-end encrypted · Fingerprint …”): it answers the same
   * question, how the phone reaches the Whombat, so it isn't a card of its own. Shown even before REACH is read.
   */
  connection?: { ok: boolean; title: string; meta: string };
  /** Lets About scroll to REACH (a connection that needs a secure address opens it there). */
  onLayout?: (e: LayoutChangeEvent) => void;
}) {
  const theme = useTheme();
  const tailscaleOn = useTailscaleTurnOn(session);
  const [now, setNow] = useState(() => Date.now());
  const starting = reach.reach?.link?.state === 'starting';
  useEffect(() => {
    if (!starting) return;
    const t = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(t);
  }, [starting]);
  const r = reach.reach;
  const own = connection ? (
    <Row first dot={connection.ok ? 'ok' : 'warn'} title={connection.title} meta={connection.meta} />
  ) : null;
  if (!r)
    return own ? (
      <View onLayout={onLayout}>
        <Card label={T.section}>{own}</Card>
      </View>
    ) : null;
  const link = r.link ? linkRowView(r.link, { offerLink: OFFER_LINK, now }) : null;
  const address = r.ownAddress ? null : addressRowView(r, { offerLink: OFFER_LINK });
  const tailscale = tailscaleRowView(tailscaleOn.state ?? r.tailscale);
  const confirmOff = () =>
    Alert.alert(T.link.offConfirm, T.link.offConfirmMeta, [
      { text: T.link.cancel, style: 'cancel' },
      { text: T.link.turnOff, style: 'destructive', onPress: reach.turnOff },
    ]);
  const linkAction = !link
    ? null
    : link.action === 'on' || link.action === 'newCode'
      ? { label: link.action === 'newCode' ? T.link.newCode : T.link.turnOn, onPress: reach.turnOn }
      : link.action === 'off'
        ? { label: T.link.turnOff, onPress: confirmOff }
        : link.action === 'cancel'
          ? { label: T.link.cancel, onPress: reach.turnOff }
          : null;
  return (
    <View onLayout={onLayout}>
      <Card label={T.section}>
        {own}
        {link ? (
          <>
            <Row
              first={!own}
              dot={link.tone}
              kicker={C.easy.label}
              title={link.title}
              meta={link.code ? null : link.meta}
              action={
                linkAction ? (
                  <Button
                    label={linkAction.label}
                    variant="secondary"
                    busy={reach.busy !== null}
                    onPress={linkAction.onPress}
                  />
                ) : undefined
              }
            >
              {link.more ? <ReachMore label={C.easy.more} points={C.easy.points} /> : null}
            </Row>
            {link.code ? (
              <View style={{ paddingHorizontal: 16, paddingBottom: 14, gap: 6 }}>
                <Text size={13.5} lh={1.45} color={theme.colors.ink2}>
                  {T.link.enter(link.code.where, link.code.code)}
                </Text>
                <Text size={24} weight={600} mono color={theme.colors.ink} selectable>
                  {link.code.code}
                </Text>
                <Text size={12.5} color={theme.colors.mut}>
                  {link.code.left ? T.link.left(link.code.left) : T.link.codeOver}
                </Text>
                <Button
                  label={link.code.where}
                  variant="quiet"
                  onPress={() => void Linking.openURL(link.code?.url ?? '')}
                />
              </View>
            ) : null}
            <Note text={reach.error} />
          </>
        ) : null}
        {address ? <Row first={!own && !link} dot="mut" title={address.title} meta={address.meta} /> : null}
        {tailscale ? (
          <Row
            first={!own && !link && !address}
            dot={tailscale.tone}
            kicker={C.expert.label}
            title={T.tailscale.title}
            meta={tailscaleOn.note ?? tailscale.title}
            body={tailscale.on ? null : C.expert.line}
            action={
              tailscaleOn.signInUrl ? (
                <Button label="Sign in" onPress={() => void Linking.openURL(tailscaleOn.signInUrl ?? '')} />
              ) : !tailscale.on ? (
                <Button
                  label={T.tailscale.turnOn}
                  variant={r.link?.state === 'grace' || r.link?.state === 'ended' ? 'primary' : 'secondary'}
                  busy={tailscaleOn.busy}
                  onPress={tailscaleOn.turnOn}
                />
              ) : undefined
            }
          >
            {tailscale.on ? null : <ReachMore label={C.expert.more} points={C.expert.points} />}
          </Row>
        ) : null}
      </Card>
    </View>
  );
}

/** “Updates from”: Production or Beta, with what Beta means; nothing where the box can't choose. */
export function ChannelRow({ session }: { session: ApplianceSession }) {
  const [channel, setChannel] = useState<UpdatesChannelOutput | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    readUpdatesChannel(session).then(
      (c) => live && setChannel(c),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [session]);
  if (!channel) return null;
  const v = channelView(channel);
  const save = (next: 'production' | 'development') => {
    if (next === v.channel) return;
    setBusy(true);
    sessionOps
      .updatesChannelSet(session, next)
      .then(
        (c) => {
          setChannel(c);
          showNotice(CHANNEL_TEXT.switched(c.channel));
        },
        (e) => Alert.alert(CHANNEL_TEXT.title, channelErrorText(e)),
      )
      .finally(() => setBusy(false));
  };
  return (
    <>
      <Row title={CHANNEL_TEXT.title} meta={v.meta} />
      <View style={{ paddingHorizontal: 16, paddingBottom: 14 }}>
        <Segmented
          label={CHANNEL_TEXT.label}
          disabled={busy}
          value={v.channel}
          onChange={save}
          options={[
            { value: 'production', label: CHANNEL_TEXT.production },
            { value: 'development', label: CHANNEL_TEXT.development },
          ]}
        />
      </View>
    </>
  );
}
