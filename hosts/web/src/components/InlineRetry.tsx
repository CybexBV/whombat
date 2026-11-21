// Load error inside a card (an ErrorCard would nest a card in a card).

import { t } from '../lib/i18n';
import { InlineError, errorText } from './forms';

export function InlineRetry({ title, error, onRetry }: { title: string; error: unknown; onRetry?: () => void }) {
  return (
    <div className="inline-retry">
      <InlineError>
        {title}: {errorText(error)}
      </InlineError>
      {onRetry && (
        <button type="button" className="btn-ghost" onClick={onRetry}>
          {t('Retry')}
        </button>
      )}
    </div>
  );
}
