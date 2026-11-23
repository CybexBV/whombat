/**
 * This Whombat → About (managed only; this-whombat-sections-android.md AP-1248), the web's About part (Whombat
 * this-whombat-sections.md AP-1231, AP-1232) on its own screen: facts and tools you look up. VERSION (this app, the
 * Whombat; SS-06), UPDATES (waiting, failed, the last one with what it brought; the oldest app builds let in; “Keep
 * server agents up to date”, agent-updates-app.md AP-2992; “Updates from”, Production or Beta), REACH
 * (Whombat Link, its address, Tailscale; whombat-link.md LNK-42), CONNECTION (the Whombat's fingerprint), what a
 * managed Whombat turns off under TURNED OFF HERE (the phone has no Agents’ access part, so they live here),
 * HARDWARE where the Whombat has `host.hardware` (`HardwareSection`, hardware-support-android.md AP-3259; opened at it
 * by NETWORK's See hardware), REMOTE HELP (`RemoteHelpSection`, app remote-help.md AP-4470), DIAGNOSTICS — the files
 * made, the checklist behind “Make a file for support…”, each part in plain words, and this phone's sync log to share
 * (live-data-calm.md AP-6574) — and this phone's fingerprint.
 */

import { type RouteProp, useRoute } from '@react-navigation/native';
import {
  ACCOUNTS_TEXT,
  ago,
  type CheckedPreview,
  DIAGNOSTIC_SCOPE_LIST,
  type DiagnosticScope,
  DiagnosticsIntegrityError,
  downloadDiagnostics,
  OWN_ADDRESS_TEXT,
  OWN_NAME_TEXT,
  ownAddressCloudflareLine,
  ownAddressLeavingView,
  ownAddressRenameErrorText,
  ownAddressView,
  ownNameChosen,
  ownNameLine,
  ownNameZoneOf,
  previewDiagnostics,
  THIS_WHOMBAT_TEXT,
  UPDATE_TEXT,
  updateView,
} from '@whombat/client/managed';
import { useOwnNameCheck } from '@whombat/client/managed/react';
import {
  type ApplianceStatus,
  type DiagnosticBundleSummary,
  OperationError,
  sessionOps,
} from '@whombat/client/session';
import { ownAddressLabelOf } from '@whombat/protocol';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { SYNC_LOG_TEXT, syncLog, syncLogFile } from '../data/syncLog';
import { useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { showNotice } from '../screens/feedback';
import { AgentUpdatesSwitchCard, AgentUpdatesSwitchRow } from '../settings/AgentUpdatesSwitch';
import { VersionCard } from '../settings/VersionCard';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from '../ui/clipboard';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { AskFirstRow } from './AskFirstRow';
import { APP_BUILD } from './config';
import { useManagedOrThrow } from './context';
import { COPY, MANAGED_TEXT } from './copy';
import { phoneClient } from './env';
import { HardwareSection } from './HardwareSection';
import { ChannelRow, ReachCard } from './ReachCard';
import { RemoteHelpSection } from './RemoteHelpSection';
import { diagnosticScopeLine } from './thisWhombat';
import { Card, ErrorLine, Note, Row } from './ui';
import { useApplianceStatus, useReleaseSummary } from './useApplianceStatus';
import { useMachineHere, useScrollToCard } from './useMachine';
import { usePhoneReach } from './useReach';
import { useRemoteHelpHere } from './useRemoteHelpHere';

export function WhombatAboutScreen() {
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const navigation = useAppNavigation();
  const managed = useManagedOrThrow();
  const { status, error, reload } = useApplianceStatus();
  const { timeZone } = useBurrowBase();
  const updates = status ? updateView(status, { timeZone }) : { rows: [], summaryOf: null, pollMs: null };
  const summary = useReleaseSummary(updates.summaryOf);
  // The owner's yes to the update waiting for them (ask-before-updating.md ABU-03).
  const [installing, setInstalling] = useState<string | null>(null);
  const install = (release: string) => {
    setInstalling(release);
    sessionOps.applianceUpdateInstall(managed.session, release).then(
      () => {
        showNotice(UPDATE_TEXT.installing);
        reload();
      },
      (e) => {
        setInstalling(null);
        Alert.alert('That didn’t go through', e instanceof OperationError ? e.message : UPDATE_TEXT.failed);
        reload();
      },
    );
  };
  // HARDWARE (AP-3259), and opened at it by NETWORK's See hardware (AP-3255); the param goes once read.
  const machine = useMachineHere();
  // REMOTE HELP (AP-4470): above DIAGNOSTICS as on the web (AP-4448).
  const remoteHelp = useRemoteHelpHere();
  const reach = usePhoneReach(managed.session);
  const linkState = reach.reach?.link?.state;
  const remoteHelpShown =
    reach.reach === undefined
      ? false
      : reach.reach?.link
        ? linkState === 'on' || linkState === 'grace'
        : !managed.community;
  const at = useRoute<RouteProp<RootStackParamList, 'WhombatAbout'>>().params?.at;
  // The card it opened at stays the target after the param goes (REACH loads later than the screen).
  const [target] = useState(at);
  const place = useScrollToCard(target !== undefined);
  useEffect(() => {
    if (at) navigation.setParams({ at: undefined });
  }, [at, navigation]);
  const back = (
    <BackBar
      label={COPY.whombat.title}
      onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Whombat'))}
    />
  );
  if (error)
    return (
      <Screen>
        {back}
        <ErrorState text={MANAGED_TEXT.loadError} onRetry={reload} />
      </Screen>
    );
  if (!status)
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const policy = Object.entries(status.policy).filter(([, p]) => !p.available);
  const floor = floors(status);
  return (
    <Screen>
      {back}
      <ScrollView
        ref={place.scroller}
        onScrollBeginDrag={place.stop}
        contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}
      >
        <LargeTitle title={THIS_WHOMBAT_TEXT.parts.about} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }} onLayout={place.onContainer}>
          <VersionCard runtime={status.appliance.runtimeVersion} hermes={status.appliance.hermes ?? null} />

          {status.update ? (
            // Waiting (for what, since when), failed (why; nothing changed), the last update (AP-258).
            <Card label={MANAGED_TEXT.updates}>
              {updates.rows.map((row, i) => (
                <Row
                  key={row.title}
                  first={i === 0}
                  {...(row.dot ? { dot: row.dot } : {})}
                  title={row.title}
                  meta={
                    row.lastUpdate && summary ? [row.meta, summary].filter(Boolean).join(' · ') : row.meta
                  }
                  action={
                    row.action === 'install' && row.release ? (
                      <Button
                        label={UPDATE_TEXT.install}
                        busy={installing === row.release}
                        onPress={() => row.release && install(row.release)}
                      />
                    ) : undefined
                  }
                />
              ))}
              {/* “Ask before updating” (ask-before-updating.md ABU-01). */}
              <AskFirstRow status={status} onChanged={reload} />
              {/* “Updates from”: Production or Beta (whombat-link.md LNK-21). */}
              <ChannelRow session={managed.session} />
              {floor.length > 0 ? (
                <Row dot="mut" title={MANAGED_TEXT.clientFloor} meta={MANAGED_TEXT.clientFloorMeta(floor)} />
              ) : null}
              {/* “Keep server agents up to date” (agent-updates-app.md AP-2992). */}
              <AgentUpdatesSwitchRow />
            </Card>
          ) : (
            <AgentUpdatesSwitchCard />
          )}

          {/* How it is reached: Whombat Link, its address, Tailscale (LNK-42). The licence shows nothing (LNK-04). */}
          <ReachCard
            session={managed.session}
            reach={reach}
            {...(target === 'reach' ? { onLayout: place.onCard } : {})}
          />

          <Card label={MANAGED_TEXT.connection}>
            <Row
              first
              dot={managed.connection.status === 'open' ? 'ok' : 'warn'}
              title={managed.applianceName ?? 'Your Whombat'}
              meta={`${MANAGED_TEXT.connected} · ${MANAGED_TEXT.fingerprint(managed.applianceFingerprint)}`}
            />
          </Card>

          {/* The box's own address (own-address.md): what it is, with Copy. */}
          {status.ownAddress ? <OwnAddressCard own={status.ownAddress} onChanged={reload} /> : null}

          {policy.length > 0 ? (
            <Card label={THIS_WHOMBAT_TEXT.turnedOff}>
              {policy.map(([key, p], i) => (
                <Row key={key} first={i === 0} dot="mut" title={p.reason ?? key} />
              ))}
            </Card>
          ) : null}

          <HardwareSection
            machine={machine}
            runtime={status.appliance.runtimeVersion}
            {...(target === 'hardware' ? { onLayout: place.onCard } : {})}
          />
          {/* Remote help is a Whombat Link feature (LNK-07); a box before Link keeps the old rule (HE-58, AP-5470). */}
          {remoteHelpShown ? <RemoteHelpSection here={remoteHelp} /> : null}
          <Diagnostics />

          <Text size={12} mono color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
            {`This phone · ${MANAGED_TEXT.fingerprint(managed.deviceFingerprint)}`}
          </Text>
        </View>
      </ScrollView>
    </Screen>
  );
}

/**
 * ADDRESS: the box's own address, whether it works, its certificate and the watch's last check; Cloudflare's
 * certificates for `*.whombat.app` while they last; the old address while it still works after a change; and Change,
 * which opens the name field in place (the same check and words as the web).
 */
function OwnAddressCard({
  own,
  onChanged,
}: {
  own: NonNullable<ApplianceStatus['ownAddress']>;
  onChanged: () => void;
}) {
  const managed = useManagedOrThrow();
  const theme = useTheme();
  const v = ownAddressView(own);
  const t = OWN_ADDRESS_TEXT.settings;
  const leaving = ownAddressLeavingView(own);
  const cloudflare = ownAddressCloudflareLine(own.host);
  const [changing, setChanging] = useState(false);
  // What the box says now is what the next connection dials (a change made elsewhere included).
  const seen = managed.ownAddressSeen;
  useEffect(() => seen?.(own), [seen, own]);
  return (
    <Card label={t.section}>
      <Row
        first
        dot={v.tone}
        dotLabel={v.state}
        title={v.address}
        body={v.state}
        meta={[v.certificate, v.lastCheck, ...v.missed].filter(Boolean).join('\n')}
        action={
          <Button variant="secondary" label={t.copy} onPress={() => void copyToClipboard(v.url, t.copied)} />
        }
      >
        {cloudflare ? (
          <Text size={13} lh={1.4} color={theme.colors.mut}>
            {cloudflare}
          </Text>
        ) : null}
      </Row>
      {leaving ? <Row dot="mut" title={leaving.host} body={leaving.line} /> : null}
      <View style={{ padding: 16, gap: 10, borderTopWidth: 1, borderTopColor: theme.colors.line }}>
        {changing ? (
          <ChangeAddress
            own={own}
            onCancel={() => setChanging(false)}
            onDone={(next) => {
              setChanging(false);
              seen?.(next);
              showNotice(OWN_NAME_TEXT.changed(next.host));
              onChanged();
            }}
          />
        ) : (
          <Button variant="secondary" label={OWN_NAME_TEXT.change} onPress={() => setChanging(true)} />
        )}
      </View>
    </Card>
  );
}

/** The name field `[ name ].whombat.app` with its live check, what happens to the old address, and Change address. */
function ChangeAddress({
  own,
  onCancel,
  onDone,
}: {
  own: NonNullable<ApplianceStatus['ownAddress']>;
  onCancel: () => void;
  onDone: (own: NonNullable<ApplianceStatus['ownAddress']>) => void;
}) {
  const { session } = useManagedOrThrow();
  const theme = useTheme();
  const N = OWN_NAME_TEXT;
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { check, type } = useOwnNameCheck(
    (label) => sessionOps.ownAddressCheck(session, label),
    ownAddressLabelOf(own.host),
  );
  const label = ownNameChosen(check);
  const zone = ownNameZoneOf(check.kind === 'done' && check.host ? check.host : own.host);
  const line = ownNameLine(check, zone);
  const lineColor =
    line?.tone === 'ok' ? theme.colors.ok : line?.tone === 'bad' ? theme.colors.bad : theme.colors.mut;
  const submit = async () => {
    if (!label) return;
    setBusy(true);
    setProblem(null);
    try {
      onDone((await sessionOps.ownAddressRename(session, label)).ownAddress);
    } catch (error) {
      setProblem(ownAddressRenameErrorText(error));
      setBusy(false);
    }
  };
  return (
    <>
      <Text size={11.5} mono color={theme.colors.mut}>
        {N.label.toUpperCase()}
      </Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <TextInput
          value={typed}
          onChangeText={(next) => {
            const name = next.toLowerCase().replace(/\s/g, '');
            setTyped(name);
            setProblem(null);
            type(name);
          }}
          accessibilityLabel={N.label}
          placeholder={N.placeholder}
          placeholderTextColor={theme.colors.placeholder}
          selectionColor={theme.colors.brand}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
          maxLength={64}
          style={{
            flex: 1,
            minHeight: 48,
            paddingHorizontal: 14,
            borderRadius: 14,
            borderWidth: 1,
            borderColor: line?.tone === 'bad' ? theme.colors.bad : theme.colors.line2,
            backgroundColor: theme.colors.sf,
            color: theme.colors.ink,
            fontSize: 16,
          }}
        />
        <Text size={16} color={theme.colors.ink2}>
          {`.${zone}`}
        </Text>
      </View>
      {line ? (
        <Text size={13} lh={1.4} color={lineColor} accessibilityLiveRegion="polite">
          {line.text}
        </Text>
      ) : null}
      <Text size={13} lh={1.4} color={theme.colors.mut}>
        {N.privacy}
      </Text>
      <Note text={N.explain} />
      <ErrorLine text={problem} />
      <Button
        label={busy ? N.changing : N.changeAddress}
        busy={busy}
        disabled={!label}
        onPress={() => void submit()}
      />
      <Button label={N.cancel} variant="quiet" disabled={busy} onPress={onCancel} />
    </>
  );
}

/** The platforms with a client security floor (CT-53). */
function floors(status: ApplianceStatus): { platform: string; minBuild: number }[] {
  return Object.entries(status.clientFloor ?? {})
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([platform, minBuild]) => ({ platform, minBuild: minBuild as number }));
}

/**
 * Diagnostic files for support (CT-52; AP-1249): the files made — read exactly what one contains (checked
 * against the recorded sha256), share it (checked again; the temporary copy goes afterwards) or delete it — and “Make
 * a file for support…”, which opens the checklist in place: each part by its name and what it holds in plain words,
 * then Make the file (the checklist folds again once it is made).
 */
function Diagnostics() {
  const { session, applianceName } = useManagedOrThrow();
  const theme = useTheme();
  const t = COPY.diagnostics;
  const [list, setList] = useState<DiagnosticBundleSummary[] | null>(null);
  const [making, setMaking] = useState(false);
  const [chosen, setChosen] = useState<Set<DiagnosticScope>>(() => new Set(['versions', 'health']));
  const [open, setOpen] = useState<CheckedPreview | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    sessionOps.diagnosticsList(session).then(
      (r) => setList(r.bundles),
      () => setList([]),
    );
  }, [session]);
  useEffect(load, [load]);
  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setNote(null);
    try {
      await work();
    } catch (error) {
      setNote(
        error instanceof DiagnosticsIntegrityError
          ? t.integrity
          : error instanceof OperationError && error.code === 'diagnostics_limit'
            ? t.limit
            : t.failed,
      );
    } finally {
      setBusy(false);
      load();
    }
  };
  // This phone's sync log as a text file, shared where the person chooses (the temporary copy goes afterwards).
  const shareSyncLog = async () => {
    const at = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '');
    const file = new File(Paths.cache, `whombat-sync-log-${at}.txt`);
    try {
      if (file.exists) file.delete();
      file.create();
      file.write(
        syncLogFile({
          entries: syncLog.entries(),
          app: phoneClient(APP_BUILD).build,
          whombat: applianceName ?? 'Your Whombat',
        }),
      );
      await Sharing.shareAsync(file.uri, { mimeType: 'text/plain', dialogTitle: SYNC_LOG_TEXT.dialogTitle });
    } finally {
      try {
        file.delete();
      } catch {
        // already gone
      }
    }
  };
  const share = (d: DiagnosticBundleSummary) =>
    act(async () => {
      const got = await downloadDiagnostics(session, d);
      const file = new File(Paths.cache, got.name);
      try {
        if (file.exists) file.delete();
        file.create();
        file.write(got.bytes);
        await Sharing.shareAsync(file.uri, { mimeType: 'application/json', dialogTitle: t.label });
      } finally {
        try {
          file.delete();
        } catch {
          // already gone
        }
      }
    });
  return (
    <Card label={t.label}>
      <View style={{ padding: 16, gap: 10 }}>
        <Note text={t.intro} />
        {making ? (
          <>
            <Text size={13} weight={600}>
              {t.choose}
            </Text>
            {DIAGNOSTIC_SCOPE_LIST.map(({ scope, description }) => (
              <Pressable
                key={scope}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: chosen.has(scope) }}
                onPress={() =>
                  setChosen((prev) => {
                    const next = new Set(prev);
                    if (next.has(scope)) next.delete(scope);
                    else next.add(scope);
                    return next;
                  })
                }
                style={{
                  minHeight: 44,
                  flexDirection: 'row',
                  gap: 10,
                  alignItems: 'flex-start',
                  paddingVertical: 4,
                }}
              >
                <Text size={16}>{chosen.has(scope) ? '☑' : '☐'}</Text>
                <Text size={13} lh={1.4} color={theme.colors.ink2} style={{ flex: 1 }}>
                  <Text size={13} weight={600}>
                    {t.scopeNames[scope] ?? scope}
                  </Text>
                  {` · ${diagnosticScopeLine(scope, description)}`}
                </Text>
              </Pressable>
            ))}
            <Button
              label={busy ? t.creating : t.create}
              busy={busy}
              disabled={chosen.size === 0}
              onPress={() =>
                void act(async () => {
                  const order = DIAGNOSTIC_SCOPE_LIST.map((x) => x.scope).filter((x) => chosen.has(x));
                  await sessionOps.diagnosticsCreate(session, { scopes: order });
                  setMaking(false);
                })
              }
            />
            <Button
              label={ACCOUNTS_TEXT.cancel}
              variant="quiet"
              disabled={busy}
              onPress={() => setMaking(false)}
            />
          </>
        ) : (
          <Button
            label={THIS_WHOMBAT_TEXT.diagnostics.make}
            variant="secondary"
            onPress={() => {
              setNote(null);
              setMaking(true);
            }}
          />
        )}
        <Note text={note} />
        <Note text={SYNC_LOG_TEXT.intro} />
        <Button
          label={SYNC_LOG_TEXT.share}
          variant="secondary"
          disabled={busy}
          onPress={() => void act(shareSyncLog)}
        />
      </View>
      {list && list.length === 0 ? <Row title={t.none} /> : null}
      {list?.map((d) => (
        <View key={d.bundleId}>
          <Row
            dot="mut"
            title={d.scopes.map((x) => t.scopeNames[x] ?? x).join(' · ')}
            meta={[
              ago(d.createdAt),
              `${Math.max(1, Math.round(d.size / 1024))} KB`,
              t.downloads(d.downloads),
            ].join(' · ')}
          />
          <View
            style={{
              flexDirection: 'row',
              gap: 8,
              paddingHorizontal: 16,
              paddingBottom: 12,
              flexWrap: 'wrap',
            }}
          >
            <Button
              label={open?.summary.bundleId === d.bundleId ? t.hide : t.show}
              variant="secondary"
              disabled={busy}
              onPress={() =>
                open?.summary.bundleId === d.bundleId
                  ? setOpen(null)
                  : void act(async () => setOpen(await previewDiagnostics(session, d.bundleId)))
              }
            />
            <Button label={t.share} variant="secondary" disabled={busy} onPress={() => void share(d)} />
            <Button
              label={t.remove}
              variant="quiet"
              disabled={busy}
              onPress={() =>
                void act(async () => {
                  if (open?.summary.bundleId === d.bundleId) setOpen(null);
                  await sessionOps.diagnosticsDelete(session, d.bundleId);
                })
              }
            />
          </View>
          {open?.summary.bundleId === d.bundleId ? (
            <View style={{ paddingHorizontal: 16, paddingBottom: 16, gap: 6 }}>
              <Note text={t.checked} />
              <Text size={11} mono lh={1.45} color={theme.colors.ink2} selectable>
                {open.pretty}
              </Text>
            </View>
          ) : null}
        </View>
      ))}
    </Card>
  );
}
