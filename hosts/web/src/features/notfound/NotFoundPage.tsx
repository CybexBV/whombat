// Not-found page for unknown addresses inside the app.

import { Link } from 'react-router';
import { t } from '../../lib/i18n';
import { useTitle } from '../../lib/useTitle';

export function NotFoundPage() {
  useTitle(t('Page not found'));
  return (
    <>
      <header className="page-head">
        <h1 className="page-title">{t('Page not found')}</h1>
      </header>
      <div className="card placeholder-card">
        <p className="ink-2">{t('There is nothing at this address.')}</p>
        <p>
          <Link to="/" className="ink" style={{ textDecoration: 'underline', textUnderlineOffset: 3 }}>
            {t('Back to the overview')}
          </Link>
        </p>
      </div>
    </>
  );
}
