import { Link, useLocation } from '@tanstack/react-router';
import {
  type AdvancedPart,
  type AgentGroupPart,
  SETTINGS_GROUP_TEXT,
  SETTINGS_HOME_TEXT,
  type YouPart,
} from '@whombat/client';
import { placeNewsShown, useSessionProtocol, useTheAgent } from '@whombat/client/react';
import { NEWS_WORDS } from '@whombat/core';
import { useEffect } from 'react';
import type { SettingsTab, WhombatTabPart } from '../../app/routing/search';
import { AgentTab } from '../agent/settings/AgentTab';
import type { ScreenPart } from '../desk/screenTab';
import { PhoneAppPanel, PhoneAppSub, usePhoneAppSources } from '../mobile';
import { UsageScreen } from '../spend';
import { AdvancedTab } from './AdvancedTab';
import { ConnectionsTab } from './ConnectionsTab';
import { NewsWeatherTab } from './NewsWeatherTab';
import { BackLabel, PlacePage, placeStyles as place } from './Place';
import { SettingsHome } from './SettingsHome';
import styles from './SettingsScreen.module.css';
import { ThisWhombatTab, useScreenPart } from './ThisWhombatTab';
import { YouTab } from './YouTab';

export interface SettingsScreenProps {
  burrow: string;
  /** The home (`/settings` with nothing after it): Often used and the groups. */
  home?: boolean;
  /**
   * `you` (no `?tab=`, a part named), `agent`, `connections`, `appliance`, `news` or `advanced` (settings-groups.md).
   */
  tab: SettingsTab;
  /** You's part (`&part=`): Profile without. */
  youPart?: YouPart;
  /** The assistant's part (`&part=`): Name and face without. */
  agentPart?: AgentGroupPart;
  /** Opens another part of You or the assistant (replaces `&part=`). */
  onPartChange?: (part: string) => void;
  /** Advanced's page (`&part=`): its list without. */
  advancedPart?: AdvancedPart;
  /** What it may do → KEYS: the key row to show (`&key=`). */
  agentKey?: string;
  /** This Whombat: the part that is open (`&section=`); the Overview by default. */
  section?: WhombatTabPart;
  /** Opens another part of This Whombat (replaces `&section=`), at a place in it when `hash` is given. */
  onSectionChange?: (section: WhombatTabPart, hash?: string) => void;
  /** This Whombat → Screen: the part that is open (`&part=`); What it shows by default. */
  screenPart?: ScreenPart;
  /** Opens another part of Screen (replaces `&part=`). */
  onScreenPartChange?: (part: ScreenPart) => void;
  /** Screens: a screen's own page (`&screen=`); the list without. */
  screen?: string;
  /** Opens a screen's page, or the list (`undefined`). */
  onScreenChange?: (screen: string | undefined) => void;
  /** *Edit layout*: opens the editor's page. */
  onEditLayout?: (screen: string) => void;
}

const PANEL_ID = 'settings-panel';

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** How long a link's `#anchor` is looked for while its section loads (`#passkeys`, `#set-up`). */
const ANCHOR_WAIT_MS = 4_000;

/**
 * Scrolls to the address's `#anchor` once its section is on the page — sections load after the tab, so it is looked
 * for a little while (a MutationObserver, then given up) — and again whenever the hash changes.
 */
function useAnchorScroll(tab: SettingsTab) {
  const hash = useLocation({ select: (l) => l.hash });
  // biome-ignore lint/correctness/useExhaustiveDependencies: a redirect lands on a new tab with its hash: scroll then too
  useEffect(() => {
    const id = hash.replace(/^#/, '');
    if (!id) return;
    const scroll = () => {
      const el = document.getElementById(id);
      if (!el) return false;
      el.scrollIntoView?.({ block: 'start' });
      return true;
    };
    if (scroll()) return;
    const observer = new MutationObserver(() => {
      if (scroll()) observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    const timer = setTimeout(() => observer.disconnect(), ANCHOR_WAIT_MS);
    return () => {
      observer.disconnect();
      clearTimeout(timer);
    };
  }, [hash, tab]);
}

/**
 * Settings (settings-groups.md; the final design, docs/decisions/final-settings-vault-files-usage.md): `/settings` alone
 * is the home (`SettingsHome`: Often used, then the groups); every group is a page of its own with “Back to
 * Settings” and its name as the title:
 * - **You** (no `?tab=`, a part named): your profile, notifications, and on a box your devices and passkeys (`&part=`).
 * - **the assistant by its name** (`?tab=agent`): its name and face, the AI sign-in, what it remembers and what it may
 *   do (`&part=`).
 * - **Connections** (`?tab=connections`): what this Whombat is signed in to, and how; what needs you first.
 * - **This Whombat** (`?tab=appliance`): the Overview, backups, the screen and About (`&section=`).
 * - **News and weather** (`?tab=news`), where the Whombat answers them: where it is, and the sources of its headlines.
 * - **Advanced** (`?tab=advanced`): folded — a list of the expert pages, each at `&part=`.
 * - **Phone app** (`?tab=phone`), Often used's: signing a phone in by its code and getting the app.
 * The tabs and parts from before redirect (`settingsRedirect`). Reached from the account menu in the sidebar. Every
 * action here is a signed event through the commit-pipeline API, never a direct write.
 */
export function SettingsScreen({
  burrow,
  home = false,
  tab,
  youPart,
  agentPart,
  onPartChange,
  advancedPart,
  agentKey,
  section = 'overview',
  onSectionChange,
  screenPart,
  onScreenPartChange,
  screen: screenId,
  onScreenChange,
  onEditLayout,
}: SettingsScreenProps) {
  // The agent, by its name (Whombat one-agent.md OA-08).
  const { words } = useTheAgent(burrow);
  const names = SETTINGS_GROUP_TEXT.groups(words.name);
  useAnchorScroll(tab);

  // This Whombat's Screen part goes by the home's row name, where this Whombat has one.
  const screensPart = useScreenPart(burrow, tab === 'appliance' && section === 'screen');
  // News and weather is only a Whombat's that answers it; elsewhere its address opens the home, as a missing part would.
  const news = placeNewsShown(useSessionProtocol());
  if (home || (tab === 'news' && !news)) return <SettingsHome burrow={burrow} />;
  // Usage is a place of its own (final-shell-web.md): the Spend report at its old address, without Settings' groups.
  if (tab === 'advanced' && advancedPart === 'spend') return <UsageScreen burrow={burrow} />;
  const title =
    tab === 'phone'
      ? SETTINGS_HOME_TEXT.phoneApp.title
      : tab === 'appliance' && section === 'screen' && screensPart.shown
        ? SETTINGS_HOME_TEXT.screensTitle
        : capital(names[tab]);
  return (
    <PlacePage
      screen="settings-group"
      title={title}
      wide={tab === 'appliance' && section === 'screen'}
      intro={tab === 'phone' ? <PhoneAppIntro /> : tab === 'news' ? NEWS_WORDS.pageLine : undefined}
      back={
        <Link to="/settings" className={place.back} data-settings-back="">
          <BackLabel>{SETTINGS_HOME_TEXT.back}</BackLabel>
        </Link>
      }
    >
      <section id={PANEL_ID} aria-label={title} className={styles.panel} data-settings-group={tab}>
        {tab === 'phone' ? (
          <PhoneAppPanel />
        ) : tab === 'agent' ? (
          <AgentTab
            burrow={burrow}
            part={agentPart}
            agentKey={agentKey}
            onPartChange={(next) => onPartChange?.(next)}
          />
        ) : tab === 'connections' ? (
          <ConnectionsTab burrow={burrow} />
        ) : tab === 'appliance' ? (
          <ThisWhombatTab
            burrow={burrow}
            section={section}
            onSectionChange={onSectionChange}
            screenPart={screenPart}
            onScreenPartChange={onScreenPartChange}
            screen={screenId}
            onScreenChange={onScreenChange}
            onEditLayout={onEditLayout}
          />
        ) : tab === 'news' ? (
          <NewsWeatherTab burrow={burrow} />
        ) : tab === 'advanced' ? (
          <AdvancedTab burrow={burrow} part={advancedPart} />
        ) : (
          <YouTab burrow={burrow} part={youPart} onPartChange={(next) => onPartChange?.(next)} />
        )}
      </section>
    </PlacePage>
  );
}

/** Phone app's line under its title: what the app is for (on a phone's own screen, getting it there first). */
function PhoneAppIntro() {
  const { signIn } = usePhoneAppSources();
  return <PhoneAppSub qr={signIn !== null} />;
}
