/**
 * What the Settings list and its tab's dot read (settings-tab-android.md AP-2623, AP-2624). Each part's own read, the
 * ones its page makes too, so opening a row finds them in the cache: the assistant from the bootstrap (its name and
 * what it runs on) with the AI sign-ins (once, no polling), the box's screen (`desk.get`, AP-5860), and a managed
 * Whombat's status (`appliance.status`, read when the list shows and every five minutes for the dot).
 */
import { useQuery } from '@tanstack/react-query';
import { deskScreenLine, deskSectionShown } from '@whombat/client/desk';
import { useDesk, useDeskScreens } from '@whombat/client/desk/react';
import { whombatOverview } from '@whombat/client/managed';
import { sessionOps } from '@whombat/client/session';
import Constants from 'expo-constants';
import { useMemo } from 'react';
import { useBurrowBase } from '../data/BurrowProvider';
import { connectionsLine } from '../data/connections';
import { useTheAgentHere } from '../data/useAgent';
import { useConnections } from '../data/useConnections';
import { useManaged } from '../managed/context';
import { overviewInput } from '../managed/thisWhombat';
import { useAppUpdate } from '../managed/useAppUpdate';
import { useDeskApi } from '../managed/useDesk';
import { useAiProviderCards } from './AiSection';
import {
  type ApplianceLine,
  assistantLine,
  demoApplianceLine,
  managedApplianceLine,
  type SettingsRowView,
  settingsRows,
  settingsTabDot,
} from './list';
import { screensOffered, screensRowLine } from './screens/screensList';

const FIVE_MINUTES = 5 * 60_000;

/**
 * A managed Whombat's line (AP-2626): the shared Overview from its status alone; undefined while it loads, null when it
 * can't be read (the Settings home says so, its rows still work).
 */
export function useApplianceLine(): ApplianceLine | null | undefined {
  const managed = useManaged();
  const { mode, timeZone } = useBurrowBase();
  const status = useQuery({
    queryKey: ['settings', 'appliance-status', managed?.cacheScope ?? null],
    queryFn: () => {
      if (!managed) throw new Error('not a managed Whombat');
      return sessionOps.applianceStatus(managed.session);
    },
    enabled: !!managed,
    retry: false,
    staleTime: 60_000,
    refetchInterval: FIVE_MINUTES,
  });
  return useMemo(() => {
    if (!managed) return demoApplianceLine(mode);
    if (!status.data) return status.error ? null : undefined;
    const overview = whombatOverview(
      overviewInput({
        status: status.data,
        endpoints: null,
        passkeys: null,
        app: Constants.expoConfig?.version ?? null,
        timeZone,
      }),
    );
    return managedApplianceLine(overview);
  }, [managed, mode, status.data, status.error, timeZone]);
}

/** The assistant's line from what the bootstrap and the AI sign-ins say. */
function useAssistantFacts() {
  const agent = useTheAgentHere();
  const ai = useAiProviderCards();
  const facts = useMemo(
    () => (agent ? { name: agent.name, provider: agent.runtime.provider } : undefined),
    [agent],
  );
  return { agent: facts, ai };
}

/** The Settings tab's dot (AP-2624): the assistant's AI sign-in and This Whombat, then a newer app. */
export function useSettingsTabDot(): 'ok' | 'warn' | 'bad' | null {
  const assistant = useAssistantFacts();
  const appliance = useApplianceLine();
  const update = useAppUpdate(useManaged()?.control) !== null;
  return settingsTabDot({ agent: assistantLine(assistant), appliance: appliance ?? null, update });
}

/** The list's rows with their lines, as far as each part has answered. */
export function useSettingsRows(): SettingsRowView[] {
  const { mode } = useBurrowBase();
  const { agent, ai } = useAssistantFacts();
  const appliance = useApplianceLine();
  // The same reads as Settings → Connections, so opening it finds them in the cache.
  const { list, rows } = useConnections();
  const connections = useMemo(() => (list.data ? connectionsLine(rows) : undefined), [list.data, rows]);
  const deskApi = useDeskApi();
  const desk = useDesk(deskApi).data;
  const asked = useDeskScreens(deskApi);
  const screens = screensOffered(asked) === 'screens' ? asked.data : undefined;
  // Screens of widgets: how many there are (AP-6000); else the box's own screen's line where it has one.
  const screenLine = screens
    ? screensRowLine(screens)
    : desk && deskSectionShown(desk)
      ? deskScreenLine(desk.display)
      : null;
  return useMemo(
    () =>
      settingsRows({
        mode,
        agent,
        ai,
        appliance,
        connections,
        screen: screenLine === null ? null : { value: screenLine, tone: null },
        screens: screens !== undefined,
      }),
    [screenLine, screens, mode, agent, ai, appliance, connections],
  );
}
