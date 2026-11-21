import { describe, expect, it } from 'vitest';
import { createFakeBackupLook } from './fake-backup-look';

describe('the fake backup look (web fixtures, the phone’s demo)', () => {
  it('opens after a while, lists and searches, and brings back only what isn’t here', async () => {
    let now = 1_000_000;
    const look = createFakeBackupLook({ now: () => now, openMs: 1000 });
    const opened = (await look.call('backup.look', { checkpointId: 'cp_1' }))?.body as {
      lookId: string;
      state: string;
    };
    expect(opened.state).toBe('opening');
    now += 1500;
    const ready = (await look.call('backup.lookContents', { lookId: opened.lookId }))?.body as {
      look: { state: string };
      categories: { id: string; count: number }[];
    };
    expect(ready.look.state).toBe('ready');
    expect(ready.categories.find((c) => c.id === 'messages')?.count).toBe(3);
    const roof = (
      await look.call('backup.lookContents', { lookId: opened.lookId, category: 'messages', query: 'roof' })
    )?.body as { items: { id: string }[] };
    expect(roof.items).toHaveLength(1);
    const brought = (
      await look.call('backup.lookBring', {
        lookId: opened.lookId,
        items: [roof.items[0]?.id, 'thread:msg_invoice'],
      })
    )?.body as { look: { bring: { back: number; already: number } } };
    expect(brought.look.bring).toMatchObject({ back: 1, already: 1 });
    expect(look.call('desk.get', {})).toBeNull();
  });
});
