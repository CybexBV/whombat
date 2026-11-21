import { describe, expect, it } from 'vitest';
import { AutomationDefinition } from '../domain/automation.js';
import { stepActsIn, stepContentRooms, stepReads, stepRequiredRooms } from './rooms.js';

const RUN = 'cnv_run';
const def = AutomationDefinition.parse({
  version: 1,
  conversationId: RUN,
  triggers: [{ kind: 'manual' }],
  steps: [
    { id: 'ask', kind: 'dispatch_agent', conversation: 'cnv_private', prompt: 'Look' },
    { id: 'wait', kind: 'wait', minutes: 5 },
    { id: 'relay', kind: 'post_message', conversation: 'cnv_public', text: 'It says {{steps.ask.text}}' },
    { id: 'echo', kind: 'post_message', text: '{{trigger.text}}' },
    { id: 'check', kind: 'condition', if: 'contains(steps.relay.text, "x")' },
    { id: 'call', kind: 'http_callback', url: 'https://example.com/x', body: '{"t":"{{steps.relay.text}}"}' },
    { id: 'files', kind: 'post_message', text: 'Files', attachFrom: ['ask'] },
    { id: 'approve', kind: 'request_approval', title: 'Go?', details: 'Plain' },
  ],
});

const step = (i: number) => {
  const s = def.steps[i];
  if (!s) throw new Error(`no step ${i}`);
  return s;
};

describe('step rooms', () => {
  it('knows where each step acts', () => {
    expect(def.steps.map((s) => stepActsIn(s, RUN))).toEqual([
      'cnv_private',
      null,
      'cnv_public',
      RUN,
      null,
      null,
      RUN,
      RUN,
    ]);
  });

  it('reads the trigger and earlier steps from templates, conditions and attachFrom', () => {
    expect(stepReads(step(2))).toEqual({ trigger: false, steps: ['ask'] });
    expect(stepReads(step(3))).toEqual({ trigger: true, steps: [] });
    expect(stepReads(step(4))).toEqual({ trigger: false, steps: ['relay'] });
    expect(stepReads(step(6))).toEqual({ trigger: false, steps: ['ask'] });
  });

  it('carries content rooms along what a step reads, transitively', () => {
    const rooms = stepContentRooms(def, RUN).map((r) => [...r].sort());
    expect(rooms).toEqual([
      ['cnv_private'],
      [],
      ['cnv_private', 'cnv_public'],
      [RUN],
      ['cnv_private', 'cnv_public'],
      ['cnv_private', 'cnv_public'],
      ['cnv_private', RUN],
      [RUN],
    ]);
  });

  it('always requires the run’s room of the publisher', () => {
    expect(stepRequiredRooms(def, RUN, 1)).toEqual([RUN]);
    expect([...stepRequiredRooms(def, RUN, 2)].sort()).toEqual(['cnv_private', 'cnv_public', RUN]);
  });
});
