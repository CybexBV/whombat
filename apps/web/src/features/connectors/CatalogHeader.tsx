import { Link } from '@tanstack/react-router';
import type { CatalogEntry } from '@whombat/core/domain';
import type { ReactNode } from 'react';
import { ExternalLink } from './CatalogParts';
import { ProviderLogo } from './ConnectionsOverview';
import c from './Connectors.module.css';
import { ADD_CONNECTION_LINK, useConnectionsBack } from './home';

/**
 * A catalog page's head (CX-71, CX-72): the way back — to Add a connection from a connect page (AP-1165), else to the
 * overview — then the logo, the title (the entry's name, or a connection's label), its line and the documentation link
 * — as a builtin provider's page (AP-673).
 */
export function CatalogHeader({
  entry,
  title,
  line,
  aside,
  back = 'all',
}: {
  entry: CatalogEntry;
  /** Where its back link goes: the overview (“All connections”), or Add a connection for a new connection's page. */
  back?: 'all' | 'add';
  /** A connection's label; the entry's name by default. */
  title?: ReactNode;
  /** Under the title; the entry's description by default. */
  line?: ReactNode;
  /** Beside the title (a connection's Rename). */
  aside?: ReactNode;
}) {
  const home = useConnectionsBack();
  return (
    <>
      <Link
        to={(back === 'add' ? ADD_CONNECTION_LINK : home.link).to}
        search={(back === 'add' ? ADD_CONNECTION_LINK : home.link).search as never}
        className={c.back}
      >
        {back === 'add' ? '← Add a connection' : home.label}
      </Link>
      <div className={c.providerHead}>
        <ProviderLogo provider={entry.id} size={48} />
        <span className={c.main}>
          <h2 className={c.providerTitle}>{title ?? entry.name}</h2>
          <span className={c.meta}>
            {line ?? entry.description}
            {entry.docsUrl && line === undefined ? (
              <>
                {' '}
                <ExternalLink href={entry.docsUrl}>Documentation</ExternalLink>
              </>
            ) : null}
          </span>
        </span>
        {aside}
      </div>
    </>
  );
}
