import { replaceEqualDeep } from '@tanstack/react-query';
import { Link, useRouterState } from '@tanstack/react-router';
import type { ThemeChoice } from '@whombat/client';
import { SETTINGS_HOME_TEXT, TEAM_REPORT_WORDS, THEME_CHOICES, THEME_WORDS } from '@whombat/client';
import { useTeamReportsEntry } from '@whombat/client/react';
import {
  ChevronRight,
  Folder,
  Inbox,
  LayoutGrid,
  Lock,
  LogOut,
  type LucideIcon,
  MessageCircle,
  MessageSquare,
  Monitor,
  Moon,
  Plug,
  Plus,
  Server,
  Settings2,
  Smartphone,
  Sun,
  Zap,
} from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, memo, useId, useState } from 'react';
import { cx, variantClass } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { isApplePlatform, Kbd } from '../../components/Kbd';
import { SegmentedControl } from '../../components/SegmentedControl';
import { StatusMark } from '../../components/StatusMark';
import { useInboxSplit } from '../../features/chats/inboxNav';
import { useClearChat } from '../../features/chats/useClearChat';
import { useSettleFinishedThreads } from '../../features/chats/useSettle';
import { AppLink } from '../../features/files/AppLink';
import { PersonAvatar } from '../../features/messaging/PersonAvatar';
import { useWhombatVersions } from '../../features/settings/version';
import { useNavigateHref } from '../routing/navigation';
import { useTheme } from '../theme';
import { AccountMenuVersion } from './AccountMenuVersion';
import styles from './AssistantSidebar.module.css';
import {
  type AssistantNavId,
  type AssistantNavRow,
  type AssistantSidebarModel,
  navMenu,
} from './assistantSidebarModel';
import { type ContextMenuItem, useRowMenu } from './ContextMenu';
import { WhombatSwitcher } from './WhombatSwitcher';

const NAV_ICONS: Record<AssistantNavId, LucideIcon> = {
  chat: MessageCircle,
  // What needs the person: what comes in for them to decide (needs-you-list.md NYL-05).
  needsYou: Inbox,
  // Servers and Connections, places of their own (servers-connections-places.md).
  servers: Server,
  connections: Plug,
  // Overview, at `/connections` or (before the Chat shell) `/` (sidebar-tabs.md): the servers and connections at a glance.
  dashboard: LayoutGrid,
  home: LayoutGrid,
  automations: Zap,
  files: Folder,
  vault: Lock,
};

export interface AssistantSidebarProps {
  model: AssistantSidebarModel;
  onSignOut: () => void;
}

/**
 * The sidebar (final-shell-web.md; mock 1; one-whombat.md ONE-04): the burrow alone, with room under it (with other
 * Whombats it opens them, whombat-switcher.md), the places in one order — Chat, Inbox, Overview, Servers,
 * Connections, Automations, Files, Vault (Search is ⌘K / Ctrl K; Settings is in the account menu and ⌘, / Ctrl ,;
 * Servers and Connections carry the worst mark of what they hold, servers-connections-places.md) — then the
 * person, whose row opens the account menu. Rows are links; the selected one has the
 * `sel` background, weight 600 and `aria-current="page"`; a badge's number is said once, in the row's name. The lists
 * scroll between the burrow and the person. Below 1024 px the same sidebar is the Places drawer (ShellLayout).
 * Memoized: the shell renders on every realtime event, the sidebar only when what it shows changes.
 */
export const AssistantSidebar = memo(function AssistantSidebar({ model, onSignOut }: AssistantSidebarProps) {
  const ids = useId();
  // A place's right-click menu (chat-clear.md AP-4500…AP-4507); one open at a time.
  const menu = useRowMenu();
  // The list shows beside a page on a wide window, unless Ask took its room.
  const askOpen = useRouterState({ select: (st) => (st.location.search as { ask?: string }).ask === '1' });
  const split = useInboxSplit() && !askOpen;
  const navigate = useNavigateHref();
  const clear = useClearChat(model.burrowSlug);
  const settleFinished = useSettleFinishedThreads(model.burrowSlug);
  const onMenu = (row: AssistantNavRow) => {
    const entries = navMenu(row, model);
    // Nothing to offer: no menu, and the sidebar holds back the browser's (AP-4501).
    if (!entries.length) return undefined;
    return (event: MouseEvent<HTMLAnchorElement>) =>
      menu.open(
        event,
        `nav:${row.id}`,
        row.label,
        entries.map(
          (e): ContextMenuItem => ({
            label: e.label,
            ...(e.danger && { danger: true, separated: true }),
            ...(e.separated && !e.danger && { separated: true }),
            onSelect: () => {
              const room = e.id.endsWith('feedback') ? 'feedback' : 'chat';
              if (e.href) navigate(e.href);
              else if (e.id.startsWith('settle-finished')) settleFinished(room);
              else clear.ask(room);
            },
          }),
        ),
      );
  };
  return (
    <aside className={styles.side} aria-label="Sidebar" onContextMenu={noBrowserMenu}>
      <WhombatSwitcher burrowName={model.burrowName} />

      <div className={styles.lists}>
        <nav className={styles.nav} aria-label="Whombat">
          {model.nav.map((row) => (
            <AppLink
              key={row.id}
              href={row.href}
              className={cx(
                styles.navRow,
                row.selected && styles.on,
                menu.openKey === `nav:${row.id}` && styles.menuOpen,
              )}
              aria-current={row.selected ? 'page' : undefined}
              aria-label={row.ariaLabel}
              data-nav={row.id}
              onContextMenu={onMenu(row)}
              onClick={
                row.pageOpen && split
                  ? (event: MouseEvent<HTMLAnchorElement>) => {
                      // Its list is beside the open page already: nothing to open again.
                      if (!event.metaKey && !event.ctrlKey && !event.shiftKey) event.preventDefault();
                    }
                  : undefined
              }
            >
              <Icon icon={NAV_ICONS[row.id]} size={20} />
              <span className={styles.navLabel}>{row.label}</span>
              {/* The number is in the row's name already: drawn, not said again. */}
              {row.mark ? (
                <StatusMark
                  className={styles.navMark}
                  level={row.mark === 'bad' ? 'notWorking' : 'needsLook'}
                  label={null}
                />
              ) : row.badge !== null ? (
                <span
                  className={cx(
                    styles.count,
                    styles.badge,
                    row.badgeTone && variantClass(styles, 'badge', row.badgeTone),
                  )}
                  aria-hidden="true"
                >
                  {row.badge}
                </span>
              ) : row.unread !== null ? (
                <span className={styles.unread} aria-hidden="true">
                  {row.unread}
                </span>
              ) : null}
            </AppLink>
          ))}
        </nav>

        {model.chats.length > 0 && (
          <section aria-labelledby={`${ids}-chats`}>
            <div className={styles.label}>
              <h2 id={`${ids}-chats`} className={styles.labelText}>
                Conversations
              </h2>
            </div>
            {model.chats.map((c) => (
              <Link
                key={c.id}
                to="/chats/$id"
                params={{ id: c.id }}
                className={cx(styles.conv, c.selected && styles.on, c.bold && styles.bold)}
                aria-current={c.selected ? 'page' : undefined}
                title={c.title}
                data-chat={c.id}
              >
                <span className={styles.convTitle}>{c.title}</span>
                {c.unread > 0 && !c.selected ? (
                  <span className={styles.unread}>
                    {c.unread}
                    <span className={styles.srOnly}> unread</span>
                  </span>
                ) : null}
              </Link>
            ))}
          </section>
        )}
      </div>

      {model.ask && (
        <Link to="/chats/$id" params={{ id: 'new' }} className={styles.ask} data-ask-whombat="">
          <Icon icon={Plus} size={15} />
          {model.ask}
        </Link>
      )}

      <Me model={model} onSignOut={onSignOut} />
      {menu.element}
      {clear.element}
    </aside>
  );
}, sameSidebar);

/**
 * The shell builds a new model whenever the chats or Home change; the sidebar draws again only when the model says
 * something else (an unread count on the chat that is open shows nowhere).
 */
function sameSidebar(a: AssistantSidebarProps, b: AssistantSidebarProps): boolean {
  return a.onSignOut === b.onSignOut && replaceEqualDeep(a.model, b.model) === a.model;
}

/**
 * Right-clicking the sidebar shows its own menu or nothing (AP-4501): the browser's stays only in a field, where it
 * pastes and spells.
 */
function noBrowserMenu(event: MouseEvent<HTMLElement>) {
  if (!(event.target as Element).closest('input, textarea, [contenteditable="true"]')) event.preventDefault();
}

/** The account menu's words (the mock's “Account menu” section); the theme's and the update's are shared. */
const ACCOUNT_MENU_TEXT = {
  profile: 'Your profile',
  phoneApp: 'Get the phone app',
  signOut: 'Sign out',
} as const;

const THEME_ICONS: Record<ThemeChoice, LucideIcon> = { light: Sun, dark: Moon, system: Monitor };

/** Settings' shortcut as the person's keyboard writes it: “⌘ ,” on a Mac, “Ctrl ,” elsewhere. */
function settingsShortcut(): string {
  return isApplePlatform() ? '⌘ ,' : 'Ctrl ,';
}

/**
 * The person at the bottom: their face and name, a button that opens the account menu above it — their face and name
 * again as the way to their profile, the theme (Light · Dark · Auto), Settings with its shortcut, then the phone app,
 * Report a problem or idea (where the person may send one or has some) and signing out, and last the version with
 * whether an update waits. Their other settings (notifications, devices, shared links, prompts) are in Settings → You.
 */
function Me({ model, onSignOut }: { model: AssistantSidebarModel; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const { me } = model;
  // Asked with the sidebar, not when the menu opens, so the line is there at once (and nothing moves under the
  // pointer).
  const teamReports = useTeamReportsEntry(model.burrowSlug);
  // The versions are read once the pointer or the focus comes to the person's row, so opening a Whombat asks one
  // thing less and the footer is usually there when the menu opens.
  const [near, setNear] = useState(false);
  const versions = useWhombatVersions(near || open);
  const close = () => setOpen(false);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: closes the account menu on Esc from inside it
    <div
      className={styles.me}
      onKeyDown={onKeyDown}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      {open && (
        <div id={menuId} className={styles.menu} data-account-menu="">
          <Link
            to="/settings"
            search={{ part: 'profile' } as never}
            className={styles.who}
            onClick={close}
            data-account-profile=""
          >
            <PersonAvatar avatarUrl={me.avatarUrl} initials={me.initials} tone={me.tone} size={36} />
            <span className={styles.whoText}>
              <b>{me.name}</b>
              <span>{ACCOUNT_MENU_TEXT.profile}</span>
            </span>
            <Icon icon={ChevronRight} size={16} className={styles.whoChevron} />
          </Link>
          <ThemeChoices />
          <hr className={styles.menuDivider} />
          <Link
            to="/settings"
            className={styles.menuItem}
            onClick={close}
            aria-keyshortcuts="Control+, Meta+,"
            data-account-settings=""
          >
            <Icon icon={Settings2} size={16} className={styles.menuIcon} />
            {SETTINGS_HOME_TEXT.title}
            <Kbd className={styles.menuKbd} aria-hidden="true">
              {settingsShortcut()}
            </Kbd>
          </Link>
          <hr className={styles.menuDivider} />
          <Link to="/settings" search={{ tab: 'phone' } as never} className={styles.menuItem} onClick={close}>
            <Icon icon={Smartphone} size={16} className={styles.menuIcon} />
            {ACCOUNT_MENU_TEXT.phoneApp}
          </Link>
          {/* Reports to the Whombat Team: only where one can be sent or some exist. */}
          {teamReports ? (
            <Link to="/reports" className={styles.menuItem} onClick={close} data-account-reports="">
              <Icon icon={MessageSquare} size={16} className={styles.menuIcon} />
              {TEAM_REPORT_WORDS.entry}
            </Link>
          ) : null}
          <button type="button" className={styles.menuItem} onClick={onSignOut}>
            <Icon icon={LogOut} size={16} className={styles.menuIcon} />
            {ACCOUNT_MENU_TEXT.signOut}
          </button>
          <hr className={styles.menuDivider} />
          <AccountMenuVersion versions={versions} onNavigate={close} />
        </div>
      )}
      <button
        type="button"
        className={styles.user}
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account, ${me.name}`}
        title="Account"
        data-me=""
        onPointerEnter={() => setNear(true)}
        onFocus={() => setNear(true)}
        onClick={() => setOpen((v) => !v)}
      >
        <PersonAvatar avatarUrl={me.avatarUrl} initials={me.initials} tone={me.tone} size={32} />
        <span className={styles.userText}>
          <b>{me.name}</b>
        </span>
      </button>
    </div>
  );
}

/**
 * Light · Dark · Auto, the same words and order as the phone's. The menu stays open, so the change is seen; Auto
 * follows the computer's own setting. Each choice is kept on this device and in the person's account.
 */
function ThemeChoices() {
  const { choice, setChoice } = useTheme();
  return (
    <SegmentedControl
      label={THEME_WORDS.title}
      value={choice}
      onChange={setChoice}
      variant="soft"
      className={styles.theme}
      options={THEME_CHOICES.map((value) => ({
        value,
        label: (
          <>
            <Icon icon={THEME_ICONS[value]} size={14} />
            {THEME_WORDS.choices[value]}
          </>
        ),
      }))}
    />
  );
}
