/** The installer's flow (CG-14): which screen shows, which wizard steps exist, what each one needs. */
import {
  type Disk,
  INSTALL_STEPS,
  type InstallerState,
  type InstallRequest,
  type InstallStep,
  type ReachChoice,
} from './api';

export type WizardStep = 'welcome' | 'reach' | 'checks' | 'wifi' | 'disk' | 'erase';
export type InstallerScreen = WizardStep | 'installing' | 'done' | 'failed';

/** How the owner will reach the box (Whombat LNK-12): the page offers one of the two; the server also takes both. */
export type ReachWay = 'link' | 'tailscale';

export interface Wizard {
  step: WizardStep;
  /** The disk the operator picked (a path); null until they pick one. */
  disk: string | null;
  /** “Try again” after a failure: show the wizard again although the server still says `failed`. */
  retrying: boolean;
  /** The reach step's choice: Whombat Link unless the person picks Tailscale. */
  reach: ReachWay;
  /** Tailscale only: the person's own login server (Headscale) as typed; empty means Tailscale's own. */
  loginServer: string;
}

export const START: Wizard = {
  step: 'welcome',
  disk: null,
  retrying: false,
  reach: 'link',
  loginServer: '',
};

/**
 * A login server the box takes: an https address without a user, query or anything a shell would read. The same
 * pattern as the appliance's `reach.ValidLoginServer` (internal/reach/reach.go) and `whombat-install`.
 */
export const LOGIN_SERVER_RE =
  /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?(?:\/[A-Za-z0-9._~/-]{0,200})?$/;

/** The typed login server is fine: empty (Tailscale's own) or an address the box takes (spaces around forgiven). */
export const loginServerValid = (typed: string): boolean =>
  typed.trim() === '' || LOGIN_SERVER_RE.test(typed.trim());

/** What the server is sent for the wizard's choice; null while the login server can't be one. */
export function reachChoice(w: Pick<Wizard, 'reach' | 'loginServer'>): ReachChoice | null {
  if (w.reach === 'link') return { link: true, tailscale: false };
  if (!loginServerValid(w.loginServer)) return null;
  const server = w.loginServer.trim();
  return { link: false, tailscale: true, ...(server ? { loginServer: server } : {}) };
}

/** A community image has no Whombat Link, so the page doesn't ask (NX-445); an older server says no edition. */
export const asksReach = (s: InstallerState): boolean => s.edition !== 'community';

/**
 * The reach step's choice for `POST /api/preflight`, so the checks try what that choice needs; undefined when the page
 * doesn't ask (the server keeps its default).
 */
export function preflightRequest(s: InstallerState, w: Wizard): Record<string, unknown> | undefined {
  const reach = asksReach(s) ? reachChoice(w) : null;
  return reach ? { reach } : undefined;
}

/** `POST /api/install`: the disk, its typed name and the reach step's choice. */
export function installRequest(s: InstallerState, w: Wizard, disk: Disk, typed: string): InstallRequest {
  const reach = asksReach(s) ? reachChoice(w) : null;
  return { disk: disk.path, confirm: typed.trim(), ...(reach ? { reach } : {}) };
}

/**
 * The server decides once an installation started (a reload mid-install lands on the right screen); before that
 * the page walks the wizard.
 */
export function installerScreen(s: InstallerState, w: Wizard): InstallerScreen {
  switch (s.install.status) {
    case 'running':
      return 'installing';
    case 'done':
      return 'done';
    case 'failed':
      return w.retrying ? w.step : 'failed';
    default:
      return w.step;
  }
}

export const eligibleDisks = (s: InstallerState): Disk[] => s.preflight.disks.filter((d) => d.eligible);

/** The wizard's steps: how the box will be reached before the checks, so they try what that way needs (LNK-12; not
 * on a community image); Wi-Fi when no cable had an address at the last check (HD-08, CG-120); Disk only when there
 * is a choice (not exactly one eligible disk). Nothing depends on the platform or the storage (CG-32: no Before you
 * install step). */
export function wizardSteps(s: InstallerState): WizardStep[] {
  const steps: WizardStep[] = ['welcome'];
  if (asksReach(s)) steps.push('reach');
  steps.push('checks');
  if (s.wired === false) steps.push('wifi');
  if (eligibleDisks(s).length !== 1) steps.push('disk');
  steps.push('erase');
  return steps;
}

export function nextStep(s: InstallerState, step: WizardStep): WizardStep {
  const steps = wizardSteps(s);
  const i = steps.indexOf(step);
  return steps[Math.min(i + 1, steps.length - 1)] ?? 'erase';
}

export function prevStep(s: InstallerState, step: WizardStep): WizardStep {
  const steps = wizardSteps(s);
  const i = steps.indexOf(step);
  return i <= 0 ? 'welcome' : (steps[i - 1] ?? 'welcome');
}

/** “STEP 2 OF 3”: the steps after Welcome. Null on Welcome. */
export function stepOf(s: InstallerState, step: WizardStep): { n: number; of: number } | null {
  const steps: WizardStep[] = wizardSteps(s).filter((x) => x !== 'welcome');
  const i = steps.indexOf(step);
  return i < 0 ? null : { n: i + 1, of: steps.length };
}

export type ChecksVerdict = 'running' | 'ok' | 'warn' | 'fail';

/** The checks as a whole: any fail blocks Continue (CG-13), warnings don't. */
export function checksVerdict(s: InstallerState): ChecksVerdict {
  const c = s.preflight.checks;
  if (s.preflight.status === 'running' || c.some((x) => x.status === 'running')) return 'running';
  if (c.length === 0) return 'running';
  if (c.some((x) => x.status === 'fail')) return 'fail';
  if (c.some((x) => x.status === 'warn')) return 'warn';
  return 'ok';
}

/** The disk to install on: the operator's pick while it is eligible, else the only eligible disk. */
export function chosenDisk(s: InstallerState, picked: string | null): Disk | null {
  const eligible = eligibleDisks(s);
  const p = eligible.find((d) => d.path === picked);
  if (p) return p;
  return eligible.length === 1 ? (eligible[0] ?? null) : null;
}

/** The Erase button needs the disk's name typed exactly (surrounding spaces forgiven). */
export const eraseConfirmed = (typed: string, disk: Disk | null): boolean =>
  disk !== null && typed.trim() === disk.name;

export type StepState = 'done' | 'current' | 'pending' | 'failed';

export function stepStates(s: InstallerState): Record<InstallStep, StepState> {
  const { status, step } = s.install;
  const at = step ? INSTALL_STEPS.indexOf(step) : status === 'running' ? 0 : -1;
  const out = {} as Record<InstallStep, StepState>;
  INSTALL_STEPS.forEach((id, i) => {
    if (status === 'done') out[id] = 'done';
    else if (i < at) out[id] = 'done';
    else if (i === at) out[id] = status === 'failed' ? 'failed' : 'current';
    else out[id] = 'pending';
  });
  return out;
}

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

/** Disk sizes as the checks state them (binary units): “128 GiB”, “1.8 TiB”. */
export function formatSize(bytes: number): string {
  if (bytes >= TiB) return `${(bytes / TiB).toFixed(1).replace(/\.0$/, '')} TiB`;
  if (bytes >= 10 * GiB) return `${Math.round(bytes / GiB)} GiB`;
  return `${(bytes / GiB).toFixed(1).replace(/\.0$/, '')} GiB`;
}
