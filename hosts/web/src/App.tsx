// Routes (SCREENS.md 0 plus the settings pages, NOTES.md) and the
// authentication gate (CONTRACT 2).

import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ApiError, setUnauthorizedHandler } from './api/client';
import { useEventStream } from './api/events';
import { qk, useAuthState } from './api/queries';
import { AppShell } from './components/AppShell';
import { ErrorCard } from './components/common';
import { AgentPage } from './features/agents/AgentPage';
import { AgentsPage } from './features/agents/AgentsPage';
import { AssistantPage } from './features/assistant/AssistantPage';
import { AlertsPage } from './features/alerts/AlertsPage';
import { ChangePasswordPage } from './features/auth/ChangePasswordPage';
import { LoginPage } from './features/auth/LoginPage';
import { ReauthDialog } from './features/auth/ReauthDialog';
import { SetupPage } from './features/auth/SetupPage';
import { FleetPage } from './features/fleet/FleetPage';
import { GuestsPage } from './features/guests/GuestsPage';
import { KioskPage } from './features/kiosk/KioskPage';
import { KioskShell } from './features/kiosk/KioskShell';
import { NotFoundPage } from './features/notfound/NotFoundPage';
import { ServerPage } from './features/server/ServerPage';
import { GuestPage } from './features/guest/GuestPage';
import { AccountPage } from './features/settings/AccountPage';
import { ChecksPage } from './features/checks/ChecksPage';
import { AuditPage } from './features/settings/AuditLog';
import { MaintenancePage } from './features/settings/MaintenancePage';
import { NotificationsPage } from './features/settings/NotificationsPage';
import { SettingsLayout } from './features/settings/SettingsLayout';
import { UsersPage } from './features/settings/UsersPage';
import { t } from './lib/i18n';

function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  const qc = useQueryClient();
  const loc = useLocation();
  const ok = !!auth.data?.authenticated;
  // A temporary password must be replaced first: the hub refuses the stream until then.
  useEventStream(ok && !auth.data?.password_change_required);

  useEffect(() => {
    setUnauthorizedHandler(() => void qc.invalidateQueries({ queryKey: qk.auth }));
    return () => setUnauthorizedHandler(null);
  }, [qc]);

  if (auth.isPending) return <div className="standalone" aria-busy="true" />;
  if (auth.isError && auth.error instanceof ApiError && auth.error.status === 401) {
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  }
  if (auth.isError) {
    return (
      <main id="main" className="standalone">
        <div style={{ width: 'min(480px, 100%)' }}>
          <ErrorCard title={t('Cannot reach the hub')} error={auth.error} onRetry={() => void auth.refetch()} />
        </div>
      </main>
    );
  }
  if (auth.data.setup_required) return <Navigate to="/setup" replace />;
  if (!ok) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  if (auth.data.kiosk) return <KioskShell />;
  if (auth.data.password_change_required) {
    return (
      <>
        <ChangePasswordPage />
        <ReauthDialog />
      </>
    );
  }
  return (
    <>
      {children}
      <ReauthDialog />
    </>
  );
}

/** Old addresses: keep the query (`?enroll=1`, `?range=`) on the new page. */
function Moved({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={to + search} replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/kiosk" element={<KioskPage />} />
      <Route
        element={
          <AuthGate>
            <AppShell />
          </AuthGate>
        }
      >
        <Route index element={<FleetPage />} />
        <Route path="servers" element={<Moved to="/" />} />
        <Route path="servers/:id" element={<ServerPage />} />
        <Route path="servers/:id/guests/:guestId" element={<GuestPage />} />
        <Route path="servers/:id/guests/:guestId/console" element={<ServerPage />} />
        <Route path="guests" element={<GuestsPage />} />
        <Route path="alerts" element={<AlertsPage />} />
        <Route path="agents" element={<Moved to="/settings/agents" />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Moved to="/settings/account" />} />
          <Route path="account" element={<AccountPage />} />
          <Route path="agents" element={<AgentsPage />} />
          <Route path="agents/:id" element={<AgentPage />} />
          <Route path="audit" element={<AuditPage />} />
          <Route path="maintenance" element={<MaintenancePage />} />
          <Route path="checks" element={<ChecksPage />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="assistant" element={<AssistantPage />} />
          <Route path="users" element={<UsersPage />} />
        </Route>
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
