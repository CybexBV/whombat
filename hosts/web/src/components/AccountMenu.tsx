// Account menu at the right end of the top bar: who is signed in, a link to
// the account settings and Sign out. Menu button pattern (arrow keys, Escape).

import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useAuthState } from '../api/queries';
import type { Role } from '../api/types';
import { useSignOut } from '../features/auth/session';
import { LANG, LANG_LABEL, nextLang, setLang, t } from '../lib/i18n';
import { getTheme, nextTheme, setTheme, THEME_LABEL } from '../lib/theme';
import { Icon } from './Icon';
import { usePopover } from './popover';

export const ROLE_LABEL: Record<Role, string> = { admin: t('Administrator'), operator: t('Operator'), viewer: t('Viewer') };

export function AccountMenu() {
  const auth = useAuthState();
  const user = auth.data?.user;
  const { signOut, pending } = useSignOut();
  const pop = usePopover();
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const [theme, setThemeState] = useState(getTheme);

  useEffect(() => {
    if (pop.open) {
      setThemeState(getTheme()); // the palette may have changed it
      menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    }
  }, [pop.open]);

  if (!user) return null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      pop.close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus();
    } else if (e.key === 'Tab') {
      pop.setOpen(false);
    }
  };

  return (
    <div className="acct" ref={pop.root} onBlur={pop.onBlur}>
      <button
        ref={pop.trigger}
        type="button"
        className="acct-btn"
        aria-label={t('Account: {name}', { name: user.name })}
        aria-haspopup="menu"
        aria-expanded={pop.open}
        aria-controls={pop.open ? id : undefined}
        onClick={() => pop.setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !pop.open) {
            e.preventDefault();
            pop.setOpen(true);
          }
        }}
      >
        <span aria-hidden="true">{user.name.slice(0, 1).toUpperCase()}</span>
      </button>
      {pop.open && (
        <div ref={menu} id={id} className="acct-menu" role="menu" aria-label={t('Account')} onKeyDown={onKey}>
          <div className="acct-who" aria-hidden="true">
            <span className="strong">{user.name}</span>
            <span className="lbl">{ROLE_LABEL[user.role] ?? user.role}</span>
          </div>
          <Link to="/settings/account" role="menuitem" tabIndex={-1} className="acct-item" onClick={() => pop.setOpen(false)}>
            <Icon name="settings" size={16} />
            {t('Account settings')}
          </Link>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="acct-item"
            onClick={() => {
              const next = nextTheme(theme);
              setTheme(next);
              setThemeState(next);
            }}
          >
            <Icon name="contrast" size={16} />
            {t('Theme: {name}', { name: THEME_LABEL[theme] })}
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="acct-item" onClick={() => setLang(nextLang(LANG))}>
            <Icon name="globe" size={16} />
            {t('Language: {name}', { name: LANG_LABEL[LANG] })}
          </button>
          <button type="button" role="menuitem" tabIndex={-1} className="acct-item" onClick={() => void signOut()} disabled={pending}>
            <Icon name="logout" size={16} />
            {t('Sign out')}
          </button>
        </div>
      )}
    </div>
  );
}
