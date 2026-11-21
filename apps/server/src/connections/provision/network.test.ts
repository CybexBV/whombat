/** The network services' provisioners match the catalog (docs/decisions/connections-setup.md CS-01, CS-30…CS-35). */
import { catalogEntry } from '@whombat/core';
import { describe, expect, it } from 'vitest';
import { NETWORK_PROVISIONERS } from './network';

describe('NETWORK_PROVISIONERS', () => {
  it('has one for each network service whose catalog entry signs in once', () => {
    expect(Object.keys(NETWORK_PROVISIONERS).sort()).toEqual(
      ['forgejo', 'grafana', 'opnsense', 'portainer', 'unifi_network', 'unifi_protect', 'unraid'].sort(),
    );
    for (const id of Object.keys(NETWORK_PROVISIONERS)) {
      const entry = catalogEntry(id);
      expect(
        entry?.signIn.some((s) => s.kind === 'password'),
        id,
      ).toBe(true);
    }
    expect(NETWORK_PROVISIONERS.unifi_network).toBe(NETWORK_PROVISIONERS.unifi_protect);
  });

  it('answers what each entry’s token sign-in stores', () => {
    const tokenAuth = (id: string) => {
      const entry = catalogEntry(id);
      const password = entry?.signIn.find((s) => s.kind === 'password');
      const tokens = entry?.signIn.filter((s) => s.kind === 'token') ?? [];
      const index = password?.kind === 'password' ? password.tokenMethod : 0;
      const token = tokens[index];
      return token?.kind === 'token' ? token.auth : null;
    };
    expect(tokenAuth('unifi_network')).toEqual({ type: 'header', name: 'X-API-KEY', template: '{secret}' });
    expect(tokenAuth('unifi_protect')).toEqual({ type: 'header', name: 'X-API-KEY', template: '{secret}' });
    // OPNsense's key goes in the `apiKey` field the provisioner fills.
    expect(tokenAuth('opnsense')).toEqual({ type: 'basic', usernameField: 'apiKey' });
    expect(tokenAuth('unraid')).toEqual({ type: 'header', name: 'x-api-key', template: '{secret}' });
    expect(tokenAuth('portainer')).toEqual({ type: 'header', name: 'X-API-Key', template: '{secret}' });
    expect(tokenAuth('grafana')).toEqual({ type: 'bearer' });
    expect(tokenAuth('forgejo')).toEqual({
      type: 'header',
      name: 'Authorization',
      template: 'token {secret}',
    });
  });
});
