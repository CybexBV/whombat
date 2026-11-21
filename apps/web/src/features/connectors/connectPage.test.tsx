/**
 * A catalog entry's page on a Whombat without a secure address (whombat-link.md): it says what to do first instead of
 * offering a sign-in that can't come back.
 */

import { screen } from '@testing-library/react';
import { CATALOG_REASON_TEXT } from '@whombat/client/connections';
import { describe, expect, it, vi } from 'vitest';
import { createWebFixtureFetch } from '../../app/fixtureFetch';
import { mockedServices, renderApp } from '../../test/renderApp';

function services() {
  const base = createWebFixtureFetch({ connectors: 'none' });
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://whombat.test');
    const res = await base(new Request(url, init), init);
    if (!url.pathname.endsWith('/connections/catalog')) return res;
    const body = (await res.json()) as {
      entries: { catalogId: string; available: boolean; reason: unknown }[];
    };
    for (const e of body.entries)
      if (e.catalogId === 'dropbox') Object.assign(e, { available: false, reason: 'needs_secure_address' });
    return Response.json(body);
  }) as unknown as typeof globalThis.fetch;
  return mockedServices(fetch, {});
}

describe('Connect Dropbox without a secure address', () => {
  it('says what to do first, with no sign-in form', async () => {
    renderApp('/settings?tab=connections&connection=dropbox', services());
    expect(await screen.findByTestId('connect-address-reason')).toBeTruthy();
    expect(screen.getByTestId('connect-address-reason').textContent).toBe(
      CATALOG_REASON_TEXT.needsSecureAddress,
    );
    // One way forward: This Whombat → About → REACH, where Tailscale and Whombat Link are turned on.
    const action = screen.getByTestId('connect-address-action');
    expect(action.textContent).toBe(CATALOG_REASON_TEXT.needsSecureAddressAction);
    const href = new URL(action.getAttribute('href') ?? '', 'http://whombat.test');
    expect(href.pathname).toBe('/settings');
    expect(Object.fromEntries(href.searchParams)).toMatchObject({ tab: 'appliance', section: 'about' });
    expect(href.hash).toBe('#reach');
  });
});
