import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';

const net = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../connections/http', () => ({ signedConnectionFetch: net.fetch }));
// The write's effect runs as it is: what these tests read is how its answer is judged.
vi.mock('../../commit/scope', () => ({ externalEffect: (_name: string, run: () => unknown) => run() }));

const { actAs, writeDone } = await import('./act');
const { restartHomeAssistant } = await import('./homeassistant-restart');
const { accessWrite } = await import('./home/access');

const services = {} as Services;
const row = {
  id: 'con_1',
  label: 'Home',
  baseUrl: 'https://example.com',
  catalogId: 'homeassistant',
  fields: { url: 'https://example.com' },
} as unknown as CatalogConnectionRow;
const answer = (status: number, body = '{}') => ({ status, headers: {}, body: Buffer.from(body) });

beforeEach(() => net.fetch.mockReset());

describe('a page action’s write', () => {
  it('is done only on a 2xx', () => {
    expect([200, 201, 204, 299].every(writeDone)).toBe(true);
    expect([101, 199, 300, 301, 302, 303, 307, 308, 400, 500].some(writeDone)).toBe(false);
  });

  it('never counts a redirect as done', async () => {
    for (const status of [301, 302, 303, 307]) {
      net.fetch.mockResolvedValueOnce(answer(status, ''));
      await expect(actAs(services, row, 'Plex', { method: 'POST', path: '/act' })).rejects.toMatchObject({
        message: expect.stringContaining('didn’t confirm'),
      });
    }
    net.fetch.mockResolvedValueOnce(answer(204, ''));
    await expect(actAs(services, row, 'Plex', { method: 'POST', path: '/act' })).resolves.toMatchObject({
      status: 204,
    });
  });

  it('says Home Assistant restarts only when it said so with a 2xx', async () => {
    const ctx = { services, row } as Parameters<typeof restartHomeAssistant>[0];
    net.fetch.mockResolvedValueOnce(answer(302, ''));
    await expect(restartHomeAssistant(ctx, {})).rejects.toMatchObject({
      message: expect.stringContaining('didn’t confirm the restart'),
    });
    net.fetch.mockResolvedValueOnce(answer(200, '[]'));
    await expect(restartHomeAssistant(ctx, {})).resolves.toMatchObject({ title: expect.any(String) });
  });

  it('unlocks a UniFi Access door only on a 2xx with its SUCCESS code', async () => {
    net.fetch.mockResolvedValueOnce(answer(302, ''));
    await expect(accessWrite(services, row, '/doors/d1/unlock', {})).rejects.toMatchObject({
      message: expect.stringContaining('didn’t confirm'),
    });
    net.fetch.mockResolvedValueOnce(answer(303, '{"code":"SUCCESS"}'));
    await expect(accessWrite(services, row, '/doors/d1/unlock', {})).rejects.toMatchObject({
      message: expect.stringContaining('didn’t confirm'),
    });
    net.fetch.mockResolvedValueOnce(answer(200, '{"code":"SUCCESS"}'));
    await expect(accessWrite(services, row, '/doors/d1/unlock', {})).resolves.toBeUndefined();
  });
});
