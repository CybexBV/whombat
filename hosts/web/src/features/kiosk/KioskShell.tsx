// Kiosk mode (a session opened from a kiosk link): the overview for a wall
// display, read-only. No navigation, search, settings or account menu, and
// no actions (the hub refuses every change from a kiosk session anyway).
// Links on the page do nothing; the range and group controls still work.

import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { Chip } from '../../components/controls';
import { ErrorBoundary } from '../../components/ErrorBoundary';
import { Icon } from '../../components/Icon';
import { useNow } from '../../lib/clock';
import { formatTime } from '../../lib/format';
import { t } from '../../lib/i18n';
import { PRODUCT_NAME } from '../../lib/product';
import { FleetPage } from '../fleet/FleetPage';

export function KioskShell() {
  const now = useNow();
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    if (pathname !== '/') navigate({ pathname: '/', search }, { replace: true });
  }, [pathname, search, navigate]);
  return (
    <div className="app is-kiosk">
      <header className="topbar">
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="brand" size={14} />
          </span>
          <span className="brand-name">{PRODUCT_NAME}</span>
        </span>
        <div className="topbar-end">
          <Chip className="chip-sm" title={t('A kiosk link: this screen shows the overview and changes nothing.')}>
            {t('Read-only')}
          </Chip>
          <time className="kiosk-clock" dateTime={new Date(now).toISOString()}>
            {formatTime(now)}
          </time>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>
        <ErrorBoundary>
          <FleetPage />
        </ErrorBoundary>
      </main>
    </div>
  );
}
