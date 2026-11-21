// App shell (UI v2): a sticky top bar (brand; Overview, one pill per host,
// Guests, Alerts; search that opens the command palette, Settings with a
// dot while agents wait for approval, the account menu) above the main
// column. Below 760 px the bar keeps brand, search and account; a bottom tab
// bar carries Overview, Hosts (a sheet), Guests, Alerts and Menu.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useSearchParams } from 'react-router';
import { useAlerts, useAuthState, usePendingEnrollments, useServers } from '../api/queries';
import { needsAttention } from '../api/types';
import { EnrollModal } from '../features/agents/EnrollModal';
import { AskDialogHost } from '../features/assistant/AskDialog';
import { InvestigationHost } from '../features/assistant/InvestigationPanel';
import { ENROLL_NAME_PARAM, ENROLL_PARAM, useCloseEnroll } from '../features/agents/enrollLink';
import { useSignOut } from '../features/auth/session';
import { useTaskEvents } from '../features/guest/taskEvents';
import { TaskDialogHost } from '../features/guest/TaskDialog';
import { announce, useAnnouncement } from '../lib/announce';
import { useNow } from '../lib/clock';
import { formatClock } from '../lib/format';
import { t, tn } from '../lib/i18n';
import { STALE_AFTER_MS, useLiveStatus } from '../lib/liveStatus';
import { PRODUCT_NAME } from '../lib/product';
import { STATUS_DOT } from '../lib/thresholds';
import { hostPath, useRange } from '../lib/urlState';
import { useReturnFocus } from '../lib/useReturnFocus';
import { setAttentionBadge } from '../lib/useTitle';
import { useAlertNotifications } from '../lib/browserNotify';
import { AccountMenu, ROLE_LABEL } from './AccountMenu';
import { CommandPalette } from './CommandPalette';
import { Dot } from './controls';
import { ErrorBoundary } from './ErrorBoundary';
import { groupHosts, HostPills, serverStatusText, useCurrentHost } from './HostPills';
import { Icon } from './Icon';
import { Toaster } from './Toast';

function itemClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'tb-item on' : 'tb-item';
}

function AlertBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="tb-badge" aria-label={tn(count, '{n} alert needs attention', '{n} alerts need attention')}>
      {count}
    </span>
  );
}

/** Pending enrollments, admins only (0 otherwise). */
function usePendingCount(): number {
  const auth = useAuthState();
  const admin = auth.data?.user?.role === 'admin';
  const pending = usePendingEnrollments(admin, false);
  return admin ? (pending.data?.length ?? 0) : 0;
}

function settingsLabel(pending: number): string {
  return pending ? tn(pending, 'Settings, {n} agent waiting for approval', 'Settings, {n} agents waiting for approval') : t('Settings');
}

/** Open alerts that ask for attention (not acknowledged, muted or suppressed). */
/** Apple keyboards show ⌘, others Ctrl. */
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function useAttentionCount(): number {
  const alerts = useAlerts();
  return (alerts.data ?? []).filter(needsAttention).length;
}

/** Keeps the title and favicon badge in step with the attention count. */
function useAttentionBadge(): void {
  const n = useAttentionCount();
  useEffect(() => setAttentionBadge(n), [n]);
}

function TopBar({ onSearch }: { onSearch: () => void }) {
  const alertCount = useAttentionCount();
  const pending = usePendingCount();
  return (
    <header className="topbar">
      <Link to="/" className="brand" aria-label={PRODUCT_NAME}>
        <span className="brand-mark" aria-hidden="true">
          <Icon name="brand" size={14} />
        </span>
        <span className="brand-name">{PRODUCT_NAME}</span>
      </Link>
      <nav className="topnav tb-desk" aria-label={t('Primary')}>
        <NavLink to="/" end className={itemClass}>
          {t('Overview')}
        </NavLink>
        <span className="tb-sep" aria-hidden="true" />
        <HostPills />
        <span className="tb-sep" aria-hidden="true" />
        <NavLink to="/guests" className={itemClass}>
          {t('Guests')}
        </NavLink>
        <NavLink to="/alerts" className={itemClass}>
          {t('Alerts')} <AlertBadge count={alertCount} />
        </NavLink>
      </nav>
      <div className="topbar-end">
        <button type="button" className="tb-search" onClick={onSearch} aria-label={t('Search hosts, guests, pages and actions (Ctrl+K)')} aria-keyshortcuts="Control+K Meta+K">
          <Icon name="search" size={15} />
          <span>{t('Search hosts, guests, actions')}</span>
          <kbd aria-hidden="true">{IS_MAC ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        <NavLink to="/settings" className={({ isActive }) => (isActive ? 'tb-icon tb-desk on' : 'tb-icon tb-desk')} aria-label={settingsLabel(pending)} title={t('Settings')}>
          <Icon name="settings" size={17} />
          {pending > 0 && <span className="tb-pip" aria-hidden="true" />}
        </NavLink>
        <AccountMenu />
      </div>
    </header>
  );
}

/** Phone: the hosts sheet opened from the bottom bar. */
function HostsSheet({ onClose }: { onClose: () => void }) {
  const servers = useServers();
  const current = useCurrentHost();
  const [range] = useRange();
  const groups = groupHosts(servers.data ?? []);
  const first = useRef<HTMLAnchorElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <>
      <div className="sheet-backdrop" onMouseDown={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-label={t('Hosts')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        {groups.map((g, gi) => (
          <div key={g.name} role="group" aria-label={g.name}>
            {groups.length > 1 && (
              <div className="grp" aria-hidden="true">
                {g.name}
              </div>
            )}
            {g.items.map((s, i) => (
              <Link
                key={s.id}
                ref={gi === 0 && i === 0 ? first : undefined}
                to={hostPath(s.id, { range })}
                className={s.id === current ? 'opt on' : 'opt'}
                aria-current={s.id === current ? 'page' : undefined}
                onClick={onClose}
              >
                <Dot color={STATUS_DOT[s.status]} />
                <span className="mono">{s.id}</span>
                <span className="st">{serverStatusText(s)}</span>
              </Link>
            ))}
          </div>
        ))}
        {!servers.data?.length && <div className="palette-note">{servers.isPending ? t('Loading hosts…') : t('No hosts yet.')}</div>}
      </div>
    </>
  );
}

/** Phone: Settings and Sign out. */
function MenuSheet({ onClose, pending }: { onClose: () => void; pending: number }) {
  const auth = useAuthState();
  const user = auth.data?.user;
  const { signOut, pending: signingOut } = useSignOut();
  const first = useRef<HTMLAnchorElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <>
      <div className="sheet-backdrop" onMouseDown={onClose} />
      <div
        className="sheet"
        role="dialog"
        aria-label={t('Menu')}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <Link ref={first} to="/settings" className="opt" onClick={onClose} aria-label={settingsLabel(pending)}>
          <Icon name="settings" size={16} />
          {t('Settings')}
          {pending > 0 && (
            <span className="tb-count" aria-hidden="true">
              {pending}
            </span>
          )}
        </Link>
        {user && (
          <>
            <hr />
            <button type="button" className="opt" onClick={() => void signOut()} disabled={signingOut}>
              <Icon name="logout" size={16} />
              {t('Sign out')}
              <span className="st mono">
                {user.name} · {ROLE_LABEL[user.role] ?? user.role}
              </span>
            </button>
          </>
        )}
      </div>
    </>
  );
}

function BottomBar() {
  const alertCount = useAttentionCount();
  const pending = usePendingCount();
  const current = useCurrentHost();
  const [sheet, setSheet] = useState<'hosts' | 'menu' | null>(null);
  const { pathname } = useLocation();
  useEffect(() => setSheet(null), [pathname]);
  useReturnFocus(sheet !== null);
  const cls = ({ isActive }: { isActive: boolean }) => (isActive ? 'bb-item on' : 'bb-item');
  return (
    <>
      <nav className="bottombar" aria-label={t('Primary')}>
        <NavLink to="/" end className={cls}>
          <Icon name="overview" size={20} />
          {t('Overview')}
        </NavLink>
        <button type="button" className={current ? 'bb-item on' : 'bb-item'} aria-haspopup="dialog" aria-expanded={sheet === 'hosts'} onClick={() => setSheet((s) => (s === 'hosts' ? null : 'hosts'))}>
          <Icon name="servers" size={20} />
          {t('Hosts')}
        </button>
        <NavLink to="/guests" className={cls}>
          <Icon name="box" size={20} />
          {t('Guests')}
        </NavLink>
        <NavLink to="/alerts" className={cls}>
          <Icon name="bell" size={20} />
          {t('Alerts')}
          <AlertBadge count={alertCount} />
        </NavLink>
        <button type="button" className="bb-item" aria-haspopup="dialog" aria-expanded={sheet === 'menu'} aria-label={pending ? tn(pending, 'Menu, {n} agent waiting for approval', 'Menu, {n} agents waiting for approval') : t('Menu')} onClick={() => setSheet((s) => (s === 'menu' ? null : 'menu'))}>
          <Icon name="dots" size={20} />
          {t('Menu')}
          {pending > 0 && <span className="tb-pip" aria-hidden="true" style={{ top: 6, right: 'calc(50% - 14px)' }} />}
        </button>
      </nav>
      {sheet === 'hosts' && <HostsSheet onClose={() => setSheet(null)} />}
      {sheet === 'menu' && <MenuSheet onClose={() => setSheet(null)} pending={pending} />}
    </>
  );
}

/** Polite announcements when a server changes status or an alert opens (never the 10 s refresh). */
function useStatusAnnouncements() {
  const servers = useServers();
  const alerts = useAlerts();
  const prevStatus = useRef<Map<string, string> | null>(null);
  const prevAlerts = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!servers.data) return;
    const next = new Map(servers.data.map((s) => [s.id, s.status]));
    const prev = prevStatus.current;
    if (prev) {
      for (const [id, st] of next) {
        const was = prev.get(id);
        if (was && was !== st) {
          announce(st === 'offline' ? t('{id} is offline: agent unreachable', { id }) : st === 'warning' ? t('{id} has a warning', { id }) : t('{id} is online', { id }));
        }
      }
    }
    prevStatus.current = next;
  }, [servers.data]);

  useEffect(() => {
    if (!alerts.data) return;
    const ids = new Set(alerts.data.map((a) => a.id));
    const prev = prevAlerts.current;
    if (prev) {
      for (const a of alerts.data) {
        if (!prev.has(a.id)) announce(a.severity === 'critical' ? t('New critical alert on {server}: {title}', { server: a.server, title: a.title }) : t('New warning alert on {server}: {title}', { server: a.server, title: a.title }));
      }
    }
    prevAlerts.current = ids;
  }, [alerts.data]);
}

/** The enrollment dialog, open on any page while `?enroll=1` is in the URL. */
function EnrollDialogHost() {
  const [params] = useSearchParams();
  const close = useCloseEnroll();
  const open = params.get(ENROLL_PARAM) === '1';
  useReturnFocus(open);
  if (!open) return null;
  return <EnrollModal initialName={params.get(ENROLL_NAME_PARAM)} onClose={close} />;
}

function LiveRegion() {
  const msg = useAnnouncement();
  return (
    <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
      {msg}
    </div>
  );
}

/** /servers/:id and its console routes are one page (tabs, range and the console do not change it). */
function pageKeyOf(pathname: string): string {
  return pathname.startsWith('/servers/') ? pathname.split('/').slice(0, 3).join('/') : pathname;
}

/** Scroll to the top when another page opens. */
function useScrollTopOnPageChange() {
  const { pathname } = useLocation();
  const page = pageKeyOf(pathname);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    window.scrollTo(0, 0);
  }, [page]);
}

/** ⌘K / Ctrl+K opens the palette from anywhere (not while typing in a console: its screen captures keys). */
function usePaletteShortcut(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        const el = e.target as HTMLElement | null;
        if (el?.closest('.con-screen')) return;
        e.preventDefault();
        open();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

/** A quiet line under the top bar while live data is not arriving (hub unreachable, browser offline). */
function StaleNotice() {
  const live = useLiveStatus();
  const now = useNow();
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  const stale = !online || (live.downSince !== null && now - live.downSince >= STALE_AFTER_MS);
  if (!stale) return null;
  const since = live.downSince ?? now;
  return (
    <div className="stale-notice" role="status">
      <Dot color="var(--warning)" />
      {online
        ? t('Reconnecting to the hub · the values shown are from {time} and may be out of date.', { time: formatClock(since, now) })
        : t('You are offline · the values shown are from {time} and may be out of date.', { time: formatClock(since, now) })}
    </div>
  );
}

export function AppShell() {
  useStatusAnnouncements();
  useAttentionBadge();
  useAlertNotifications();
  useTaskEvents();
  useScrollTopOnPageChange();
  const { pathname } = useLocation();
  const pageKey = pageKeyOf(pathname);
  const [palette, setPalette] = useState(false);
  const openPalette = useCallback(() => setPalette(true), []);
  const closePalette = useCallback(() => setPalette(false), []);
  usePaletteShortcut(openPalette);
  useReturnFocus(palette);
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {t('Skip to content')}
      </a>
      <TopBar onSearch={openPalette} />
      <StaleNotice />
      <main id="main" className="main" tabIndex={-1}>
        {/* A crash in one page leaves the shell usable; navigating away resets it. */}
        <ErrorBoundary key={pageKey}>
          <Outlet />
        </ErrorBoundary>
      </main>
      <BottomBar />
      <InvestigationHost />
      <CommandPalette open={palette} onClose={closePalette} />
      <EnrollDialogHost />
      <TaskDialogHost />
      <AskDialogHost />
      <LiveRegion />
      <Toaster />
    </div>
  );
}
