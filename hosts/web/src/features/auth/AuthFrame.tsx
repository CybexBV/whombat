// Standalone frame of the signed-out pages (no top bar): brand above a
// single centered card.

import type { ReactNode } from 'react';
import { Icon } from '../../components/Icon';
import { PRODUCT_NAME } from '../../lib/product';

export function AuthFrame({ title, intro, children, footer, busy }: { title?: string; intro?: ReactNode; children?: ReactNode; footer?: ReactNode; busy?: boolean }) {
  return (
    <main id="main" className="standalone auth-page" aria-busy={busy || undefined}>
      <div className="auth-wrap">
        <div className="brand auth-brand">
          <Icon name="brand" size={24} />
          <span>{PRODUCT_NAME}</span>
        </div>
        {!busy && (
          <div className="card auth-card">
            {title && <h1 className="auth-title">{title}</h1>}
            {intro && <p className="auth-intro">{intro}</p>}
            {children}
          </div>
        )}
        {!busy && footer && <div className="auth-foot">{footer}</div>}
      </div>
    </main>
  );
}
