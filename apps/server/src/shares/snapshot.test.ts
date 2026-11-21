import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { FileStore } from '../files/store';
import { buildSnapshot, type ShareThread } from './snapshot';

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const PAGE = '<!doctype html><title>Chart</title><p>bars</p>';

const store = {
  open: async (key: string) => Readable.from([key === 'png' ? PNG : Buffer.from(PAGE)]),
} as unknown as FileStore;

const row = (text: string, at: number) =>
  ({ id: `msg_${at}`, text, createdAt: new Date(at) }) as unknown as ShareThread['shown'][number]['row'];
const file = (blobKey: string, contentType: string, name: string) =>
  ({ blobKey, contentType, name, size: 10 }) as unknown as ShareThread['shown'][number]['pictures'][number];

const thread: ShareThread = {
  conversationId: 'cnv_1',
  rootId: 'msg_1',
  title: 'Holiday plans',
  person: { name: 'Mara' },
  assistant: { name: 'Dusty', face: 'dusty' },
  shown: [
    {
      row: row('Here is the beach', 1),
      from: 'person',
      pictures: [file('png', 'image/png', 'beach.png')],
      pages: [],
    },
    {
      row: row('Prices by month', 2),
      from: 'assistant',
      pictures: [],
      pages: [file('page', 'text/html', 'chart.html')],
    },
    { row: row('', 3), from: 'person', pictures: [file('png', 'image/png', 'only.png')], pages: [] },
  ],
  leftOut: 0,
};

describe('the copy a link shows', () => {
  it('keeps pictures and the assistant’s pages, with the names readers see', async () => {
    const { snapshot, pictures } = await buildSnapshot(thread, store, { pictures: true, now: new Date(9) });
    expect(pictures).toBe(2);
    expect(snapshot.messages).toHaveLength(3);
    expect(snapshot.messages[0]?.pictures).toEqual(['p1']);
    expect(snapshot.messages[1]?.pages?.[0]?.html).toContain('bars');
    expect(snapshot.pictures[0]).toMatchObject({ id: 'p1', mime: 'image/png' });
  });

  it('leaves pictures out when asked, and a message that was only a picture with them', async () => {
    const { snapshot, pictures } = await buildSnapshot(thread, store, { pictures: false, now: new Date(9) });
    expect(pictures).toBe(0);
    expect(snapshot.pictures).toEqual([]);
    expect(snapshot.messages.map((m) => m.text)).toEqual(['Here is the beach', 'Prices by month']);
  });
});
