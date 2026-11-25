import { replaceEqualDeep } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BrandMark } from '@whombat/brand/react';
import type { ThingRenameTarget, ThingRow } from '@whombat/client';
import { SETTINGS_GROUP_TEXT, TEAM_REPORT_WORDS, thingRenameTarget } from '@whombat/client';
import { useRenameThing, useTeamReportsEntry } from '@whombat/client/react';
import {
  Folder,
  Inbox,
  LayoutGrid,
  Lock,
  type LucideIcon,
  MessageCircle,
  Plus,
  Settings,
  Zap,
} from 'lucide-react';
import { type KeyboardEvent, type MouseEvent, memo, useEffect, useId, useState } from 'react';
import { cx, variantClass } from '../../components/cx';
import { Icon } from '../../components/Icon';
import { InlineRename } from '../../components/InlineRename';
import { StatusMark } from '../../components/StatusMark';
import { Tabs } from '../../components/Tabs';
import { useClearChat } from '../../features/chats/useClearChat';
import { useSettleFinishedThreads } from '../../features/chats/useSettle';
import { AppLink } from '../../features/files/AppLink';
import { PersonAvatar } from '../../features/messaging/PersonAvatar';
import { useYouParts } from '../../features/settings/useYouParts';
import { type ThingLinkProps, useThingLinkProps } from '../../features/things/prefetch';
import { THING_ICONS } from '../../features/things/thingIcons';
import { useWebPush } from '../../push/useWebPush';
import { useNavigateHref } from '../routing/navigation';
import { useTheme } from '../theme';
import { AccountMenuVersion } from './AccountMenuVersion';
import styles from './AssistantSidebar.module.css';
import {
  type AssistantNavId,
  type AssistantNavRow,
  type AssistantSidebarModel,
  navMenu,
  type SidebarList,
  type SidebarListsView,
  sidebarLists,
} from './assistantSidebarModel';
import { type ContextMenuItem, useRowMenu } from './ContextMenu';
import { useSidebarList } from './useSidebarList';
import { WhombatSwitcher } from './WhombatSwitcher';

const NAV_ICONS: Record<AssistantNavId, LucideIcon> = {
  chat: MessageCircle,
  // What needs the person: what comes in for them to decide (needs-you-list.md NYL-05).
  needsYou: Inbox,
  // Overview, at `/connections` or (before the Chat shell) `/` (sidebar-tabs.md): the servers and connections at a glance.
  dashboard: LayoutGrid,
  home: LayoutGrid,
  automations: Zap,
  files: Folder,
  vault: Lock,
  settings: Settings,
};

export interface AssistantSidebarProps {
  model: AssistantSidebarModel;
  onSignOut: () => void;
}

/**
 * The sidebar (final-shell-web.md; mock 1; one-whombat.md ONE-04): the burrow alone, with room under it (with other
 * Whombats it opens them, whombat-switcher.md AP-3080), the seven places in one order — Chat, Inbox, Overview,
 * Automations, Files, Vault, Settings (Search is ⌘K / Ctrl K) — then SERVERS and CONNECTIONS as two tabs with their
 * real logos and status marks (sidebar-tabs.md), then the person, whose row opens the account menu. Rows are links; the selected one has the
 * `sel` background, weight 600 and `aria-current="page"`; a badge's number is said once, in the row's name. The lists
 * scroll between the burrow and the person. Below 1024 px the same sidebar is the Places drawer (ShellLayout).
 * Memoized: the shell renders on every realtime event, the sidebar only when what it shows changes.
 */
export const AssistantSidebar = memo(function AssistantSidebar({ model, onSignOut }: AssistantSidebarProps) {
  const ids = useId();
  const lists = useSidebarList();
  // A service's page is read while the pointer rests on its row (page-speed.md AP-2660).
  const linkProps = useThingLinkProps(model.burrowSlug);
  // A place's right-click menu (chat-clear.md AP-4500…AP-4507); one open at a time.
  const menu = useRowMenu();
  const navigate = useNavigateHref();
  const clear = useClearChat(model.burrowSlug);
  const settleFinished = useSettleFinishedThreads(model.burrowSlug);
  const things = useThingRename(model.burrowSlug);
  // A server’s or connection’s right-click menu: Open and Rename.
  const onThingMenu = (row: ThingRow) => {
    const target = thingRenameTarget(row);
    if (!target) return undefined;
    return (event: MouseEvent<HTMLAnchorElement>) =>
      menu.open(event, `thing:${row.id}`, row.name, [
        { label: 'Open', onSelect: () => navigate(row.href) },
        { label: 'Rename', onSelect: () => things.start(row.id) },
      ]);
  };
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
            >
              <Icon icon={NAV_ICONS[row.id]} size={20} />
              <span className={styles.navLabel}>{row.label}</span>
              {/* The number is in the row's name already: drawn, not said again. */}
              {row.badge !== null ? (
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

        <ThingLists
          id={`${ids}-lists`}
          view={sidebarLists(model, lists.list)}
          onPick={lists.pick}
          linkProps={linkProps}
          onMenu={onThingMenu}
          rename={things}
          menuOpen={menu.openKey}
        />

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

/**
 * SERVERS and CONNECTIONS (sidebar-tabs.md): two tabs when both show, else the one's heading. The tab that isn't open
 * has a dot when something in it isn't fine, and those rows (and the one open now) stay in view under the open list.
 * The `+` at the end adds to the open list.
 */
function ThingLists({
  id,
  view,
  onPick,
  linkProps,
  onMenu,
  rename,
  menuOpen,
}: {
  id: string;
  view: SidebarListsView | null;
  onPick: (list: SidebarList) => void;
  linkProps: (href: string) => ThingLinkProps;
  onMenu: (row: ThingRow) => ((event: MouseEvent<HTMLAnchorElement>) => void) | undefined;
  rename: ThingRenaming;
  menuOpen: string | null;
}) {
  const link = (t: ThingRow) => (
    <ThingLink
      key={t.id}
      thing={t}
      linkProps={linkProps(t.href)}
      onMenu={onMenu(t)}
      menuOpen={menuOpen === `thing:${t.id}`}
      rename={rename}
    />
  );
  if (!view) return null;
  const panelId = `${id}-rows`;
  const tabbed = view.tabs.length > 1;
  const add = view.add && (
    <AppLink
      href={view.add.href}
      className={styles.labelAdd}
      aria-label={view.add.label}
      title={view.add.label}
      data-add={view.open === 'servers' ? 'server' : 'connection'}
    >
      <Icon icon={Plus} size={14} />
    </AppLink>
  );
  return (
    <section
      aria-labelledby={tabbed ? undefined : `${id}-head`}
      aria-label={tabbed ? 'Servers and connections' : undefined}
      data-section={view.open}
    >
      {tabbed ? (
        <div className={styles.listTabs}>
          <Tabs<SidebarList>
            label="Servers and connections"
            idPrefix={`${id}-tab`}
            panelId={panelId}
            value={view.open}
            onChange={onPick}
            className={styles.listTabList}
            tabClassName={styles.listTab}
            tabs={view.tabs.map((t) => ({
              key: t.key,
              label: (
                <>
                  {t.label}
                  {t.tone && t.key !== view.open ? ' ' : null}
                  {t.tone && t.key !== view.open ? (
                    <StatusMark
                      className={styles.tabDot}
                      level={t.tone === 'bad' ? 'notWorking' : 'needsLook'}
                      label={t.tone === 'bad' ? 'something isn’t working' : 'something needs a look'}
                    />
                  ) : null}
                </>
              ),
            }))}
          />
          {add}
        </div>
      ) : (
        <div className={styles.label}>
          <h2 id={`${id}-head`} className={styles.labelText}>
            {view.tabs[0]?.label}
          </h2>
          {add}
        </div>
      )}
      <div
        id={panelId}
        {...(tabbed ? { role: 'tabpanel', 'aria-labelledby': `${id}-tab-${view.open}` } : {})}
        data-list={view.open}
      >
        {view.rows.map(link)}
      </div>
      {view.carried.length > 0 && (
        <section
          className={styles.carried}
          aria-label={`Also in ${view.tabs.find((t) => t.key !== view.open)?.label ?? ''}`}
          data-carried=""
        >
          {view.carried.map(link)}
        </section>
      )}
    </section>
  );
}

/**
 * A server, connection or device: its icon, its name in the sans face (AP-2604), and its status mark by shape only when
 * it isn't connected (not working, needs a look, learning; ui-refresh-status.md), the reason in its tooltip and name. A connection's or
 * device's page is read while the pointer rests on it (page-speed.md AP-2660).
 */
function ThingLink({
  thing: t,
  linkProps,
  onMenu,
  menuOpen,
  rename,
}: {
  thing: ThingRow;
  linkProps: ThingLinkProps;
  onMenu?: (event: MouseEvent<HTMLAnchorElement>) => void;
  menuOpen: boolean;
  rename: ThingRenaming;
}) {
  const icon = t.mark ? (
    <span className={styles.thingIcon}>
      <BrandMark mark={t.mark} size={15} />
    </span>
  ) : (
    <Icon icon={THING_ICONS[t.glyph]} size={15} className={styles.thingIcon} />
  );
  const target = onMenu ? thingRenameTarget(t) : null;
  if (target && rename.editing === t.id)
    return (
      <div className={cx(styles.thing, styles.renaming, t.selected && styles.on)} data-thing={t.id}>
        {icon}
        <InlineRename
          value={target.name}
          maxLength={target.max}
          label={`Rename ${t.name}`}
          hint={target.kind === 'server' ? 'Leave it empty to use its id again.' : undefined}
          onSave={(typed) => rename.save(target, typed)}
          onClose={rename.stop}
        />
      </div>
    );
  const shown = rename.shown(t);
  return (
    <AppLink
      href={t.href}
      {...linkProps}
      className={cx(styles.thing, t.selected && styles.on, menuOpen && styles.menuOpen)}
      aria-current={t.selected ? 'page' : undefined}
      // Its name and, when it isn't connected, why: “blackbox: disk array failed”.
      aria-label={shown === null ? (t.markLabel ?? t.name) : shown}
      title={shown === null ? t.tip : shown}
      data-thing={t.id}
      onContextMenu={onMenu}
      // F2 renames the row in focus, as in a file list.
      onKeyDown={
        target
          ? (event: KeyboardEvent<HTMLAnchorElement>) => {
              if (event.key === 'F2') {
                event.preventDefault();
                rename.start(t.id);
              }
            }
          : undefined
      }
    >
      {icon}
      <span className={styles.thingName}>
        {shown ?? t.main}
        {shown === null && t.note ? <span className={styles.thingNote}> {t.note}</span> : null}
      </span>
      <StatusMark level={t.level} label={t.markLabel} />
    </AppLink>
  );
}

/** Which row is being renamed, and the names just saved until the list says them too. */
interface ThingRenaming {
  editing: string | null;
  start: (thingId: string) => void;
  stop: () => void;
  save: (target: ThingRenameTarget, typed: string) => Promise<string | null>;
  /** The name a row shows while the list catches up with a rename, or null. */
  shown: (row: ThingRow) => string | null;
}

function useThingRename(burrow: string): ThingRenaming {
  const { rename } = useRenameThing(burrow);
  const [editing, setEditing] = useState<string | null>(null);
  // The name saved per row, with the name the list said then: it shows until the list says something else.
  const [saved, setSaved] = useState<ReadonlyMap<string, { name: string; was: string }>>(new Map());
  useEffect(() => {
    if (!saved.size) return;
    const timer = setTimeout(() => setSaved(new Map()), 10_000);
    return () => clearTimeout(timer);
  }, [saved]);
  return {
    editing,
    start: setEditing,
    stop: () => setEditing(null),
    save: async (target, typed) => {
      const thingId = `${target.kind}:${target.id}`;
      const outcome = await rename(target, typed);
      if (!outcome.ok) return outcome.problem;
      if (outcome.changed) {
        const name = typed.trim().replace(/\s+/g, ' ') || target.id;
        setSaved((m) => new Map(m).set(thingId, { name, was: target.name }));
      }
      return null;
    },
    shown: (row) => {
      const s = saved.get(row.id);
      return s && row.name === s.was ? s.name : null;
    },
  };
}

/**
 * The person at the bottom: their face and name, a button that opens the account menu above it — their own settings
 * (Profile, Notifications, and on a box Devices and Shared links), then the app on a phone, notifications in this
 * browser, the theme, Report a problem or idea (where the person may send one or has some), signing out and the
 * version.
 */
function Me({ model, onSignOut }: { model: AssistantSidebarModel; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const push = useWebPush();
  const { theme, toggleTheme } = useTheme();
  const { me } = model;
  const you = useYouParts(model.burrowSlug);
  // Asked with the sidebar, not when the menu opens, so the line is there at once (and nothing moves under the pointer).
  const teamReports = useTeamReportsEntry(model.burrowSlug);
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
        <div id={menuId} className={styles.menu}>
          {you.map((part) => (
            <Link
              key={part}
              to="/settings"
              search={{ part } as never}
              className={styles.menuItem}
              onClick={close}
              data-account-part={part}
            >
              {SETTINGS_GROUP_TEXT.you[part]}
            </Link>
          ))}
          <hr className={styles.menuDivider} />
          <Link to="/settings" search={{ tab: 'phone' } as never} className={styles.menuItem} onClick={close}>
            Phone app
          </Link>
          {push.status !== 'unsupported' && (
            <button
              type="button"
              className={styles.menuItem}
              disabled={push.status === 'busy'}
              onClick={() => void (push.status === 'on' ? push.disable() : push.enable())}
            >
              {push.status === 'on' ? 'Turn off notifications' : 'Turn on notifications'}
            </button>
          )}
          {/* The theme, from the sidebar's head (AP-2605): the action, never the state. */}
          <button type="button" className={styles.menuItem} onClick={toggleTheme}>
            {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          </button>
          {/* Reports to the Whombat Team (Whombat team-reports.md TR-01): only where one can be sent or some exist. */}
          {teamReports ? (
            <Link to="/reports" className={styles.menuItem} onClick={close} data-account-reports="">
              {TEAM_REPORT_WORDS.entry}
            </Link>
          ) : null}
          <button type="button" className={styles.menuItem} onClick={onSignOut}>
            Sign out
          </button>
          <AccountMenuVersion onNavigate={close} />
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
