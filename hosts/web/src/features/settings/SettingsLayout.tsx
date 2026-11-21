// Settings (/settings/*): a side menu (Account for everyone; Agents,
// Notifications, Assistant, Users and the Audit log for admins) beside the
// page. Non-admins only have Account, so they get no menu. Below ~800 px the
// menu becomes a row above the page.

import type { ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router';
import { useAuthState, usePendingEnrollments } from '../../api/queries';
import { t, tn } from '../../lib/i18n';

function itemClass({ isActive }: { isActive: boolean }): string {
  return isActive ? 'settings-nav-item on' : 'settings-nav-item';
}

export function SettingsLayout() {
  const auth = useAuthState();
  const role = auth.data?.user?.role;
  const isAdmin = role === 'admin';
  const isOperator = role === 'operator';
  const pending = usePendingEnrollments(isAdmin, false);
  const count = isAdmin ? (pending.data?.length ?? 0) : 0;
  if (!isAdmin && !isOperator) {
    return (
      <div className="settings-main">
        <Outlet />
      </div>
    );
  }
  return (
    <div className="settings-layout">
      <nav className="settings-nav" aria-label={t('Settings')}>
        <div className="settings-nav-group" role="group" aria-labelledby="settings-nav-personal">
          <span className="settings-nav-h lbl" id="settings-nav-personal">
            {t('Personal')}
          </span>
          <NavLink to="/settings/account" className={itemClass}>
            {t('Account')}
          </NavLink>
        </div>
        <div className="settings-nav-group" role="group" aria-labelledby="settings-nav-ops">
          <span className="settings-nav-h lbl" id="settings-nav-ops">
            {t('Operations')}
          </span>
          <NavLink to="/settings/maintenance" className={itemClass}>
            {t('Maintenance')}
          </NavLink>
          <NavLink to="/settings/checks" className={itemClass}>
            {t('Checks')}
          </NavLink>
        </div>
        {isAdmin && (
          <div className="settings-nav-group" role="group" aria-labelledby="settings-nav-admin">
            <span className="settings-nav-h lbl" id="settings-nav-admin">
              {t('Administration')}
            </span>
            <NavLink to="/settings/agents" className={itemClass} aria-label={count ? tn(count, 'Agents, {n} agent waiting for approval', 'Agents, {n} agents waiting for approval') : undefined}>
              {t('Agents')}
              {count > 0 && (
                <span className="tb-count" aria-hidden="true">
                  {count}
                </span>
              )}
            </NavLink>
            <NavLink to="/settings/notifications" className={itemClass}>
              {t('Notifications')}
            </NavLink>
            <NavLink to="/settings/assistant" className={itemClass}>
              {t('Assistant')}
            </NavLink>
            <NavLink to="/settings/users" className={itemClass}>
              {t('Users')}
            </NavLink>
            <NavLink to="/settings/audit" className={itemClass}>
              {t('Audit log')}
            </NavLink>
          </div>
        )}
      </nav>
      <div className="settings-main">
        <Outlet />
      </div>
    </div>
  );
}

/** Admin pages: a short explanation for other roles (the hub enforces it anyway). */
export function RequireAdmin({ title, text, children }: { title: string; text: string; children: ReactNode }) {
  const auth = useAuthState();
  if (auth.data?.user?.role === 'admin') return <>{children}</>;
  return (
    <>
      <header className="page-head">
        <h1 className="page-title">{title}</h1>
      </header>
      {auth.data && (
        <div className="card placeholder-card">
          <h2 className="h2">{t('Requires admin access')}</h2>
          <p className="ink-2">{text}</p>
        </div>
      )}
    </>
  );
}
