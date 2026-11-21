/**
 * The own address on the dev stack (Whombat own-address.md; appliance MG-161, plan §4): the relay's door, control's
 * label registry and `lbl` switch, and the stack appliance's own manager, each from the stack's environment
 * (`stack-dev.env` on the DEV instance). Everything is off unless set: a reset of the stack would otherwise burn a new
 * label and a certificate of Let's Encrypt's weekly limit for whombat.app, which prod shares (plan D3, OWA-18).
 */

type Env = Record<string, string | undefined>;

const v = (env: Env, name: string): string => env[name]?.trim() ?? '';

/**
 * The relay's door flags (relay RL-36, RL-40) from `WB_MGD_DOOR_LISTEN` (e.g. `100.64.0.5:4712`; empty: no
 * door), `WB_MGD_DOOR_ZONE` (`dev.whombat.app`) and `WB_MGD_DOOR_PROXY_FROM` (the door host's forwarder, CIDRs with
 * commas). `help` is the relay's `-h`: a relay from before the door gets none, and `skipped` says why.
 */
export function relayDoorArgs(env: Env, help: string): { args: string[]; skipped?: string } {
  const listen = v(env, 'WB_MGD_DOOR_LISTEN');
  if (!listen) return { args: [] };
  if (!help.includes('door-listen'))
    return { args: [], skipped: 'this relay has no door (before RL-36); WB_MGD_DOOR_LISTEN is ignored' };
  const zone = v(env, 'WB_MGD_DOOR_ZONE') || 'dev.whombat.app';
  const args = ['-door-listen', listen, '-door-zone', zone];
  const from = v(env, 'WB_MGD_DOOR_PROXY_FROM');
  if (from) args.push('-door-proxy-protocol-from', from);
  return { args };
}

/**
 * Control's own-address settings (control CL-165, CL-166) from `WB_MGD_OWN_ADDRESS_ZONE` (empty: control registers
 * no labels) and `WB_MGD_OWN_ADDRESS_LBL` (`on` only after the relay takes contracts 4.3: an older relay refuses every
 * ticket with `lbl`), Link's label cap from `WB_MGD_LINK_LABELS_PER_DAY`, and where control mails its weekly Link report
 * from `WB_MGD_LINK_REPORT_TO` (control CL-195). A control from before them ignores them.
 */
export function ownAddressControlEnv(env: Env): Record<string, string> {
  const zone = v(env, 'WB_MGD_OWN_ADDRESS_ZONE');
  const lbl = v(env, 'WB_MGD_OWN_ADDRESS_LBL');
  if (lbl && lbl !== 'on' && lbl !== 'off') throw new Error(`WB_MGD_OWN_ADDRESS_LBL=${lbl}: want on or off`);
  // Whombat Link's daily cap on new labels (control LINK_LABELS_PER_DAY): DEV runs with 2, so a stack reset or a
  // runaway can't spend the certificates whombat.app shares with production.
  const perDay = v(env, 'WB_MGD_LINK_LABELS_PER_DAY');
  if (perDay && !/^\d{1,4}$/.test(perDay))
    throw new Error(`WB_MGD_LINK_LABELS_PER_DAY=${perDay}: want a whole number`);
  const reportTo = v(env, 'WB_MGD_LINK_REPORT_TO');
  if (reportTo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reportTo))
    throw new Error(`WB_MGD_LINK_REPORT_TO=${reportTo}: want an e-mail address`);
  return {
    ...(zone ? { OWN_ADDRESS_ZONE: zone } : {}),
    ...(lbl ? { OWN_ADDRESS_LBL: lbl } : {}),
    ...(perDay ? { LINK_LABELS_PER_DAY: perDay } : {}),
    ...(reportTo ? { LINK_REPORT_TO: reportTo } : {}),
  };
}

/**
 * The stack appliance's manager's `WHOMBAT_OWN_ADDRESS` (MG-161) from `WB_MGD_OWN_ADDRESS`: `off` unless set (plan D3).
 * `staging` for Let's Encrypt staging (DEV step 5), `on` for a real certificate (step 8), `pebble:<URL>` for tests.
 * Always set, so a value in the harness's own environment never reaches the manager by accident.
 */
export function ownAddressManagerEnv(env: Env): { WHOMBAT_OWN_ADDRESS: string } {
  const mode = v(env, 'WB_MGD_OWN_ADDRESS') || 'off';
  if (!['off', 'on', 'staging'].includes(mode) && !mode.startsWith('pebble:'))
    throw new Error(`WB_MGD_OWN_ADDRESS=${mode}: want off, on, staging or pebble:<directory URL>`);
  return { WHOMBAT_OWN_ADDRESS: mode };
}
