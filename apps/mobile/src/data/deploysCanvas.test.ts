/**
 * Deploys and the canvas screen (mobile-parity.md MQ-05, MQ-07; work-removal-android.md AP-858) over the fixture
 * world's five deployments and its canvases: what is live where (with the failed attempt and the rollback target), the
 * history's lines, a deploy's detail, and a canvas's header and load problems.
 */
import { ApiError } from '@whombat/client';
import { CANVASES, DEPLOYMENTS, deploymentEnvironments, SEED_NOW } from '@whombat/fixtures';
import { describe, expect, it } from 'vitest';
import { worldContext } from '../test/world';
import { CANVAS_TEXT, canvasMeta, canvasProblem } from './canvas';
import { DEPLOYS_TEXT, deployBoard, deployDetail, deployHistory, deployTone } from './deploys';

const ctx = worldContext();

describe('Deploys (MQ-07)', () => {
  it('shows what is live where, with a newer failed attempt and what a rollback goes back to', () => {
    const board = deployBoard(deploymentEnvironments().environments, ctx);
    const production = board.find((e) => e.environment === 'production');
    expect(production?.label).toMatch(/^PRODUCTION · /);
    const api = production?.services.find((s) => s.service === 'api');
    expect(api?.current).toMatchObject({ pill: 'DEPLOYED', tone: 'ok' });
    expect(api?.failed).toMatchObject({ pill: 'FAILED', tone: 'bad' });
    expect(api?.previous).not.toBeNull();
    expect(api?.accessibilityLabel).toContain(DEPLOYS_TEXT.failedAttempt);
    // Who, when, how and the commit.
    expect(api?.current?.meta).toMatch(/^Dusty · .+ · GitHub Actions · [0-9a-f]{6}$/);
    expect(board.flatMap((e) => e.services.map((s) => s.key))).toContain('production/web');
  });

  it('lists the history newest first, each with its one line and pill', () => {
    const rows = deployHistory(DEPLOYMENTS, ctx);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ id: 'dpl_api-prod-3', pill: 'FAILED', tone: 'bad' });
    expect(rows[0]?.title).toMatch(/^Deploy of api to production failed · [0-9a-f]{6}$/);
    expect(rows.find((r) => r.deployment.how === 'ssh')?.meta).toContain('SSH');
    expect(deployTone('succeeded')).toBe('ok');
  });

  it('opens a deploy with its facts, summary and where it was posted', () => {
    const failed = DEPLOYMENTS[0];
    if (!failed) throw new Error('fixture deploy');
    const detail = deployDetail(failed, ctx);
    expect(detail.facts.map((f) => f.label)).toEqual([
      'ENVIRONMENT',
      'SERVICE',
      'HOW',
      'REPO',
      'REF',
      'COMMIT',
      'BY',
      'WHEN',
    ]);
    expect(detail.summary).toMatch(/timed out/);
    expect(detail.conversationId).toBe(failed.conversationId);
  });
});

describe('a canvas on the phone (MQ-05)', () => {
  it('says who started it and when it changed', () => {
    const canvas = CANVASES[0];
    if (!canvas) throw new Error('fixture canvas');
    const meta = canvasMeta({ canvas, updatedAt: SEED_NOW.toISOString() }, ctx);
    expect(meta).toMatch(/^Started by .+ · updated /);
    const unknown = { ...canvas, provenance: { ...canvas.provenance, createdById: 'prn_nobody' } };
    expect(canvasMeta({ canvas: unknown, updatedAt: SEED_NOW.toISOString() }, ctx)).toMatch(/^Updated /);
  });

  it('says a gone canvas is gone, and offers Try again for the rest', () => {
    expect(canvasProblem(new ApiError(404, 'not_found', 'No canvas', {}, 'canvases.content'))).toEqual({
      text: CANVAS_TEXT.gone,
      retry: false,
    });
    expect(canvasProblem(new Error('offline'))).toEqual({ text: CANVAS_TEXT.loadFailed, retry: true });
  });
});
