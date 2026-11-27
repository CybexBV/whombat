/**
 * What the Settings list and its tab's dot read (settings-tab-android.md AP-2623, AP-2624). Each part's own read, the
 * ones its page makes too, so opening a row finds them in the cache: the assistant from the bootstrap (its name and
 * what it runs on) with the AI sign-ins (once, no polling), the box's screen (`desk.get`, AP-5860), and a managed
 * Whombat's status (`appliance.status`, read when the list shows and every five minutes for the dot).
 */

import { useQuery } from '@tanstack/react-query';
import { deskScreenLine, deskSectionShown } from '@whombat/client/desk';
import { useDesk, useDeskScreens } from '@whombat/client/desk/react';
import { updateReady, whombatOverview } from '@whombat/client/managed';
import { placeNewsShown, useSessionProtocol } from '@whombat/client/react';
import Constants from 'expo-constants';
import { useMemo } from 'react';
import { useBurrowBase } from '../data/BurrowProvider';
import { connectionsLine } from '../data/connections';
import { useTheAgentHere } from '../data/useAgent';
import { useConnections } from '../data/useConnections';
import { useI18n } from '../i18n';
import { useManaged } from '../managed/context';
import { overviewInput } from '../managed/thisWhombat';
import { applianceStatusQuery } from '../managed/useApplianceStatus';
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
 * A managed Whombat's line (AP-2626): the shared Overview from its status alone, and “Update ready” while an update
 * waits for the owner's yes; undefined while it loads, null when it can't be read (the Settings home says so, its rows
 * still work).
 */
export function useApplianceLine(): ApplianceLine | null | undefined {
  const { rawLocale } = useI18n();
  const managed = useManaged();
  const { mode, timeZone } = useBurrowBase();
  const status = useQuery({ ...applianceStatusQuery(managed), refetchInterval: FIVE_MINUTES });
  return useMemo(() => {
    if (!managed) return demoApplianceLine(mode, rawLocale);
    if (!status.data) return status.error ? null : undefined;
    const overview = whombatOverview(
      overviewInput({
        status: status.data,
        endpoints: null,
        passkeys: null,
        app: Constants.expoConfig?.version ?? null,
        timeZone,
        locale: rawLocale,
      }),
    );
    return managedApplianceLine(overview, updateReady(status.data), rawLocale);
  }, [managed, mode, status.data, status.error, timeZone, rawLocale]);
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
  const update = useAppUpdate(useManaged()?.updates) !== null;
  const { rawLocale } = useI18n();
  return settingsTabDot({ agent: assistantLine(assistant, rawLocale), appliance: appliance ?? null, update });
}

/** The list's rows with their lines, as far as each part has answered. */
export function useSettingsRows(): SettingsRowView[] {
  const { rawLocale: locale } = useI18n();
  const { mode } = useBurrowBase();
  const { agent, ai } = useAssistantFacts();
  const appliance = useApplianceLine();
  // The same reads as Settings → Connections, so opening it finds them in the cache.
  const { list, rows } = useConnections();
  const connections = useMemo(
    () => (list.data ? connectionsLine(rows, locale) : undefined),
    [list.data, rows, locale],
  );
  const deskApi = useDeskApi();
  const desk = useDesk(deskApi).data;
  const asked = useDeskScreens(deskApi);
  const screens = screensOffered(asked) === 'screens' ? asked.data : undefined;
  // Screens of widgets: how many there are (AP-6000); else the box's own screen's line where it has one.
  // News and weather where the Whombat answers the place and the news.
  const news = placeNewsShown(useSessionProtocol());
  const screenLine = screens
    ? screensRowLine(screens, locale)
    : desk && deskSectionShown(desk)
      ? deskScreenLine(desk.display, locale)
      : null;
  return useMemo(
    () =>
      settingsRows(
        {
          mode,
          agent,
          ai,
          appliance,
          connections,
          screen: screenLine === null ? null : { value: screenLine, tone: null },
          screens: screens !== undefined,
          news,
        },
        locale,
      ),
    [screenLine, screens, mode, agent, ai, appliance, connections, news, locale],
  );
}
