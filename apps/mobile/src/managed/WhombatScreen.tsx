/**
 * This Whombat's Overview (managed only; AP-22, AP-27; this-whombat-sections-android.md AP-1241…AP-1245), the
 * phone's version of the web's Settings · This Whombat → Overview (Whombat this-whombat-sections.md AP-1223…AP-1227):
 * the desk screen's unlock request and a newer app on top (`DeskUnlockCard`, `UpdateCard`), then NEEDS YOU — what is
 * wrong, each with the one button that fixes it, left out when empty — then on a Whombat with `host.metrics` HOW IT’S
 * DOING (the four tiles, the charts behind “Show charts”; `HostStatusSection`), the box's SCREEN where it has one
 * (a row that opens Settings → Screen, `DeskSettingsRow`, desk-display-android.md AP-5861), VOICE TYPING (`VoiceSection`, docs/decisions/dictation.md), its NETWORK (`NetworkSection`, hardware-support-android.md AP-3251)
 * and BLUETOOTH (`BluetoothSection`, bluetooth-android.md AP-3751), then AT A GLANCE, one row per thing, each opening
 * its part: Backups, Devices or About (the audit log is Settings → Advanced's). The lists and their words
 * are the shared `whombatOverview`; what the phone read for them and where each row goes is `thisWhombat.ts`. Coming
 * back to it reads everything again (a destination set up, a passkey added). Pushes
 * about the Whombat itself open it; so does Settings → This Whombat. Not mocked: a pushed screen in settings' language.
 */

import { useIsFocused } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { DESK_QUERY_KEY, useDesk } from '@whombat/client/desk/react';
import { THIS_WHOMBAT_TEXT, whombatOverview } from '@whombat/client/managed';
import { sessionOps } from '@whombat/client/session';
import Constants from 'expo-constants';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, View } from 'react-native';
import { useBurrowBase } from '../data/BurrowProvider';
import { useAgentWords } from '../data/useAgent';
import { useI18n, useMobileT } from '../i18n';
import { useAppNavigation } from '../navigation/hooks';
import { UpdateCard } from '../settings/UpdateCard';
import { useDeskNameSync } from '../settings/useDeskName';
import { Text } from '../theme/Text';
import { useTheme } from '../theme/theme';
import { BackBar, LargeTitle, Screen } from '../ui/headers';
import { Button, ErrorState, Loading } from '../ui/primitives';
import { useBottomRoom } from '../ui/screenBottom';
import { useVoiceApi } from '../voice/useVoiceApi';
import { BluetoothSection } from './BluetoothSection';
import { useBackupPasskeyTap } from './backupPasskey';
import { useManagedOrThrow } from './context';
import { managedCopy, managedText } from './copy';
import { DeskSettingsRow } from './DeskSection';
import { DeskUnlockCard } from './DeskUnlockCard';
import { HostStatusSection } from './HostStatus';
import { MailSection, useMailHere } from './MailSection';
import { NetworkSection } from './NetworkSection';
import { TailscaleSection } from './TailscaleSection';
import {
  glanceRows,
  type NeedsRow,
  needsRows,
  type OverviewFacts,
  overviewInput,
  type WhombatStep,
} from './thisWhombat';
import { Card, dotColor, LinkRow } from './ui';
import { useApplianceStatus } from './useApplianceStatus';
import { useDeskApi } from './useDesk';
import { useMachineHere } from './useMachine';
import { useTailscaleHere } from './useTailscale';
import { VoiceSection } from './VoiceSection';

const T = THIS_WHOMBAT_TEXT;

type Lists = Pick<OverviewFacts, 'endpoints'>;

/**
 * What NEEDS YOU and AT A GLANCE are made of besides the status (AP-1241): your devices and your passkeys where this
 * phone can make them. Null until both answered, so the Overview shows at once rather than rows (and buttons) moving
 * in under a finger; one that can't be read (or needs a newer app) is left out rather than guessed, and a later read
 * that fails keeps what was shown.
 */
function useOverviewLists() {
  const { session } = useManagedOrThrow();
  const [lists, setLists] = useState<Lists | null>(null);
  const load = useCallback(() => {
    const read = <R,>(work: Promise<R>) => work.catch(() => null);
    void read(sessionOps.endpointsList(session)).then((endpoints) =>
      setLists((prev) => ({ endpoints: endpoints?.endpoints ?? prev?.endpoints ?? null })),
    );
  }, [session]);
  useEffect(load, [load]);
  return { lists, reload: load };
}

export function WhombatScreen() {
  const { rawLocale } = useI18n();
  const managedCopyHere = managedCopy(rawLocale);
  const managedTextHere = managedText(rawLocale);

  const { t: tMobile } = useMobileT();
  const bottomRoom = useBottomRoom();
  const navigation = useAppNavigation();
  const managed = useManagedOrThrow();
  const { status, error, reload } = useApplianceStatus();
  const { lists, reload: reloadLists } = useOverviewLists();
  const { timeZone } = useBurrowBase();
  const agent = useAgentWords().name;
  // The box's own screen (desk-display-android.md AP-3051, AP-3054): its unlock request on top, SCREEN after the status.
  const desk = useDeskApi();
  // The screen's top bar gets the Whombat's name when this opens (DK-119, AP-5870).
  useDeskNameSync(desk, useDesk(desk).data);
  // Voice typing, heard by the Whombat itself (docs/decisions/dictation.md DT-06): after SCREEN.
  const voice = useVoiceApi();
  const machine = useMachineHere();
  // TAILSCALE (HE-51, AP-5378).
  const tailscale = useTailscaleHere();
  // EMAIL: a community box's own mail server (HE-61, AP-5477).
  const mail = useMailHere();
  const qc = useQueryClient();

  // Back from a part (or the kit's flow): read again, quietly, so what was fixed leaves NEEDS YOU.
  const focused = useIsFocused();
  const seen = useRef(false);
  useEffect(() => {
    if (!focused) return;
    if (!seen.current) {
      seen.current = true;
      return;
    }
    reload();
    reloadLists();
    void qc.invalidateQueries({ queryKey: DESK_QUERY_KEY });
  }, [focused, reload, reloadLists, qc]);

  // Offer the same setup here; Backups explains where to finish when this phone cannot use passkeys.
  const tap = useBackupPasskeyTap();
  const refreshPasskey = tap?.refresh;
  useEffect(() => {
    if (focused) void refreshPasskey?.();
  }, [focused, refreshPasskey]);
  // While the passkey is asked the button says so, and what came of it stays under it (the strip's note passes).
  const touching = tap?.busy ?? false;
  const touchSaid = tap?.note ?? null;
  const open = (name: string, params?: object) =>
    (navigation.navigate as (name: string, params?: object) => void)(name, params);
  const go = (step: WhombatStep) => {
    if (step.to === 'kit') return managed.onKit ? managed.onKit() : open('WhombatBackups');
    if (step.to === 'passkey') {
      if (!tap) return open('WhombatBackups');
      if (touching) return;
      void tap().then(() => {
        reload();
        reloadLists();
      });
      return;
    }
    open(step.to, step.params);
  };

  const back = <BackBar label={tMobile('managed.back')} onPress={() => navigation.goBack()} />;
  if (error)
    return (
      <Screen>
        {back}
        <ErrorState text={managedTextHere.loadError} onRetry={reload} />
      </Screen>
    );
  if (!status || !lists)
    return (
      <Screen>
        {back}
        <Loading />
      </Screen>
    );
  const overview = whombatOverview(
    overviewInput({
      status,
      ...lists,
      passkeys: tap?.view ?? null,
      app: Constants.expoConfig?.version ?? null,
      timeZone,
      agent,
    }),
  );
  const needs = needsRows(overview);
  const glance = glanceRows(overview);
  return (
    <Screen>
      {back}
      <ScrollView contentContainerStyle={{ paddingBottom: 40 + bottomRoom }}>
        <LargeTitle title={managedCopyHere.whombat.title} />
        <View style={{ paddingHorizontal: 16, gap: 14, paddingTop: 8 }}>
          <DeskUnlockCard api={desk} />
          <UpdateCard />
          {needs.length > 0 ? (
            <Card label={T.needsYou}>
              {needs.map((row, i) => (
                <NeedsYouRow
                  key={row.key}
                  row={row}
                  first={i === 0}
                  onPress={() => go(row.step)}
                  {...(row.step.to === 'passkey' && {
                    busy: touching,
                    buttonLabel: tap?.label,
                    said: touchSaid,
                  })}
                />
              ))}
            </Card>
          ) : null}
          {/* How it's doing (BS-01, BS-12): live while this screen is in front; the charts folded. */}
          <HostStatusSection />
          <DeskSettingsRow api={desk} onOpen={() => navigation.navigate('SettingsDesk')} />
          <VoiceSection api={voice} />
          <NetworkSection
            machine={machine}
            onHardware={() => navigation.navigate('WhombatHardware', { back: managedCopyHere.whombat.title })}
            onRepoint={() => navigation.navigate('RepointServers')}
          />
          <TailscaleSection here={tailscale} />
          <MailSection here={mail} />
          <BluetoothSection
            machine={machine}
            onHardware={() => navigation.navigate('WhombatHardware', { back: managedCopyHere.whombat.title })}
          />
          <Card label={T.glance}>
            {glance.map((row, i) => (
              <LinkRow
                key={row.key}
                first={i === 0}
                dot={row.dot}
                title={row.title}
                meta={row.meta}
                label={row.label}
                onPress={() => go(row.step)}
              />
            ))}
          </Card>
        </View>
      </ScrollView>
    </Screen>
  );
}

/**
 * A NEEDS YOU row (AP-1242): the dot, the title and its line, and under them the one button that fixes it. The dot is
 * the title's colour only (the title says what is wrong), so TalkBack reads the words and the button.
 */
function NeedsYouRow({
  row,
  first,
  onPress,
  busy = false,
  buttonLabel,
  said = null,
}: {
  row: NeedsRow;
  first: boolean;
  onPress: () => void;
  /** The step is under way (the passkey's touch): the button waits and says so. */
  busy?: boolean;
  buttonLabel?: string;
  /** What the step said when it ended, under the button. */
  said?: string | null;
}) {
  const theme = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 12,
        paddingVertical: 14,
        paddingHorizontal: 16,
        borderTopWidth: first ? 0 : 1,
        borderTopColor: theme.colors.line,
      }}
    >
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={THIS_WHOMBAT_TEXT.dotLabels[row.dot]}
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          marginTop: 7,
          backgroundColor: dotColor(theme, row.dot),
        }}
      />
      <View style={{ flex: 1, gap: 3 }}>
        <Text size={15} weight={500} lh={1.35}>
          {row.title}
        </Text>
        {row.meta ? (
          <Text size={12} mono lh={1.45} color={theme.colors.mut}>
            {row.meta}
          </Text>
        ) : null}
        <Button
          label={buttonLabel ?? row.button}
          variant="secondary"
          busy={busy}
          onPress={onPress}
          style={{ alignSelf: 'flex-start', paddingHorizontal: 16, marginTop: 9 }}
        />
        {said ? (
          <Text size={13} lh={1.45} color={theme.colors.mut} accessibilityLiveRegion="polite">
            {said}
          </Text>
        ) : null}
      </View>
    </View>
  );
}
