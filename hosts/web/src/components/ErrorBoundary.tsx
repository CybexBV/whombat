// Keeps a rendering error in one page from blanking the whole app: the page
// area shows the error with a Reload button; the shell stays usable.

import { Component, type ErrorInfo, type ReactNode } from 'react';
import { t } from '../lib/i18n';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ui] page crashed:', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="card empty-card" role="alert">
        <h1 className="h2">{t('This page could not be shown')}</h1>
        <p className="ink-2">{error.message || t('An unexpected error occurred.')}</p>
        <button type="button" className="btn-ghost" onClick={() => window.location.reload()}>
          {t('Reload')}
        </button>
      </div>
    );
  }
}
