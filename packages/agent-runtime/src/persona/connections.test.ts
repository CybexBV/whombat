import { describe, expect, it } from 'vitest';
import { CONNECTIONS_HEADING, connectionLines, usesConnections } from './connections';

describe('connected services in the preface (Whombat connections-catalog.md CX-35)', () => {
  it('adds nothing without connections', () => {
    expect(connectionLines({})).toEqual([]);
    expect(connectionLines({ connections: [] })).toEqual([]);
    expect(usesConnections({})).toBe(false);
  });

  it('says one line per connection, and where one that needs connecting again is fixed', () => {
    const lines = connectionLines({
      connections: [
        {
          handle: 'homeassistant',
          catalogId: 'homeassistant',
          name: 'Home Assistant',
          label: 'Home Assistant · home.lan',
          status: 'active',
        },
        {
          handle: 'todoist',
          catalogId: 'todoist',
          name: 'Todoist',
          label: 'Todoist',
          status: 'needs_reauth',
        },
      ],
    });
    expect(lines).toEqual([
      CONNECTIONS_HEADING,
      '- homeassistant — Home Assistant · home.lan. Use connection_tools to see what it can do.',
      '- todoist — Todoist needs signing in again in Settings → Connections.',
    ]);
  });

  it('serves the tools only when one is active', () => {
    const c = { handle: 'x', catalogId: 'custom_api', name: 'API', label: 'API' };
    expect(usesConnections({ connections: [{ ...c, status: 'needs_reauth' }] })).toBe(false);
    expect(usesConnections({ connections: [{ ...c, status: 'active' }] })).toBe(true);
  });
});
