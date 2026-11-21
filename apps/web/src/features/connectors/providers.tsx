/**
 * The providers Settings → Connections lists (AP-673): each one's name, what it brings and its logo. One entry per
 * `ConnectorProvider` in the contracts, so a provider the contracts add shows up here once it has its entry.
 *
 * Logos are the providers' own marks in their own colours: the one place hex colours stand outside the tokens, like
 * the README's fixed colours (status dots, avatar tones). They are drawn, never fetched (the strict CSP, offline boxes).
 */
import { BrandMark } from '@whombat/brand/react';
import { CONNECTOR_PROVIDER_LABELS, type ConnectorProvider, catalogEntry } from '@whombat/core/domain';
import type { ReactElement } from 'react';

export interface ProviderInfo {
  id: ConnectorProvider;
  /** “Google”. */
  name: string;
  /** What connecting it brings, in a line: the overview's tiles and the provider page's header. */
  description: string;
  Logo: (props: { size: number }) => ReactElement;
}

/** Google's “G”, four colours (Google's brand guidelines: on a light or dark tile, never recoloured). */
function GoogleLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true" focusable="false">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

function MicrosoftLogo({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="currentColor" d="M1 1h10v10H1zM13 1h10v10H13zM1 13h10v10H1zM13 13h10v10H13z" />
    </svg>
  );
}

/** Email (IMAP): Lucide's envelope in the text colour (AP-2763). */
function ImapLogo({ size }: { size: number }) {
  return <BrandMark mark="imap" size={size} />;
}

export const PROVIDERS: Record<ConnectorProvider, ProviderInfo> = {
  microsoft: {
    id: 'microsoft',
    name: 'Microsoft 365',
    description: 'Outlook Mail and Calendar, OneDrive and Contacts.',
    Logo: MicrosoftLogo,
  },
  google: {
    id: 'google',
    name: CONNECTOR_PROVIDER_LABELS.google,
    description: 'Gmail, Calendar, Drive, Docs, Sheets and Contacts.',
    Logo: GoogleLogo,
  },
  // Email (IMAP) (connections-more-web.md AP-2765): its catalog entry's words.
  imap: {
    id: 'imap',
    name: CONNECTOR_PROVIDER_LABELS.imap,
    description: catalogEntry('imap')?.description ?? '',
    Logo: ImapLogo,
  },
};
