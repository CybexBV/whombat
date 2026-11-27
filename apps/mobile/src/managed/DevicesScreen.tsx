/**
 * Devices (managed only; AP-22, AP-27; this-whombat-sections-android.md AP-1247), the phone's version of the web's
 * Settings · This Whombat → Devices (Whombat this-whombat-sections.md AP-1229; opened from the settings sheet's This
 * Whombat group and from the Overview): this phone and your other devices (`endpoints.list`), removing one
 * (`endpoints.revoke`: pending until the device is told, then applied — worded differently), PASSKEYS, letting a new
 * device in by the code it shows (look it up with `enroll.pair.lookup`, show its name, kind and fingerprint to compare
 * with the new device's screen, then approve with that fingerprint, `enroll.pair.approve`, CT-46), then REMOVED DEVICES
 * not yet told. The Overview's passkey setup opens it at PASSKEYS (`at`).
 */

import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { NeedsNewerAppError } from '@whombat/client';
import {
  addDeviceLink,
  ago,
  formatPairingCodeInput,
  keepOnlyLivePasskeys,
  orderPasskeys,
  PAIRING_CODE,
  PASSKEY_COPY,
  PASSKEY_SETUP_TEXT,
  pairingErrorKey,
  passkeyEnrolledDevices,
  passkeyErrorText,
  passkeyMeta,
  passkeyRemove,
  platformName,
  THIS_WHOMBAT_TEXT,
} from '@whombat/client/managed';
import {
  type EndpointSummary,
  type PairLookupOutput,
  type PasskeysList,
  sessionOps,
} from '@whombat/client/session';
import type { BackupBringBack } from '@whombat/protocol/session';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, type LayoutChangeEvent, ScrollView, Share, Switch, View } from 'react-native';
import { useI18n, useMobileT } from '../i18n';
import type { RootStackParamList } from '../navigation/routes';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { CircleCheck, KeyRound } from '../ui/icons';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { switchColors } from '../ui/switchColors';
import { useBackupPasskeyTap } from './backupPasskey';
import { DeviceLinkCard } from './CommunityLinks';
import { UI_ORIGINS } from './config';
import { useManagedOrThrow } from './context';
import { managedCopy, managedText } from './copy';
import { NeedsNewerApp } from './NeedsNewerApp';
import { PASSKEYS } from './passkeyEnv';
import type { DevicesAt } from './thisWhombat';
import { Card, Field, Note, Row } from './ui';
import { useApplianceStatus } from './useApplianceStatus';

type Props = NativeStackScreenProps<RootStackParamList, 'Devices'>;

/**
 * Opening at a section (`at`, AP-1247): the screen scrolls to it and follows it while what is above it loads
 * (the devices), until a finger scrolls. The param goes once read, so a restored screen
 * opens at the top.
 */
function useScrollToSection(at: DevicesAt | undefined) {
  const scroller = useRef<ScrollView>(null);
  const target = useRef(at);
  const top = useRef(0);
  const y = useRef<number | null>(null);
  const scroll = () => {
    if (target.current && y.current !== null)
      scroller.current?.scrollTo({ y: Math.max(0, top.current + y.current - 8), animated: true });
  };
  return {
    scroller,
    /** On the sections' container: where it starts in the scrolled content. */
    onContainer: (e: LayoutChangeEvent) => {
      top.current = e.nativeEvent.layout.y;
      scroll();
    },
    /** On a section: where it is in the container. */
    section: (key: DevicesAt) => (e: LayoutChangeEvent) => {
      if (key !== target.current) return;
      y.current = e.nativeEvent.layout.y;
      scroll();
    },
    stop: () => {
      target.current = undefined;
    },
  };
}

export function DevicesScreen({ route, navigation }: Props) {
  const { rawLocale } = useI18n();
  const managedTextHere = managedText(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const { session, community } = useManagedOrThrow();
  const place = useScrollToSection(route.params?.at);
  useEffect(() => {
    if (route.params?.at) navigation.setParams({ at: undefined });
  }, [route.params?.at, navigation]);
  // REMOVED DEVICES (AP-1247): how many removals the Whombat still has to tell, from its status; left out unread.
  const { status, reload: reloadStatus } = useApplianceStatus({ follow: false });
  const [list, setList] = useState<EndpointSummary[] | null>(null);
  /** Devices a passkey let in during the last day (PK-09): said on their row. */
  const [byPasskey, setByPasskey] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [code, setCode] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<(PairLookupOutput & { code: string }) | null>(null);
  const load = useCallback(() => {
    setError(null);
    sessionOps.endpointsList(session).then(
      (r) => {
        setList(r.endpoints);
        sessionOps.passkeysList(session).then(
          (p) => setByPasskey(new Set(passkeyEnrolledDevices(r.endpoints, p.passkeys).keys())),
          () => {},
        );
      },
      (e) => setError(e ?? new Error('failed')),
    );
  }, [session]);
  useEffect(load, [load]);

  // Which device shows this code: its name, kind and fingerprint, to compare before letting it in.
  const lookUp = async () => {
    setNote(null);
    setBusy(true);
    try {
      const found = await sessionOps.pairLookup(session, code.trim());
      setAsking({ ...found, code: code.trim() });
    } catch (error) {
      setNote(managedTextHere[pairingErrorKey(error)]);
    } finally {
      setBusy(false);
    }
  };

  const decide = async (yes: boolean) => {
    if (!asking) return;
    setNote(null);
    setBusy(true);
    try {
      await sessionOps.pairApprove(session, {
        code: asking.code,
        approve: yes,
        fingerprint: asking.fingerprint,
      });
      setNote(yes ? managedTextHere.approved : managedTextHere.declined);
      setCode('');
      setAsking(null);
      load();
    } catch (error) {
      const key = pairingErrorKey(error);
      setNote(managedTextHere[key]);
      // The code now belongs to another device (or is gone): start over with a fresh look-up.
      if (key !== 'failed' && key !== 'rateLimited') setAsking(null);
    } finally {
      setBusy(false);
    }
  };

  const remove = (d: EndpointSummary) =>
    Alert.alert(managedTextHere.remove, managedTextHere.removeConfirm, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: managedTextHere.remove,
        style: 'destructive',
        onPress: () =>
          void sessionOps
            .endpointsRevoke(session, d.endpointId)
            .then(load, (e) => setError(e ?? new Error('failed'))),
      },
    ]);

  const back = <BackBar label={tMobile('managed.back')} onPress={() => navigation.goBack()} />;
  // Devices are a security view (AP-266): a device this app can't read would vanish from the list, so the list isn't
  // shown at all; the way out is a newer app, from the store.
  if (error instanceof NeedsNewerAppError)
    return (
      <Screen>
        {back}
        <NeedsNewerApp />
      </Screen>
    );
  if (error)
    return (
      <Screen>
        {back}
        <ErrorState text={managedTextHere.loadError} onRetry={load} />
      </Screen>
    );
  if (!list)
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const mine = list.find((d) => d.current);
  const others = list.filter((d) => !d.current);
  // Typing the code: digits only, the dash comes by itself (`1234-5678`).
  const onCode = (v: string) => setCode(formatPairingCodeInput(v));
  return (
    <Screen>
      {back}
      <ScrollView
        ref={place.scroller}
        onScrollBeginDrag={place.stop}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}
      >
        <LargeTitle title={THIS_WHOMBAT_TEXT.parts.devices} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }} onLayout={place.onContainer}>
          {mine ? (
            <Card label={managedTextHere.devices}>
              <Row
                first
                dot="ok"
                title={`${mine.label} · ${managedTextHere.thisBrowser}`}
                meta={managedTextHere.seen(ago(mine.lastSeenAt, rawLocale))}
              />
            </Card>
          ) : null}
          {others.length > 0 ? (
            <Card label={managedTextHere.otherDevices}>
              {others.map((d, i) => (
                <Row
                  key={d.endpointId}
                  first={i === 0}
                  dot={d.revocation === 'none' ? 'ok' : d.revocation === 'pending' ? 'warn' : 'mut'}
                  title={d.label}
                  meta={
                    d.revocation === 'pending'
                      ? managedTextHere.removedPending
                      : d.revocation === 'applied'
                        ? managedTextHere.removedApplied
                        : byPasskey.has(d.endpointId)
                          ? `${PASSKEY_COPY.newDeviceMeta} · ${managedTextHere.seen(ago(d.lastSeenAt, rawLocale))}`
                          : managedTextHere.seen(ago(d.lastSeenAt, rawLocale))
                  }
                  action={
                    d.revocation === 'none' ? (
                      <Button
                        label={managedTextHere.remove}
                        variant="secondary"
                        accessibilityHint={`Removes ${d.label}`}
                        onPress={() => remove(d)}
                      />
                    ) : undefined
                  }
                />
              ))}
            </Card>
          ) : null}
          {/* A community box's passkeys work only on its secure Tailscale page, not through control (HE-60, AP-5470). */}
          {community ? null : (
            <View onLayout={place.section('passkeys')}>
              <PasskeysCard bringBack={status?.backup.bringBack ?? null} onChanged={reloadStatus} />
            </View>
          )}
          <Card label={managedTextHere.add}>
            {/* A community box makes its own five-minute QR code (AP-5474); otherwise the hosted app's link. */}
            {community ? <DeviceLinkCard /> : <AddDeviceLink />}
            {asking ? (
              <View style={{ padding: 16, gap: 12 }}>
                <Note text={managedTextHere.askedBy} />
                <Row
                  first
                  dot="warn"
                  title={`${asking.label} · ${platformName(asking.platform)}`}
                  meta={managedTextHere.fingerprint(asking.fingerprint)}
                />
                <Note text={managedTextHere.checkFingerprint} />
                <Note text={note} />
                <Button label={managedTextHere.approve} busy={busy} onPress={() => void decide(true)} />
                <Button
                  label={managedTextHere.decline}
                  variant="secondary"
                  disabled={busy}
                  onPress={() => void decide(false)}
                />
                <Button
                  label={managedTextHere.otherCode}
                  variant="quiet"
                  disabled={busy}
                  onPress={() => {
                    setAsking(null);
                    setNote(null);
                  }}
                />
              </View>
            ) : (
              <View style={{ padding: 16, gap: 12 }}>
                <Note text={managedTextHere.addHelp} />
                <Field
                  label={managedTextHere.code}
                  value={code}
                  onChangeText={onCode}
                  mono
                  placeholder="1234-5678"
                  keyboardType="number-pad"
                  autoComplete="off"
                />
                <Note text={note} />
                <Button
                  label={managedTextHere.lookUp}
                  busy={busy}
                  disabled={!PAIRING_CODE.test(code.trim())}
                  onPress={() => void lookUp()}
                />
              </View>
            )}
          </Card>
          {status && (status.revocationsPending > 0 || status.revocationsApplied > 0) ? (
            <Card label={managedTextHere.revocations}>
              {status.revocationsPending > 0 ? (
                <Row first dot="warn" title={managedTextHere.revocationsPending(status.revocationsPending)} />
              ) : null}
              {status.revocationsApplied > 0 ? (
                <Row
                  first={status.revocationsPending === 0}
                  dot="ok"
                  title={managedTextHere.revocationsApplied(status.revocationsApplied)}
                />
              ) : null}
            </Card>
          ) : null}
        </View>
      </ScrollView>
    </Screen>
  );
}

/**
 * One setup summary for access and backups. Credential records, removal and the device-bound policy stay under
 * details. Unreadable security records never disappear silently.
 */
function PasskeysCard({
  bringBack,
  onChanged,
}: {
  /** Where bringing this Whombat back stands, for “Passkey set”. */
  bringBack: BackupBringBack | null;
  /** The box's state changed here (a passkey became the backups' key): read it again. */
  onChanged: () => void;
}) {
  const { session, control, appliancePeerId, connection } = useManagedOrThrow();
  const theme = useTheme();
  const tap = useBackupPasskeyTap();
  const touching = tap?.busy ?? false;
  const [list, setList] = useState<PasskeysList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [details, setDetails] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const me = connection.status === 'open' ? (connection.info.account?.id ?? null) : null;
  const load = useCallback(() => {
    setError(null);
    sessionOps.passkeysList(session).then(
      (l) => {
        setList(l);
        // The phone stops offering passkeys this Whombat no longer takes (removed on another device).
        void keepOnlyLivePasskeys(PASSKEYS, {
          appliance: appliancePeerId,
          accountId: me,
          passkeys: l.passkeys,
        });
      },
      (e) => setError(e ?? new Error('failed')),
    );
  }, [session, appliancePeerId, me]);
  useEffect(load, [load]);
  const view = tap?.view;
  const refresh = tap?.refresh;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed backup state refreshes the shared setup status
  useEffect(() => {
    void refresh?.();
  }, [refresh, bringBack?.state, bringBack?.setup, bringBack?.passkeys]);
  const t = PASSKEY_COPY;
  if (error instanceof NeedsNewerAppError)
    return (
      <Card label={t.section}>
        <NeedsNewerApp />
      </Card>
    );
  const platform = PASSKEYS;
  const add = async () => {
    if (!tap) return;
    setNote(null);
    try {
      setNote((await tap()).note);
      onChanged();
      load();
    } catch (e) {
      setNote(passkeyErrorText(e));
    }
  };
  const remove = (id: string, accountId: string, name: string) =>
    Alert.alert(t.remove, t.removeConfirm(name), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: t.remove,
        style: 'destructive',
        onPress: () =>
          void passkeyRemove({
            session,
            control,
            passkey: { id, accountId, ownerHandle: list?.passkeys.find((p) => p.id === id)?.ownerHandle },
            me,
            appliance: appliancePeerId,
          })
            .then(
              () => setNote(t.removed),
              (e: unknown) => setNote(passkeyErrorText(e)),
            )
            .finally(() => {
              load();
              void tap?.refresh();
              onChanged();
            }),
      },
    ]);
  const setPolicy = (deviceBoundOnly: boolean) =>
    void sessionOps
      .passkeysPolicy(session, deviceBoundOnly)
      .then(
        () => setNote(deviceBoundOnly ? t.policyOn : t.policyOff),
        (e: unknown) => setNote(passkeyErrorText(e)),
      )
      .finally(load);
  const rows = list ? orderPasskeys(list.passkeys, me) : [];
  return (
    <Card label={t.section}>
      {error ? <Row first title={t.loadError} /> : null}
      <View style={{ padding: 16, gap: 12 }} testID="passkey-set">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          {view?.phase === 'ready' ? (
            <CircleCheck size={20} color={theme.colors.ok} strokeWidth={1.8} />
          ) : (
            <KeyRound size={20} color={theme.colors.mut} strokeWidth={1.8} />
          )}
          <View style={{ flex: 1, gap: 3 }}>
            <Text size={15} weight={500} lh={1.35}>
              {tap?.loadError
                ? PASSKEY_SETUP_TEXT.loadError
                : (view?.title ?? (tap ? PASSKEY_SETUP_TEXT.loading : PASSKEY_SETUP_TEXT.empty))}
            </Text>
            <Text size={13} lh={1.4} color={theme.colors.mut}>
              {view?.meta ?? PASSKEY_SETUP_TEXT.intro}
            </Text>
          </View>
        </View>
        {!platform ? <Note text={t.unavailablePhone} /> : null}
        <Note text={touching ? tap?.note : (note ?? tap?.note ?? null)} />
        {view?.phase !== 'ready' || tap?.loadError ? (
          <Button
            label={tap?.label ?? PASSKEY_SETUP_TEXT.setup}
            variant="primary"
            busy={touching}
            disabled={!tap || !platform || !list || (!view && !tap.loadError)}
            onPress={() => void add()}
          />
        ) : null}
        <Button
          label={PASSKEY_SETUP_TEXT.details}
          variant="quiet"
          accessibilityState={{ expanded: details }}
          onPress={() => setDetails(!details)}
        />
      </View>
      {details ? (
        <>
          {rows.map((p) => (
            <Row
              key={p.id}
              first={false}
              title={p.name}
              meta={`${p.synced ? t.synced : t.thisDevice} · ${passkeyMeta(p, ago)}`}
              action={
                <Button
                  label={t.remove}
                  variant="secondary"
                  accessibilityHint={`Removes ${p.name}`}
                  onPress={() => remove(p.id, p.accountId, p.name)}
                />
              }
            />
          ))}
          {view?.phase === 'ready' && tap ? (
            <View style={{ padding: 16 }}>
              <Button
                label={touching ? tap.label : PASSKEY_SETUP_TEXT.check}
                variant="secondary"
                busy={touching}
                onPress={() => void add()}
              />
            </View>
          ) : null}
          {list ? (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                paddingVertical: 12,
                paddingHorizontal: 16,
                borderTopWidth: 1,
                borderTopColor: theme.colors.line,
              }}
            >
              <View style={{ flex: 1, gap: 3 }}>
                <Text size={15} weight={500} lh={1.35}>
                  {t.policy}
                </Text>
                <Text size={12} mono lh={1.45} color={theme.colors.mut}>
                  {t.policyMeta}
                </Text>
              </View>
              <Switch
                value={list.policy.deviceBoundOnly}
                onValueChange={setPolicy}
                accessibilityLabel={t.policy}
                accessibilityRole="switch"
                {...switchColors(theme, list.policy.deviceBoundOnly)}
                style={{ minHeight: 44 }}
              />
            </View>
          ) : null}
        </>
      ) : null}
    </Card>
  );
}

/**
 * “Add a device” (AP-66): a link to open on the new device, naming this Whombat and the identity this phone pinned, so
 * the new device never takes it from the directory. Shared through the share sheet (which also copies); it lets nothing
 * in by itself — the code below still does.
 */
function AddDeviceLink() {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);

  const { applianceId, applianceName, appliancePeerId } = useManagedOrThrow();
  const theme = useTheme();
  const [shown, setShown] = useState(false);
  const t = managedCopyHere.addLink;
  const link = addDeviceLink(UI_ORIGINS[0] ?? 'https://app.whombat.com', applianceId, appliancePeerId);
  return (
    <View style={{ padding: 16, gap: 12, borderBottomWidth: 1, borderBottomColor: theme.colors.line }}>
      {shown ? (
        <>
          <Note text={t.intro} />
          <Text size={12.5} mono selectable color={theme.colors.ink2} testID="add-device-link">
            {link}
          </Text>
          <Button
            label={t.share}
            onPress={() =>
              void Share.share({ message: `${t.shareText(applianceName ?? applianceId)}\n\n${link}` })
            }
          />
        </>
      ) : (
        <Button label={t.show} variant="secondary" onPress={() => setShown(true)} />
      )}
      <Note text={t.note} />
    </View>
  );
}
