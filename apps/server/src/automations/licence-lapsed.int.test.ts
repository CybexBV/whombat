/**
 * Automations with a lapsed licence state since Whombat Link (docs/decisions/whombat-link.md LNK-04): the licence is
 * inert, so even a lapsed state in the gate pauses nothing — Run now runs and a started run goes on. What a lapse used to
 * hold was retired with the behaviour. Real database, FAKE AGENTS.
 */
import type { AutomationDefinitionInput } from '@whombat/core';
import type { LicenceStatusResult } from '@whombat/protocol/licence';
import { afterEach, describe, expect, it } from 'vitest';
import { IDS, useAutomationWorld } from '../test/automations';
import { runAutomationNow } from './commands';

const w = useAutomationWorld();

const LAPSED: LicenceStatusResult = {
  state: 'lapsed',
  reason: 'expired',
  plan: 'team',
  limits: { devices: 1, connectors: null },
  renewedAt: null,
  expiresAt: null,
  graceEndsAt: null,
  effectiveAt: 0,
};
const lapse = () => w.services.licence.enforce(() => LAPSED);
const restore = () => w.services.licence.release();

afterEach(() => restore());

const def = (extra: Partial<AutomationDefinitionInput>) =>
  ({
    version: 1,
    conversationId: IDS.billing,
    triggers: [{ kind: 'manual' }],
    steps: [{ id: 'note', kind: 'post_message', text: 'Tick.' }],
    ...extra,
  }) as AutomationDefinitionInput;

describe('a lapsed licence state (inert, LNK-04)', () => {
  it('pauses nothing: Run now runs, test runs too, and the run finishes', async () => {
    const id = await w.publish(def({}), { name: 'By hand' });
    lapse();
    expect(w.services.licence.lapsed).toBe(false);
    for (const test of [false, true]) await w.ok(IDS.mara, runAutomationNow, { automationId: id, test });
    await w.settle();
    const runs = await w.runs(id);
    expect(runs).toHaveLength(2);
  });
});
