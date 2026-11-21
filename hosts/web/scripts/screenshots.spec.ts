// Full-page screenshots of every page state in fixture mode (UI v2), saved to
// web/.screenshots/ for visual review. The browser clock is pinned to 8 s after
// the fixtures' `as_of` (2026-10-11T14:00:00Z) and the time zone to UTC. Every
// shot also checks that the page never scrolls sideways.
import { expect, test } from '@playwright/test';

const SHOTS: { name: string; path: string; ready: string | RegExp; desktop?: boolean; mobile?: boolean }[] = [
  { name: 'overview', path: '/', ready: 'Capacity' },
  { name: 'overview-lab-7d', path: '/?group=Lab&range=7d', ready: 'Capacity', mobile: false },
  { name: 'host-summary', path: '/servers/basalt', ready: 'All 27' },
  { name: 'host-guests-docker', path: '/servers/basalt?tab=guests', ready: 'Docker containers' },
  { name: 'host-guests-incus', path: '/servers/basalt?tab=guests&platform=incus', ready: 'Incus instances', mobile: false },
  { name: 'host-guests-screens', path: '/servers/basalt?tab=guests&platform=incus&view=screens', ready: 'Screens', mobile: false },
  { name: 'host-console-vm', path: '/servers/basalt/guests/incus%3Anixbuild/console?platform=incus', ready: 'Fullscreen' },
  { name: 'host-storage', path: '/servers/basalt?tab=storage', ready: '4 disks', mobile: false },
  { name: 'host-sensors', path: '/servers/basalt?tab=sensors', ready: 'Highest right now', mobile: false },
  { name: 'host-virtualization', path: '/servers/basalt?tab=virtualization', ready: 'vCPU allocated', mobile: false },
  { name: 'host-agent', path: '/servers/basalt?tab=agent', ready: 'Remote control', mobile: false },
  { name: 'proxmox-summary', path: '/servers/shale', ready: 'prod-pve' },
  { name: 'proxmox-guests-lxc', path: '/servers/shale?tab=guests&platform=ct', ready: 'LXC containers', mobile: false },
  { name: 'proxmox-storage', path: '/servers/shale?tab=storage', ready: 'Backups', mobile: false },
  { name: 'proxmox-virtualization', path: '/servers/shale?tab=virtualization', ready: 'Cluster: prod-pve', mobile: false },
  { name: 'host-7d', path: '/servers/basalt?range=7d', ready: 'All 27', mobile: false },
  { name: 'guests', path: '/guests', ready: 'every VM and container' },
  { name: 'guests-console', path: '/guests?console=basalt%2Fincus%3Adev-shell', ready: /Connected · Shell/, mobile: false },
  { name: 'alerts', path: '/alerts', ready: 'History' },
];

for (const s of SHOTS) {
  test(s.name, async ({ page }, info) => {
    const mobile = info.project.name === 'mobile';
    test.skip(mobile ? s.mobile === false : s.desktop === false, 'not captured at this width');
    await page.clock.setFixedTime(new Date('2026-10-11T14:00:08Z'));
    await page.goto(s.path);
    await expect(page.getByText(s.ready).first()).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const name = `${mobile ? 'mobile-' : ''}${s.name}`;
    await page.screenshot({ path: `.screenshots/${name}.png`, fullPage: true });
    // No horizontal page scroll at any width (AGENTS.md 3).
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, 'horizontal page overflow in px').toBeLessThanOrEqual(0);
  });
}
