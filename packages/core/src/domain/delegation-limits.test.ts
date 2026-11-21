import { describe, expect, it } from 'vitest';
import { DelegateOfferInput } from '../contracts/mcp-delegate.js';
import { DelegationDispatchContext } from '../contracts/runner.js';
import { DelegationCard } from './delegation.js';

const cardTask = (n: number) => ({
  id: `dlt_task${n}`,
  n,
  title: n === 13 ? 'Check everything together' : `Task ${n}`,
  why: null,
  picked: true,
  after: null,
  state: 'queued',
  pending: null,
  step: null,
  program: null,
  since: null,
  endedAt: null,
  url: null,
  branch: null,
  pr: null,
  note: null,
});

describe('a full checklist and its final integration check', () => {
  it('keeps ordinary task offers limited to twelve', () => {
    const tasks = Array.from({ length: 12 }, (_, i) => ({
      title: `Task ${i + 1}`,
      brief: 'Make the requested change.',
    }));
    expect(DelegateOfferInput.shape.tasks.safeParse(tasks).success).toBe(true);
    expect(DelegateOfferInput.shape.tasks.safeParse([...tasks, tasks[0]]).success).toBe(false);
  });

  it('carries twelve ordinary tasks and the final check on the card', () => {
    const tasks = Array.from({ length: 13 }, (_, i) => cardTask(i + 1));
    expect(DelegationCard.shape.tasks.safeParse(tasks).success).toBe(true);
    expect(DelegationCard.shape.tasks.safeParse([...tasks, cardTask(14)]).success).toBe(false);
  });

  it('carries the same full checklist to the agent that handles its result', () => {
    const tasks = Array.from({ length: 13 }, (_, i) => ({
      ...cardTask(i + 1),
      taskId: `dlt_task${i + 1}`,
      brief: 'Make the requested change.',
      threadId: null,
      told: false,
      answer: null,
    }));
    expect(DelegationDispatchContext.shape.tasks.safeParse(tasks).success).toBe(true);
    expect(DelegationDispatchContext.shape.tasks.safeParse([...tasks, tasks[0]]).success).toBe(false);
  });
});
