/**
 * Where a connection opens once it is connected (connection-pages.md CP-01; connection-pages-web.md AP-1900…): its own
 * page.
 */
import { thingHref } from '@whombat/core';
import { useCallback } from 'react';
import { useNavigateHref } from '../../app/routing/navigation';

export function useOpenConnection(): (catalogId: string, connectionId: string) => void {
  const navigateHref = useNavigateHref();
  return useCallback(
    (_catalogId, connectionId) => navigateHref(thingHref('connection', connectionId)),
    [navigateHref],
  );
}
