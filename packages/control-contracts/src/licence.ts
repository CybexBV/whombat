/**
 * The licence key set as control serves it (LC-03). Devices never fetch it: an appliance trusts only the key set
 * pinned in its image (`/etc/whombat/licence-keys.json`). This endpoint is for operators and the dev harness, which
 * writes a dev image's key set from it at provisioning time. Tokens come from the device op `licence.renew`.
 */
import { LicenceKeySet } from '@whombat/protocol/licence';
import { controlEndpoint } from './endpoint.js';

export const licenceApi = {
  keys: controlEndpoint({
    id: 'licence.keys',
    method: 'GET',
    path: '/licence/keys',
    auth: 'none',
    summary:
      'The public licence key set of this environment (`LicenceKeySet {v, env, keys}`: current and next keys). For operators and the dev harness only; devices never fetch it, they trust the set pinned in their image (LC-03).',
    response: LicenceKeySet,
  }),
};
