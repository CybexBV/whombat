/**
 * `@whombat/control-contracts` — control API schemas (MA-03, MA-04, MA-06, MA-10, MA-11, LC-01…LC-18). Control never sees
 * content and cannot grant content access.
 */
import { authApi } from './auth.js';
import { billingApi } from './billing.js';
import { directoryApi } from './directory.js';
import { downloadsApi } from './downloads.js';
import { licenceApi } from './licence.js';
import { linkApi } from './link.js';
import { operatorApi } from './operator.js';
import { orgApi } from './orgs.js';
import { pushApi } from './push.js';
import { rolloutApi } from './rollout.js';
import { signupApi } from './signup.js';

export * from './auth.js';
export * from './billing.js';
export * from './common.js';
export * from './device/index.js';
export * from './directory.js';
export * from './downloads.js';
export * from './endpoint.js';
export * from './feedback.js';
export * from './licence.js';
export * from './link.js';
export * from './operator.js';
export * from './orgs.js';
export * from './push.js';
export * from './rollout.js';
export * from './signup.js';

/** Every session/operator/provisioning endpoint of the control API (the device API is `DEVICE_OPS`). */
export const controlApi = {
  auth: authApi,
  orgs: orgApi,
  directory: directoryApi,
  push: pushApi,
  rollout: rolloutApi,
  billing: billingApi,
  downloads: downloadsApi,
  signup: signupApi,
  licence: licenceApi,
  link: linkApi,
  operator: operatorApi,
} as const;
