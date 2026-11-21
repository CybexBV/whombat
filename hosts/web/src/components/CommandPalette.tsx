// Command palette (⌘K / Ctrl+K, or the search button in the top bar): pages,
// hosts, guests on any host (GET /guests?q=) and actions. Combobox + listbox:
// focus stays in the input, arrows move the active option, Enter opens it
// (a running guest with a console opens its console; Shift+Enter shows it in
// its host's guest list), Escape clears the query, then closes.

import { type KeyboardEvent, type MouseEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAssistantEnabled } from '../api/assist';
import { useAuthState, useGuestSearch, useServers } from '../api/queries';
import type { FleetGuest, ServerListItem } from '../api/types';
import { useOpenEnroll } from '../features/agents/enrollLink';
import { askAssistant } from '../features/assistant/open';
import { formatPct1 } from '../lib/format';
import { t, tn } from '../lib/i18n';
import { STATUS_DOT } from '../lib/thresholds';
import { consolePath, guestListPath, guestsPagePath, hostPath, useRange } from '../lib/urlState';
import { Dot } from './controls';
import { serverStatusText } from './HostPills';
import { Icon, type IconName } from './Icon';
import { useDebounced } from './popover';
import { getTheme, nextTheme, setTheme, THEME_LABEL } from '../lib/theme';
import { guestStateInfo } from '../features/guests/guestActions';

const MIN_GUEST_QUERY = 2;
const MAX_HOSTS = 8;

const PAGES: { key: string; label: string; to: string; icon: IconName; words: string }[] = [
  { key: 'overview', label: t('Overview'), to: '/', icon: 'overview', words: t('overview fleet home dashboard') },
  { key: 'guests', label: t('Guests'), to: '/guests', icon: 'box', words: t('guests vms containers workloads') },
  { key: 'alerts', label: t('Alerts'), to: '/alerts', icon: 'bell', words: t('alerts warnings') },
  { key: 'settings', label: t('Settings'), to: '/settings', icon: 'settings', words: t('settings account agents audit passkeys') },
];

/** Settings pages: listed once something is typed (the empty palette stays short). */
const SETTINGS_PAGES: { key: string; label: string; to: string; icon: IconName; words: string; admin?: boolean }[] = [
  { key: 'account', label: t('Settings › Account'), to: '/settings/account', icon: 'settings', words: t('account password passkeys tokens api kiosk') },
  { key: 'agents', label: t('Settings › Agents'), to: '/settings/agents', icon: 'agents', words: t('agents enroll update remote control'), admin: true },
  { key: 'checks', label: t('Settings › Checks'), to: '/settings/checks', icon: 'check', words: t('checks uptime http tcp ping dns heartbeat cron') },
  { key: 'notifications', label: t('Settings › Notifications'), to: '/settings/notifications', icon: 'bell', words: t('notifications channels ntfy webhook discord email'), admin: true },
  { key: 'assistant', label: t('Settings › Assistant'), to: '/settings/assistant', icon: 'sparkle', words: t('assistant ai claude codex investigations'), admin: true },
  { key: 'maintenance', label: t('Settings › Maintenance'), to: '/settings/maintenance', icon: 'clock', words: t('maintenance mute window silence') },
  { key: 'users', label: t('Settings › Users'), to: '/settings/users', icon: 'agents', words: t('users accounts roles sso oidc'), admin: true },
  { key: 'audit', label: t('Settings › Audit log'), to: '/settings/audit', icon: 'shield', words: t('audit log history who'), admin: true },
];

const PLATFORM_LABEL: Record<string, [vm: string, container: string]> = {
  docker: ['Docker', 'Docker'],
  incus: ['Incus VM', 'Incus container'],
  libvirt: ['libvirt VM', 'libvirt VM'],
  pve: ['QEMU VM', 'LXC'],
};

const STATE_WORD: Record<string, string> = { running: t('running'), stopped: t('stopped'), paused: t('paused'), unhealthy: t('unhealthy') };

/** "LXC 131 · pve-02 · running · 1.3% CPU" */
export function guestLine(g: FleetGuest): string {
  const kind = PLATFORM_LABEL[g.platform]?.[g.kind === 'vm' ? 0 : 1] ?? g.platform;
  const id = g.platform === 'pve' && g.vmid != null ? ` ${g.vmid}` : '';
  const parts = [`${kind}${id}`, g.server, STATE_WORD[g.state] ?? g.state];
  if (g.state !== 'stopped' && g.cpu_pct != null) parts.push(`${formatPct1(g.cpu_pct)} CPU`);
  if (!g.server_online) parts.push(t('host offline'));
  return parts.join(' · ');
}

/** Whether Enter opens the console of this guest (running, console available, host online). */
export function opensConsole(g: FleetGuest): boolean {
  return g.state !== 'stopped' && g.console.available !== false && (g.console.protocols?.length ?? 0) > 0 && g.server_online !== false;
}

type Option =
  | { key: string; kind: 'page'; page: (typeof PAGES)[number] }
  | { key: string; kind: 'host'; host: ServerListItem }
  | { key: string; kind: 'guest'; guest: FleetGuest }
  | { key: string; kind: 'action'; label: string; icon: IconName; run: () => void };

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  if (!open) return null;
  return <PalettePanel onClose={onClose} />;
}

function PalettePanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const servers = useServers();
  const auth = useAuthState();
  const isAdmin = auth.data?.user?.role === 'admin';
  const assistant = useAssistantEnabled();
  const [range] = useRange();
  const openEnroll = useOpenEnroll();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const term = useDebounced(query.trim(), 120);
  const guests = useGuestSearch(term.length >= MIN_GUEST_QUERY ? term : '');
  const q = query.trim().toLowerCase();

  useEffect(() => input.current?.focus(), []);

  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    for (const p of PAGES) if (!q || p.label.toLowerCase().includes(q) || p.words.includes(q)) out.push({ key: `p:${p.key}`, kind: 'page', page: p });
    if (q) {
      for (const p of SETTINGS_PAGES) {
        if ((!p.admin || isAdmin) && (p.label.toLowerCase().includes(q) || p.words.includes(q))) out.push({ key: `p:${p.key}`, kind: 'page', page: p });
      }
    }
    const hosts = (servers.data ?? []).filter((s) => !q || s.id.toLowerCase().includes(q) || s.group.toLowerCase().includes(q));
    for (const s of hosts.slice(0, MAX_HOSTS)) out.push({ key: `h:${s.id}`, kind: 'host', host: s });
    if (q.length >= MIN_GUEST_QUERY && term === query.trim()) for (const g of guests.data?.guests ?? []) out.push({ key: `g:${g.server}/${g.id}`, kind: 'guest', guest: g });
    if (isAdmin && (!q || t('enroll a server add host install agent').includes(q))) {
      out.push({ key: 'a:enroll', kind: 'action', label: t('Enroll a server'), icon: 'plus', run: () => openEnroll() });
    }
    if (assistant && (!q || t('ask the assistant ai investigate claude codex question').includes(q))) {
      out.push({ key: 'a:ask', kind: 'action', label: t('Ask the assistant…'), icon: 'sparkle', run: () => askAssistant({ server: null }) });
    }
    if (q.length >= 2 && t('theme dark light mode appearance').includes(q)) {
      const next = nextTheme(getTheme());
      out.push({ key: 'a:theme', kind: 'action', label: t('Theme: {name}', { name: THEME_LABEL[next] }), icon: 'contrast', run: () => setTheme(next) });
    }
    if (q.length >= MIN_GUEST_QUERY) {
      out.push({ key: 'a:guests', kind: 'action', label: t('Search guests for “{query}”', { query: query.trim() }), icon: 'search', run: () => navigate(guestsPagePath({ q: query.trim() })) });
    }
    return out;
  }, [q, query, term, servers.data, guests.data, isAdmin, assistant, openEnroll, navigate]);

  const activeIdx = Math.min(active, Math.max(0, options.length - 1));
  const optId = (i: number) => `${id}-o${i}`;

  useEffect(() => {
    document.getElementById(optId(activeIdx))?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  const choose = (o: Option, alt = false) => {
    onClose();
    switch (o.kind) {
      case 'page':
        navigate(o.page.to);
        break;
      case 'host':
        navigate(hostPath(o.host.id, { range }));
        break;
      case 'guest': {
        const g = o.guest;
        if (!alt && opensConsole(g)) navigate(consolePath(g.server, g.id, { range }));
        else navigate(guestListPath(g.server, g.platform, g.kind, g.name, range));
        break;
      }
      case 'action':
        o.run();
        break;
    }
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((activeIdx + d + options.length) % options.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const o = options[activeIdx];
      if (o) choose(o, e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (query) {
        setQuery('');
        setActive(0);
      } else onClose();
    } else if (e.key === 'Tab') {
      // The input is the only tab stop of the dialog.
      e.preventDefault();
    }
  };

  const searching = q.length >= MIN_GUEST_QUERY;
  // Guest results for the typed text (the debounced term may lag one keystroke; results for it still show).
  const guestData = searching && term === query.trim() ? guests.data : undefined;
  const pending = searching && !guestData && !guests.isError;
  const extra = guestData && guestData.total > guestData.guests.length ? guestData.total - guestData.guests.length : 0;
  let note = '';
  if (servers.isPending) note = t('Loading hosts…');
  else if (servers.isError) note = t('Could not load the hosts.');
  else if (searching && guests.isError) note = t('Could not search the guests.');
  else if (pending) note = t('Searching guests…');
  else if (!options.length) note = t('Nothing matches “{query}”.', { query: query.trim() });
  else if (guestData && guestData.guests.length === 0) note = t('No guests match “{query}”.', { query: query.trim() });
  else if (extra > 0) note = tn(extra, '{n} more guest matches: type more of the name, or search the Guests page.', '{n} more guests match: type more of the name, or search the Guests page.');

  const groupsOf = (kind: Option['kind']) => options.map((o, i) => ({ o, i })).filter((x) => x.o.kind === kind);
  const groups: { label: string; items: { o: Option; i: number }[] }[] = [
    { label: t('Pages'), items: groupsOf('page') },
    { label: t('Hosts'), items: groupsOf('host') },
    { label: t('Guests'), items: groupsOf('guest') },
    { label: t('Actions'), items: groupsOf('action') },
  ].filter((g) => g.items.length);

  const render = ({ o, i }: { o: Option; i: number }) => {
    const props = {
      id: optId(i),
      role: 'option',
      'aria-selected': i === activeIdx,
      className: i === activeIdx ? 'palette-opt is-active' : 'palette-opt',
      onMouseDown: (e: MouseEvent) => e.preventDefault(),
      onMouseMove: () => i !== activeIdx && setActive(i),
      onClick: (e: MouseEvent) => choose(o, e.shiftKey),
    };
    switch (o.kind) {
      case 'page':
        return (
          <div key={o.key} {...props}>
            <Icon name={o.page.icon} size={15} />
            <span className="n">{o.page.label}</span>
            <span className="k">{t('Page')}</span>
          </div>
        );
      case 'host':
        return (
          <div key={o.key} {...props}>
            <Dot color={STATUS_DOT[o.host.status]} />
            <span className="n mono">
              {o.host.id}
              <small>{serverStatusText(o.host)}</small>
            </span>
            <span className="k">{t('Host')}</span>
          </div>
        );
      case 'guest': {
        const g = o.guest;
        const con = opensConsole(g);
        return (
          <div key={o.key} {...props}>
            <Dot color={guestStateInfo(g.state).color} />
            <span className="n mono">
              {g.name}
              <small>{guestLine(g)}</small>
            </span>
            <span className="k">{con ? (g.kind === 'vm' ? t('Open console ↵') : t('Open shell ↵')) : t('Show ↵')}</span>
          </div>
        );
      }
      case 'action':
        return (
          <div key={o.key} {...props}>
            <Icon name={o.icon} size={15} />
            <span className="n">{o.label}</span>
            <span className="k">{t('Action')}</span>
          </div>
        );
    }
  };

  return (
    <div
      className="palette-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-label={t('Search')}>
        <div className="palette-in">
          <Icon name="search" size={16} />
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-label={t('Search hosts, guests, pages and actions')}
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={options.length ? optId(activeIdx) : undefined}
            placeholder={t('Search hosts, guests, pages and actions…')}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKey}
          />
          <kbd className="kbd" aria-hidden="true">
            esc
          </kbd>
        </div>
        <div id={`${id}-list`} className="palette-list" role="listbox" aria-label={t('Results')}>
          {groups.map((g) => (
            <div key={g.label} role="group" aria-label={g.label}>
              <div className="palette-grp" aria-hidden="true">
                {g.label}
              </div>
              {g.items.map(render)}
            </div>
          ))}
        </div>
        <div className="palette-note" role="status" aria-live="polite">
          {note}
        </div>
        <div className="palette-foot" aria-hidden="true">
          <span>
            <span className="kbd">↑</span>
            <span className="kbd">↓</span> {t('move')}
          </span>
          <span>
            <span className="kbd">↵</span> {t('open')}
          </span>
          <span>
            <span className="kbd">⇧↵</span> {t('show in list')}
          </span>
          <span>
            <span className="kbd">esc</span> {t('close')}
          </span>
        </div>
      </div>
    </div>
  );
}
