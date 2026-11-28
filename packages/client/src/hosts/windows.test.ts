/**
 * A Windows PC's page (Whombat windows-servers.md): its kind and tabs, the System line, the “This PC” facts in English
 * and Dutch, its updates read but never installed, and the PowerShell line that allows a switch on it.
 */
import { HostServerDetail } from '@whombat/core/domain';
import { describe, expect, it } from 'vitest';
import {
  serverDashboardHead,
  serverDashboardKind,
  serverDashboardTabs,
  serverDashboardView,
} from './dashboard';
import { createHostsFixtures } from './fixtures';
import { WINDOWS_SERVER, windowsFixtureDetail } from './fixtures-windows';
import { allowCommand } from './system';
import { serverUpdatesView } from './updates';
import {
  isWindowsServer,
  WINDOWS_SERVER_TABS,
  windowsFacts,
  windowsProtection,
  windowsSystemLine,
} from './windows';

const NOW = Date.parse('2026-11-28T10:00:00Z');

function pcPage(): HostServerDetail {
  const fx = createHostsFixtures(NOW);
  const r = fx.handle({ method: 'GET', path: `/servers/${WINDOWS_SERVER}`, query: {}, body: {} });
  return HostServerDetail.parse((r as { body: unknown }).body);
}

describe('a Windows PC’s page', () => {
  it('is its own kind with the plain tabs it has', () => {
    const d = pcPage();
    expect(isWindowsServer(d)).toBe(true);
    expect(serverDashboardKind(d)).toBe('windows');
    expect(serverDashboardTabs('windows')).toEqual(WINDOWS_SERVER_TABS);
    expect(WINDOWS_SERVER_TABS).not.toContain('guests');
  });

  it('says its Windows on the System line and its own facts in Technical details', () => {
    const d = pcPage();
    expect(
      windowsSystemLine({ product: 'Windows 11 Pro', displayVersion: '24H2', build: '26100.2605' }),
    ).toBe('Windows 11 Pro 24H2 (26100.2605)');
    expect(serverDashboardHead(d).details.find((r) => r.value.startsWith('Windows 11'))).toBeTruthy();
    const facts = serverDashboardView({ detail: d, range: '24h', now: NOW }).details.find(
      (p) => p.id === 'kind_facts',
    );
    expect(facts?.title).toBe('This PC');
    const text = JSON.stringify(facts);
    expect(text).toContain('Microsoft Defender Antivirus');
    expect(text).toContain('C: on · D: off');
  });

  it('tells the protection in Dutch, and Off as a problem', () => {
    const w = windowsFixtureDetail(NOW);
    expect(windowsFacts(w, NOW, 'nl').map((f) => f.label)).toContain('Virusbescherming');
    const off = windowsProtection(windowsFixtureDetail(NOW, true).protection);
    expect(off.tone).toBe('bad');
    expect(windowsProtection({ ...w.protection, state: 'unknown', product: null }).tone).toBe('mut');
  });

  it('reads its updates and offers a restart, but never installs them', () => {
    const d = pcPage();
    const view = serverUpdatesView({
      server: WINDOWS_SERVER,
      system: d.health?.system ?? null,
      remoteControl: { manage: true, hostPower: true },
      unraid: false,
      windows: true,
      connected: true,
      now: NOW,
    });
    expect([view.install, view.check, view.count]).toEqual([false, false, 2]);
    expect(view.note).toContain('Windows Update');
    expect(view.restart.button).toBe(true);
  });

  it('allows a switch on the PC with its own PowerShell line', () => {
    expect(allowCommand('diagnose', 'windows')).toBe(
      '& "$env:ProgramFiles\\Whombat\\whombat-agent.exe" allow diagnose',
    );
    expect(allowCommand('diagnose', 'systemd')).toBe('sudo whombat-agent allow diagnose');
  });
});
