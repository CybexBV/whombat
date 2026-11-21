import { useRouteContext } from '@tanstack/react-router';

/** The open burrow's slug (AP-361), inside the burrow screens: the router's burrow layout picked it. */
export function useOpenBurrow(): string {
  return useRouteContext({ from: '/_burrow' }).burrow;
}
