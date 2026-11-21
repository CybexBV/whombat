import type { Meta, StoryObj } from '@storybook/react-vite';
import { type Run, type RunStep, shortNameOf } from '@whombat/core';
import {
  BASE_LOG_LINES,
  dusty,
  run as fixtureRun,
  grantsFor,
  mara,
  PRINCIPALS,
  RUN_LOG_LINES,
  RUN_STEPS_TIMELINE,
  runFinished,
  SEED_TIME_ZONE,
} from '@whombat/fixtures';
import { RunView } from './RunView';
import { TakeOverDialog } from './TakeOverDialog';

/** The storyline's five steps with the first `done` finished and the next one active (the mock's RSTEPS). */
function steps(done: number): RunStep[] {
  return RUN_STEPS_TIMELINE.map((s, i) => ({
    title: s.title,
    detail: s.detail,
    at: i <= done ? s.at : null,
    state: i < done ? 'done' : i === done ? 'active' : 'queued',
  }));
}

const live: Run = { ...fixtureRun, steps: steps(0) };
const nameOf = (id: string) => {
  const p = PRINCIPALS.find((x) => x.id === id);
  return p ? shortNameOf(p) : 'Someone';
};

const meta = {
  title: 'Runs/Run page',
  component: RunView,
  parameters: { layout: 'fullscreen' },
  args: {
    run: live,
    log: BASE_LOG_LINES,
    grants: grantsFor(dusty.id),
    agent: { name: dusty.name, face: dusty.face },
    askedBy: shortNameOf(mara),
    where: 'feat/invoice-pdf',
    timeZone: SEED_TIME_ZONE,
    viewerId: mara.id,
    nameOf,
    backHref: '/pr/482',
    branchRoomHref: '/pr/482',
    onNavigate: () => {},
    onAction: () => {},
  },
} satisfies Meta<typeof RunView>;

export default meta;
type Story = StoryObj<typeof meta>;

const dark = { globals: { theme: 'dark' } };

/** 11:22, as the mock opens: step one active, the base log, 38 of 41. */
export const Live: Story = {};
export const LiveDark: Story = { ...dark, name: 'Live (dark)' };

/** Halfway: three steps done, the tests running. */
export const Running: Story = {
  args: {
    run: { ...fixtureRun, steps: steps(3), diff: { add: 244, del: 20, files: 6 }, logCount: 13 },
    log: RUN_LOG_LINES.slice(0, 13),
  },
};

const doneArgs: Story['args'] = {
  run: { ...runFinished, steps: steps(5) },
  log: RUN_LOG_LINES,
};
/** RUN · DONE: every step done, 41 of 41, no controls but Branch room. */
export const Done: Story = { args: doneArgs };
export const DoneDark: Story = { ...dark, name: 'Done (dark)', args: doneArgs };

const pausedArgs: Story['args'] = { run: { ...live, status: 'paused', pausedById: mara.id } };
/** Paused by the viewer: Resume replaces Pause; a quiet warn note. */
export const Paused: Story = { args: pausedArgs };
export const PausedDark: Story = { ...dark, name: 'Paused (dark)', args: pausedArgs };

const takenArgs: Story['args'] = {
  run: {
    ...live,
    status: 'taken_over',
    takenOverById: mara.id,
    summary: 'Mara took over feat/invoice-pdf.',
  },
};
/** Taken over by the viewer: the branch is theirs, with the command to pick it up. */
export const TakenOver: Story = { args: takenArgs };
export const TakenOverDark: Story = { ...dark, name: 'Taken over (dark)', args: takenArgs };

const failedArgs: Story['args'] = {
  run: {
    ...live,
    status: 'failed',
    steps: steps(3),
    logCount: 13,
    summary: 'The billing test suite didn’t start: the test database was not reachable.',
  },
  log: [
    ...RUN_LOG_LINES.slice(0, 12),
    { seq: 12, at: RUN_LOG_LINES[11]?.at ?? live.startedAt, text: '✗ could not connect to billing_test' },
  ],
};
/** Failed: the run’s summary in a quiet bad-toned note; the active step stops; Try again, styled as Resume (AP-596). */
export const Failed: Story = { args: failedArgs };
export const FailedDark: Story = { ...dark, name: 'Failed (dark)', args: failedArgs };

const attentionArgs: Story['args'] = {
  run: { ...live, attention: 'Banjo stopped without finishing this run.' },
};
/** Live, but its agent stopped without finishing: why, in the paused note's warn rule (AP-597). */
export const NeedsAttention: Story = { name: 'Needs attention', args: attentionArgs };
export const NeedsAttentionDark: Story = { ...dark, name: 'Needs attention (dark)', args: attentionArgs };

/** The Take over confirmation, in the approval modal's language. */
export const TakeOverConfirm: StoryObj<typeof TakeOverDialog> = {
  name: 'Take over (confirm)',
  render: () => (
    <TakeOverDialog
      open
      onOpenChange={() => {}}
      agent={{ name: dusty.name, face: dusty.face }}
      branch={live.branch}
      onConfirm={() => {}}
    />
  ),
};
export const TakeOverConfirmDark: StoryObj<typeof TakeOverDialog> = {
  ...TakeOverConfirm,
  ...dark,
  name: 'Take over (confirm, dark)',
};
