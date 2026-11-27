/**
 * This Whombat → About (managed only; this-whombat-sections-android.md AP-1248), the web's About part (Whombat
 * this-whombat-sections.md AP-1231, AP-1232) on its own screen: facts and tools you look up, about one screen long
 * (docs/app/decisions/about-page.md). VERSION & UPDATES (this app, the Whombat, Hermes; SS-06; then the updates:
 * waiting, failed, the last one with what it brought; “What’s new”, the web app's page; “Ask before updating”;
 * “Updates from”, Production or Beta; the oldest app builds let in; “Keep server agents up to date”,
 * agent-updates-app.md AP-2992), REACH (this phone's
 * connection with the Whombat's fingerprint, Whombat Link, its address, Tailscale; whombat-link.md LNK-42), what a
 * managed Whombat turns off under TURNED OFF HERE (the phone has no Agents’ access part, so they live here),
 * HARDWARE in one row that opens the Hardware screen (`HardwareSummary`), then help: REMOTE HELP as a short card that
 * opens the Remote help screen (`RemoteHelpSummary`, app remote-help.md AP-4470), the reports to the Whombat Team,
 * DIAGNOSTICS — the files made, the checklist behind “Make a file for support…”, each part in plain words, and this
 * phone's sync log to share (live-data-calm.md AP-6574) — and this phone's fingerprint.
 */

import { type RouteProp, useRoute } from '@react-navigation/native';
import { teamReportWords } from '@whombat/client';
import {
  accountsText,
  ago,
  type CheckedPreview,
  type DiagnosticScope,
  DiagnosticsIntegrityError,
  diagnosticScopeList,
  downloadDiagnostics,
  hasUpdateCheck,
  ownAddressCloudflareLine,
  ownAddressLeavingView,
  ownAddressRenameErrorText,
  ownAddressView,
  ownAddressWords,
  ownNameChosen,
  ownNameLine,
  ownNameText,
  ownNameZoneOf,
  previewDiagnostics,
  thisWhombatText,
  updateCheckNotice,
  updateText,
  updateView,
} from '@whombat/client/managed';
import { useOwnNameCheck } from '@whombat/client/managed/react';
import { useSessionProtocol, useTeamReportsEntry } from '@whombat/client/react';
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
import { syncLog, syncLogFile } from '../data/syncLog';
import { mobileTranslator, useI18n, useMobileT } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import type { RootStackParamList } from '../navigation/routes';
import { showNotice } from '../screens/feedback';
import { AgentUpdatesSwitchRow } from '../settings/AgentUpdatesSwitch';
import { VersionCard } from '../settings/VersionCard';
import { versionText } from '../settings/version';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { copyToClipboard } from '../ui/clipboard';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { AskFirstRow } from './AskFirstRow';
import { APP_BUILD } from './config';
import { useManagedOrThrow } from './context';
import { managedCopy, managedText } from './copy';
import { phoneClient } from './env';
import { HardwareSummary } from './HardwareSection';
import { openSignInPage } from './openSignInPage';
import { ChannelRow, ReachCard } from './ReachCard';
import { RemoteHelpSummary } from './RemoteHelpSection';
import { diagnosticScopeLine } from './thisWhombat';
import { Card, ErrorLine, LinkRow, Note, Row } from './ui';
import { useApplianceStatus, useReleaseSummary } from './useApplianceStatus';
import { useMachineHere, useScrollToCard } from './useMachine';
import { usePhoneReach } from './useReach';
import { useRemoteHelpHere } from './useRemoteHelpHere';
import { WHATS_NEW_URL, whatsNewRow } from './whatsNew';

export function WhombatAboutScreen() {
  const { rawLocale } = useI18n();
  const updateTextHere = updateText(rawLocale);
  const teamReportWordsHere = teamReportWords(rawLocale);
  const managedCopyHere = managedCopy(rawLocale);
  const managedTextHere = managedText(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const theme = useTheme();
  const navigation = useAppNavigation();
  const managed = useManagedOrThrow();
  const { status, error, reload } = useApplianceStatus();
  const { timeZone, slug } = useBurrowBase();
  // Reports to the Whombat Team (team-reports.md): only where one can be sent or the person has some.
  const reports = useTeamReportsEntry(slug);
  const updates = status
    ? updateView(status, { timeZone, locale: rawLocale })
    : { rows: [], summaryOf: null, pollMs: null };
  const summary = useReleaseSummary(updates.summaryOf);
  // The owner's yes to the update waiting for them (ask-before-updating.md ABU-03).
  const [installing, setInstalling] = useState<string | null>(null);
  const install = (release: string) => {
    setInstalling(release);
    sessionOps.applianceUpdateInstall(managed.session, release).then(
      () => {
        showNotice(updateTextHere.installing);
        reload();
      },
      (e) => {
        setInstalling(null);
        Alert.alert(
          tMobile('managed.that-didnt-go-through'),
          e instanceof OperationError ? e.message : updateTextHere.failed,
        );
        reload();
      },
    );
  };
  // “Check for updates” (check-for-updates.md): the box looks now instead of at its next hourly look.
  const [checking, setChecking] = useState(false);
  const canCheck = hasUpdateCheck(useSessionProtocol());
  const check = () => {
    setChecking(true);
    sessionOps
      .applianceUpdateCheck(managed.session)
      .then(
        ({ outcome }) => showNotice(updateCheckNotice(outcome, status?.update?.askFirst, rawLocale)),
        (e) => showNotice(e instanceof OperationError ? e.message : updateTextHere.failed),
      )
      .finally(() => {
        setChecking(false);
        reload();
      });
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
      label={managedCopyHere.whombat.title}
      onPress={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Whombat'))}
    />
  );
  if (error)
    return (
      <Screen>
        {back}
        <ErrorState text={managedTextHere.loadError} onRetry={reload} />
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
        <LargeTitle title={thisWhombatText(rawLocale).parts.about} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }} onLayout={place.onContainer}>
          {/* What runs and how it is kept up to date, in one card: the versions, then the updates (waiting, failed, the
              last one with what it brought, AP-258) and their settings. */}
          <VersionCard
            runtime={status.appliance.runtimeVersion}
            hermes={status.appliance.hermes ?? null}
            label={versionText(rawLocale).labelWithUpdates}
          >
            {status.update
              ? updates.rows.map((row, i) => (
                  <Row
                    key={row.title}
                    {...(row.dot ? { dot: row.dot } : {})}
                    title={row.title}
                    meta={
                      row.lastUpdate && summary ? [row.meta, summary].filter(Boolean).join(' · ') : row.meta
                    }
                    action={
                      row.action === 'install' && row.release ? (
                        <Button
                          label={updateTextHere.install}
                          busy={installing === row.release}
                          onPress={() => row.release && install(row.release)}
                        />
                      ) : i === 0 && canCheck ? (
                        <Button
                          label={versionText(rawLocale).check}
                          accessibilityLabel={updateTextHere.check}
                          variant="secondary"
                          // Not `busy`: a spinner for the label would narrow the button under the finger.
                          disabled={checking}
                          onPress={check}
                        />
                      ) : undefined
                    }
                  />
                ))
              : null}
            {status.update ? (
              <>
                {/* What changed lately, on the web app's page (public, so the browser opens it). */}
                <LinkRow
                  title={whatsNewRow(rawLocale).title}
                  body={whatsNewRow(rawLocale).body}
                  label={whatsNewRow(rawLocale).label}
                  onPress={() => void openSignInPage(WHATS_NEW_URL)}
                />
                {/* “Ask before updating” (ask-before-updating.md ABU-01). */}
                <AskFirstRow status={status} onChanged={reload} />
                {/* “Updates from”: Production or Beta (whombat-link.md LNK-21). */}
                <ChannelRow session={managed.session} />
                {floor.length > 0 ? (
                  <Row
                    dot="mut"
                    title={managedTextHere.clientFloor}
                    meta={managedTextHere.clientFloorMeta(floor)}
                  />
                ) : null}
              </>
            ) : null}
            {/* “Keep server agents up to date” (agent-updates-app.md AP-2992). */}
            <AgentUpdatesSwitchRow />
          </VersionCard>

          {/* How it is reached: this phone's connection, Whombat Link, its address, Tailscale (LNK-42). The licence
              shows nothing (LNK-04). */}
          <ReachCard
            session={managed.session}
            reach={reach}
            connection={{
              ok: managed.connection.status === 'open',
              title: managed.applianceName ?? mobileTranslator(rawLocale).t('managed2.about.yourWhombat'),
              meta: `${managedTextHere.connected} · ${managedTextHere.fingerprint(managed.applianceFingerprint)}`,
            }}
            {...(target === 'reach' ? { onLayout: place.onCard } : {})}
          />

          {/* The box's own address (own-address.md): what it is, with Copy. */}
          {status.ownAddress ? <OwnAddressCard own={status.ownAddress} onChanged={reload} /> : null}

          {policy.length > 0 ? (
            <Card label={thisWhombatText(rawLocale).turnedOff}>
              {policy.map(([key, p], i) => (
                <Row key={key} first={i === 0} dot="mut" title={p.reason ?? key} />
              ))}
            </Card>
          ) : null}

          {/* One row for the machine; every part is on the Hardware screen. */}
          <HardwareSummary
            machine={machine}
            onOpen={() =>
              navigation.navigate('WhombatHardware', { back: thisWhombatText(rawLocale).parts.about })
            }
            {...(target === 'hardware' ? { onLayout: place.onCard } : {})}
          />
          {/* Help, last: remote help, a report to the Whombat Team, files for support. */}
          {/* Remote help is a Whombat Link feature (LNK-07); a box before Link keeps the old rule (HE-58, AP-5470). */}
          {remoteHelpShown ? (
            <RemoteHelpSummary here={remoteHelp} onOpen={() => navigation.navigate('WhombatRemoteHelp')} />
          ) : null}
          {reports ? (
            <Card>
              <LinkRow
                first
                title={teamReportWordsHere.entry}
                body={teamReportWordsHere.intro}
                label={`${teamReportWordsHere.entry}. ${teamReportWordsHere.intro}`}
                onPress={() =>
                  navigation.navigate('TeamReports', { back: thisWhombatText(rawLocale).parts.about })
                }
              />
            </Card>
          ) : null}
          <Diagnostics />

          <Text size={12} mono color={theme.colors.mut} style={{ paddingHorizontal: 6 }}>
            {mobileTranslator(rawLocale).t('managed2.about.thisPhone', {
              fingerprint: managedTextHere.fingerprint(managed.deviceFingerprint),
            })}
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
  const { rawLocale } = useI18n();
  const ownAddressWordsHere = ownAddressWords(rawLocale);

  const managed = useManagedOrThrow();
  const theme = useTheme();
  const v = ownAddressView(own, undefined, rawLocale);
  const t = ownAddressWordsHere.settings;
  const leaving = ownAddressLeavingView(own, undefined, undefined, rawLocale);
  const cloudflare = ownAddressCloudflareLine(own.host, undefined, rawLocale);
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
          <Button
            variant="secondary"
            label={t.copy}
            onPress={() => void copyToClipboard(v.url, t.copied, rawLocale)}
          />
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
              showNotice(ownNameText(rawLocale).changed(next.host));
              onChanged();
            }}
          />
        ) : (
          <Button
            variant="secondary"
            label={ownNameText(rawLocale).change}
            onPress={() => setChanging(true)}
          />
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
  const { rawLocale } = useI18n();
  const { session } = useManagedOrThrow();
  const theme = useTheme();
  const N = ownNameText(rawLocale);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { check, type } = useOwnNameCheck(
    (label) => sessionOps.ownAddressCheck(session, label),
    ownAddressLabelOf(own.host),
  );
  const label = ownNameChosen(check);
  const zone = ownNameZoneOf(check.kind === 'done' && check.host ? check.host : own.host);
  const line = ownNameLine(check, zone, rawLocale);
  const lineColor =
    line?.tone === 'ok' ? theme.colors.ok : line?.tone === 'bad' ? theme.colors.bad : theme.colors.mut;
  const submit = async () => {
    if (!label) return;
    setBusy(true);
    setProblem(null);
    try {
      onDone((await sessionOps.ownAddressRename(session, label)).ownAddress);
    } catch (error) {
      setProblem(ownAddressRenameErrorText(error, rawLocale));
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
  const { rawLocale } = useI18n();
  const diagnosticScopeListHere = diagnosticScopeList(rawLocale);
  const managedCopyHere = managedCopy(rawLocale);

  const { session, applianceName } = useManagedOrThrow();
  const theme = useTheme();
  const t = managedCopyHere.diagnostics;
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
          whombat: applianceName ?? mobileTranslator(rawLocale).t('managed2.about.yourWhombat'),
        }),
      );
      await Sharing.shareAsync(file.uri, {
        mimeType: 'text/plain',
        dialogTitle: mobileTranslator(rawLocale).t('managed2.syncLog.dialogTitle'),
      });
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
            {diagnosticScopeListHere.map(({ scope, description }) => (
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
                  {` · ${diagnosticScopeLine(scope, description, rawLocale)}`}
                </Text>
              </Pressable>
            ))}
            <Button
              label={busy ? t.creating : t.create}
              busy={busy}
              disabled={chosen.size === 0}
              onPress={() =>
                void act(async () => {
                  const order = diagnosticScopeListHere.map((x) => x.scope).filter((x) => chosen.has(x));
                  await sessionOps.diagnosticsCreate(session, { scopes: order });
                  setMaking(false);
                })
              }
            />
            <Button
              label={accountsText(rawLocale).cancel}
              variant="quiet"
              disabled={busy}
              onPress={() => setMaking(false)}
            />
          </>
        ) : (
          <Button
            label={thisWhombatText(rawLocale).diagnostics.make}
            variant="secondary"
            onPress={() => {
              setNote(null);
              setMaking(true);
            }}
          />
        )}
        <Note text={note} />
        <Note text={mobileTranslator(rawLocale).t('managed2.syncLog.intro')} />
        <Button
          label={mobileTranslator(rawLocale).t('managed2.syncLog.share')}
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
              ago(d.createdAt, rawLocale),
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
