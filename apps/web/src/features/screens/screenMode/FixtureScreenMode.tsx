/**
 * The screen page in fixture mode (desk-display-web.md AP-5966): `/use-as-screen` plays a device on the page's fake box
 * (`VITE_FIXTURE_DESK=screens`) — a new one that shows its six letters (`window.__WHOMBAT_DESK__.displayLetters`), or
 * with `?as=kitchen` / `?as=office` the seeded tablet or monitor drawing its screen.
 */
import { fakeScreenDevice } from '@whombat/client/desk/fake';
import { useMemo } from 'react';
import { deskFixture } from '../../../app/deskFixtures';
import { screenDeviceLabel } from './model';
import { type ScreenModeDeps, ScreenModePage, type ScreenRecord } from './ScreenMode';

const SEEDED: Record<string, { endpoint: string; screen: ScreenRecord }> = {
  kitchen: { endpoint: 'end_kitchen', screen: { id: 'scr_kitchen1', name: 'Kitchen tablet' } },
  office: { endpoint: 'end_office', screen: { id: 'scr_office01', name: 'Office monitor' } },
};

export function FixtureScreenMode({ as }: { as?: string | undefined }) {
  const deps = useMemo<ScreenModeDeps | null>(() => {
    const fx = deskFixture();
    if (!fx) return null;
    const seeded = as ? SEEDED[as] : undefined;
    const device = fakeScreenDevice(fx.desk, seeded?.endpoint ?? 'end_this_browser');
    let record: ScreenRecord | null = seeded?.screen ?? null;
    return {
      enrol: () => ({ api: device.enrol, close() {} }),
      screen: () => ({ api: device.screen, close() {} }),
      load: () => record,
      save: (next) => {
        record = next;
      },
      label: screenDeviceLabel(navigator.userAgent, navigator.maxTouchPoints > 1),
      onLeave: () => window.history.back(),
      timeZone: 'Europe/Amsterdam',
    };
  }, [as]);
  if (!deps) return null;
  return <ScreenModePage deps={deps} />;
}
