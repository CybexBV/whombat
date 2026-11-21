// The "Enroll a server" dialog opens in place on any page through the search
// parameter `?enroll=1` (optionally `&name=<prefill>`); the shell renders it.
// Opening pushes a history entry (Back closes the dialog); closing removes
// the parameters again.

import { useCallback } from 'react';
import { type To, useLocation, useNavigate } from 'react-router';

export const ENROLL_PARAM = 'enroll';
export const ENROLL_NAME_PARAM = 'name';

/** History state marking an entry pushed by opening the dialog. */
export interface EnrollState {
  enrollDialog?: boolean;
}

function withEnroll(search: string, name?: string): string {
  const p = new URLSearchParams(search);
  p.set(ENROLL_PARAM, '1');
  if (name) p.set(ENROLL_NAME_PARAM, name);
  else p.delete(ENROLL_NAME_PARAM);
  return `?${p.toString()}`;
}

/** Link target for a location (current page + `?enroll=1[&name=]`); pass `state` along. */
export function enrollTo(loc: { pathname: string; search: string; hash: string }, name?: string): To {
  return { pathname: loc.pathname, search: withEnroll(loc.search, name), hash: loc.hash };
}

export const ENROLL_STATE: EnrollState = { enrollDialog: true };

/** Link target (current page + `?enroll=1`) and the state to pass with it. */
export function useEnrollLink(name?: string): { to: To; state: EnrollState } {
  const loc = useLocation();
  return { to: enrollTo(loc, name), state: ENROLL_STATE };
}

/** Imperative opener for buttons. */
export function useOpenEnroll(): (name?: string) => void {
  const loc = useLocation();
  const navigate = useNavigate();
  return useCallback(
    (name?: string) => navigate({ pathname: loc.pathname, search: withEnroll(loc.search, name), hash: loc.hash }, { state: { enrollDialog: true } satisfies EnrollState }),
    [loc.pathname, loc.search, loc.hash, navigate],
  );
}

/** Close: go back when the dialog pushed the entry, else drop the parameters in place. */
export function useCloseEnroll(): () => void {
  const loc = useLocation();
  const navigate = useNavigate();
  return useCallback(() => {
    if ((loc.state as EnrollState | null)?.enrollDialog && window.history.length > 1) {
      navigate(-1);
      return;
    }
    const p = new URLSearchParams(loc.search);
    p.delete(ENROLL_PARAM);
    p.delete(ENROLL_NAME_PARAM);
    const s = p.toString();
    navigate({ pathname: loc.pathname, search: s ? `?${s}` : '', hash: loc.hash }, { replace: true });
  }, [loc, navigate]);
}
