/**
 * Settings' home (`/settings`; the final design, docs/design-handoff/council-ui-2026-11/16-final/settings/,
 * docs/decisions/final-settings-vault-files-usage.md): **Often used** — Notifications, Phone app (the Phone app page,
 * saying which phone is in once one is) and Theme opening its Light / Dark / Auto choice in place — beside
 * **All settings**, the groups in their one order (You, the assistant by its name, Connections, This Whombat, News and
 * weather where this Whombat answers it, Screens where this Whombat has screens, Advanced), each with its own icon and
 * what it holds; This Whombat's says what needs you there while
 * something does. Your saved settings are read here; while they load or when they can't be read a card says so in
 * Often used and every row keeps working.
 */
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  agentGroupParts,
  hasLooksAhead,
  SETTINGS_HOME_TEXT,
  type SettingsHomeGroup,
  settingsHomeRows,
  THEME_CHOICES,
  THEME_WORDS,
} from '@whombat/client';
import { DESK_TEXT } from '@whombat/client/desk';
import { whombatOverview } from '@whombat/client/managed';
import { placeNewsShown, usePreferences, useSessionProtocol, useTheAgent } from '@whombat/client/react';
import { sessionOps } from '@whombat/client/session';
import {
  Bell,
  Bot,
  Box,
  Contrast,
  type LucideIcon,
  Monitor,
  Newspaper,
  Plug,
  Settings as SettingsIcon,
  SlidersVertical,
  Smartphone,
  User,
} from 'lucide-react';
import { Fragment, type ReactNode, useId, useMemo, useState } from 'react';
import { useAppServices } from '../../app/providers';
import { useTheme } from '../../app/theme';
import { cx } from '../../components/cx';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusDot } from '../../components/StatusDot';
import { useBackupPasskeyTap } from '../../managed/backupPasskey';
import { useDeskUnlockHere } from '../desk/useDeskHere';
import { useApplianceStatus } from './ManagedTabs';
import { errorDetail, PlacePage, PlaceRowBody, PlaceState, placeStyles as p } from './Place';
import styles from './SettingsHome.module.css';
import { useScreenPart } from './ThisWhombatTab';
import { useYouParts } from './useYouParts';

/** A distinct line icon per group. */
const GROUP_ICONS: Record<SettingsHomeGroup, LucideIcon> = {
  you: User,
  agent: Bot,
  connections: Plug,
  appliance: Box,
  news: Newspaper,
  screens: Monitor,
  advanced: SlidersVertical,
};

/** Where a group's row goes: its page (You has no `tab`, its first part is explicit so the home isn't it). */
const GROUP_SEARCH: Record<SettingsHomeGroup, Record<string, string>> = {
  you: { part: 'profile' },
  agent: { tab: 'agent' },
  connections: { tab: 'connections' },
  appliance: { tab: 'appliance' },
  news: { tab: 'news' },
  screens: { tab: 'appliance', section: 'screen' },
  advanced: { tab: 'advanced' },
};

const THEMES = THEME_CHOICES.map((value) => ({ value, label: THEME_WORDS.choices[value] }));

export function SettingsHome({ burrow }: { burrow: string }) {
  const { words } = useTheAgent(burrow);
  const { managed } = useAppServices();
  const prefs = usePreferences({}, { staleTime: 0 });
  const screen = useScreenPart(burrow, false);
  const you = useYouParts(burrow);
  const protocol = useSessionProtocol();
  const agentParts = agentGroupParts({ looksAhead: hasLooksAhead(protocol) });
  const news = placeNewsShown(protocol);
  const rows = settingsHomeRows(words.name, you, agentParts).filter(
    (r) => (r.key !== 'screens' || screen.shown) && (r.key !== 'news' || news),
  );
  const needs = useApplianceNeeds(burrow, words.name);
  const phones = useSignedInPhones(burrow);
  const oftenId = useId();
  const allId = useId();
  return (
    <PlacePage
      screen="settings"
      title={SETTINGS_HOME_TEXT.title}
      intro={SETTINGS_HOME_TEXT.subtitle(words.name)}
    >
      <div className={styles.columns}>
        <section aria-labelledby={oftenId} className={styles.column}>
          <h2 id={oftenId} className={p.sectionTitle}>
            {SETTINGS_HOME_TEXT.oftenUsed}
          </h2>
          <ul className={p.card}>
            <li>
              <Link to="/settings" search={{ part: 'notifications' } as never} className={p.row}>
                <PlaceRowBody
                  icon={Bell}
                  name={SETTINGS_HOME_TEXT.notifications.title}
                  line={SETTINGS_HOME_TEXT.notifications.line}
                />
              </Link>
            </li>
            <li>
              <Link
                to="/settings"
                search={{ tab: 'phone' } as never}
                className={p.row}
                data-settings-row="phone-app"
              >
                <PlaceRowBody
                  icon={Smartphone}
                  name={SETTINGS_HOME_TEXT.phoneApp.title}
                  line={phones.known ? <PhoneAppLine qr={managed !== null} phones={phones.names} /> : PENDING}
                />
              </Link>
            </li>
            <li>
              <ThemeRow />
            </li>
          </ul>
          {prefs.data === undefined && prefs.error ? (
            <PlaceState
              kind="failed"
              icon={SettingsIcon}
              title={SETTINGS_HOME_TEXT.failedTitle}
              line={SETTINGS_HOME_TEXT.failedLine}
              retryLabel={SETTINGS_HOME_TEXT.retry}
              onRetry={() => void prefs.refetch()}
              detail={errorDetail(prefs.error)}
            />
          ) : prefs.data === undefined && prefs.isFetching ? (
            <PlaceState kind="loading" icon={SettingsIcon} title={SETTINGS_HOME_TEXT.loading} />
          ) : null}
        </section>
        <section aria-labelledby={allId} className={styles.column}>
          <h2 id={allId} className={p.sectionTitle}>
            {SETTINGS_HOME_TEXT.allSettings}
          </h2>
          <ul className={p.card}>
            {rows.map((row) => (
              <li key={row.key}>
                <Link
                  to="/settings"
                  search={GROUP_SEARCH[row.key] as never}
                  className={p.row}
                  data-settings-group={row.key}
                >
                  <PlaceRowBody
                    icon={GROUP_ICONS[row.key]}
                    name={row.title}
                    line={
                      row.key !== 'appliance' ? (
                        <PartsLine line={row.line} />
                      ) : !needs.known ? (
                        PENDING
                      ) : needs.items.length > 0 ? (
                        <NeedsLine items={needs.items} />
                      ) : (
                        <PartsLine line={row.line} />
                      )
                    }
                  />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </PlacePage>
  );
}

/**
 * A row's line that isn't known yet: it keeps the row's height and says nothing, so the right words come in once instead
 * of one line changing into another.
 */
const PENDING = (
  <span className={styles.pending} aria-hidden="true">
    {' '}
  </span>
);

/** A group's line that breaks only between its parts (“What Neo may do” stays whole), each dot with the part before it. */
function PartsLine({ line }: { line: string }) {
  const parts = line.split(' · ');
  if (parts.length < 2) return <>{line}</>;
  return (
    <>
      {parts.map((part, i) => {
        const last = i === parts.length - 1;
        return (
          <Fragment key={part}>
            <span className={styles.part}>{last ? part : `${part} ·`}</span>
            {last ? null : ' '}
          </Fragment>
        );
      })}
    </>
  );
}

interface NeedsItem {
  key: string;
  dot: 'bad' | 'warn' | 'mut' | 'ok';
  title: string;
}

/**
 * What This Whombat's Overview has under NEEDS YOU, in its order: the screen asking to unlock first, then backups that
 * aren't set up or are failing and the passkey to set up, worst first. `known` once the box and the passkey have answered
 * (or couldn't), at once where the Whombat isn't a box.
 */
function useApplianceNeeds(burrow: string, agent: string): { known: boolean; items: NeedsItem[] } {
  const { managed } = useAppServices();
  const appliance = useApplianceStatus();
  const passkey = useBackupPasskeyTap();
  const passkeys = passkey?.view ?? null;
  const passkeyKnown = !passkey || passkeys !== null || Boolean(passkey.loadError);
  const asking = useDeskUnlockHere(burrow).request !== null;
  return useMemo(() => {
    const overview = whombatOverview({
      status: appliance.status,
      devices: null,
      passkeys,
      access: null,
      agent,
    });
    const desk: NeedsItem[] = asking ? [{ key: 'desk', dot: 'warn', title: DESK_TEXT.unlock.title }] : [];
    return {
      known: !managed || ((appliance.status !== null || appliance.error) && passkeyKnown),
      items: [...desk, ...overview.needsYou],
    };
  }, [managed, appliance.status, appliance.error, passkeys, passkeyKnown, asking, agent]);
}

/** The first thing that needs you, in its dot's colour, and how many more. */
function NeedsLine({ items }: { items: readonly NeedsItem[] }) {
  const first = items[0];
  if (!first) return null;
  return (
    <span
      className={cx(
        styles.needs,
        first.dot === 'bad' ? styles.needsBad : first.dot === 'warn' && styles.needsWarn,
      )}
    >
      <StatusDot tone={first.dot} size={8} label={null} />
      {SETTINGS_HOME_TEXT.needsYou(first.title, items.length - 1)}
    </span>
  );
}

/**
 * The phones signed in to this Whombat (not removed), by their names. Asked each time the home opens and when the window
 * comes back, so a phone added or removed elsewhere shows; `known` once it answered or couldn't (then no names: the row
 * offers the code, as it always could).
 */
function useSignedInPhones(burrow: string): { known: boolean; names: string[] } {
  const { session, managed } = useAppServices();
  const phones = useQuery({
    queryKey: ['settings-home', 'phones', burrow],
    enabled: managed !== null,
    staleTime: 0,
    retry: 1,
    refetchOnWindowFocus: true,
    queryFn: async () =>
      (await sessionOps.endpointsList(session)).endpoints
        .filter((d) => d.revocation === 'none' && (d.platform === 'android' || d.platform === 'ios'))
        .map((d) => d.label),
  });
  return { known: !managed || phones.data !== undefined || phones.isError, names: phones.data ?? [] };
}

/**
 * The Phone app row's line: which phone is in once one is; else signing one in by its code, and on a phone's own screen
 * (which can't scan its own code) getting the app there or signing in another phone.
 */
function PhoneAppLine({ qr, phones }: { qr: boolean; phones: readonly string[] }): ReactNode {
  const t = SETTINGS_HOME_TEXT.phoneApp;
  if (phones.length > 0) return <>{t.signedIn(phones)}</>;
  if (!qr) return <>{t.line(false)}</>;
  return (
    <>
      <span className={styles.wideOnly}>{t.line(true)}</span>
      <span className={styles.narrowOnly}>{t.lineHere}</span>
    </>
  );
}

/**
 * Theme: says which one is chosen, and opens its Light / Dark / Auto choice in place (its chevron points down, up while
 * open), kept on this device and in your account like the account menu's.
 */
function ThemeRow() {
  const { choice, setChoice } = useTheme();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <>
      <button
        type="button"
        className={p.row}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        data-settings-row="theme"
      >
        <PlaceRowBody
          icon={Contrast}
          name={SETTINGS_HOME_TEXT.theme.title}
          line={SETTINGS_HOME_TEXT.themeNow(THEME_WORDS.choices[choice])}
          chevron="down"
        />
      </button>
      {open ? (
        <div id={panelId} className={styles.themeChoice}>
          <SegmentedControl
            label={SETTINGS_HOME_TEXT.theme.title}
            value={choice}
            onChange={setChoice}
            options={THEMES}
          />
        </div>
      ) : null}
    </>
  );
}
