/** The previews a turn's runner is asked for: a folder (browser_preview) or a page (page_preview). */
import { describe, expect, it } from 'vitest';
import { PreviewBroker } from './previews';

const SHOT = { png: 'iVBORw0KGgo=', title: 'Sales', found: null, height: 243, console: [], blocked: 0 };

describe('PreviewBroker', () => {
  it('asks for a page without a folder and answers with its screenshot alone', async () => {
    const broker = new PreviewBroker();
    const answer = broker.requestPage('dsp_1', { html: '<p>x</p>', width: 720 }, 5_000);
    const [asked] = broker.forRunner('dsp_1');
    expect(asked).toMatchObject({ page: { html: '<p>x</p>', width: 720 }, render: { online: false } });
    expect(asked?.dir).toBeUndefined();
    expect(broker.forRunner('dsp_2')).toEqual([]);
    expect(broker.fulfil('dsp_1', asked?.id as string, { files: [], shot: SHOT })).toBe(true);
    expect(await answer).toEqual({ files: [], shot: SHOT });
  });

  it('passes on a runner’s refusal of a page', async () => {
    const broker = new PreviewBroker();
    const answer = broker.requestPage('dsp_1', { html: '<p>x</p>', width: 360 }, 5_000);
    const id = broker.forRunner('dsp_1')[0]?.id as string;
    broker.fulfil('dsp_1', id, { error: 'No browser.' });
    expect(await answer).toEqual({ error: 'No browser.' });
  });

  it('still refuses an empty folder', async () => {
    const broker = new PreviewBroker();
    const answer = broker.request('dsp_1', 'dist', undefined, 5_000);
    const [asked] = broker.forRunner('dsp_1');
    expect(asked?.dir).toBe('dist');
    broker.fulfil('dsp_1', asked?.id as string, { files: [] });
    expect('error' in (await answer)).toBe(true);
  });
});
