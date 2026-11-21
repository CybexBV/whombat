import { describe, expect, it } from 'vitest';
import * as approvals from './approvals/index.js';
import * as audit from './audit/index.js';
import * as contracts from './contracts/index.js';
import * as domain from './domain/index.js';
import * as root from './index.js';
import * as keys from './keys/index.js';
import * as text from './text/index.js';
import * as vault from './vault/index.js';

describe('core', () => {
  it('re-exports every subpath from the root', () => {
    const exported = new Map(Object.entries(root));
    for (const mod of [approvals, audit, contracts, domain, keys, text, vault]) {
      for (const [name, value] of Object.entries(mod)) expect(exported.get(name), name).toBe(value);
    }
  });
});
