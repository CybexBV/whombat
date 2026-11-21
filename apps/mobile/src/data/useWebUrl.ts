/**
 * A path on this Whombat as a web address the phone can open (SUB-11, CX-74): the Whombat's page on the hosted UI
 * (`applianceLink`), or null in the demo world (no web). The rule is `guideWebUrl`'s.
 */
import { useCallback } from 'react';
import { UI_ORIGINS } from '../managed/config';
import { useManaged } from '../managed/context';
import { guideWebUrl } from './guides';

export function useWebUrl(): (path: string) => string | null {
  const applianceId = useManaged()?.applianceId ?? null;
  return useCallback(
    (path: string) =>
      guideWebUrl({ applianceId, uiOrigin: UI_ORIGINS[0] ?? 'https://app.whombat.com' }, path),
    [applianceId],
  );
}
