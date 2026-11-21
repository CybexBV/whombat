import { render, waitFor } from '@testing-library/react';
import type { ApplianceSession } from '@whombat/client/session';
import type { ObjectUrlCache, ObjectUrlEntry } from '@whombat/client/web';
import { describe, expect, it, vi } from 'vitest';
import { AttachmentSourceProvider } from './attachmentSource';
import { PersonAvatar } from './PersonAvatar';

const PHOTO = '/api/v1/burrows/hq/attachments/att_photo';

/** A resource cache holding what `get` loaded, as the real one does. */
function cache() {
  const held = new Map<string, ObjectUrlEntry>();
  const get = vi.fn(async (ref: { attachmentId: string }) => {
    const entry = { url: `blob:${ref.attachmentId}`, size: 10, meta: {} } as ObjectUrlEntry;
    held.set(ref.attachmentId, entry);
    return entry;
  });
  const resources = {
    get,
    peek: (ref: { attachmentId: string }) => held.get(ref.attachmentId),
    size: () => 0,
    clear: () => held.clear(),
  } as unknown as ObjectUrlCache;
  return { resources, get };
}

describe('<PersonAvatar> (PA-03)', () => {
  it('draws the initials without a photo', () => {
    const { container } = render(<PersonAvatar initials="MO" tone="#d9c3a9" size={32} label="Mara Okafor" />);
    expect(container.textContent).toBe('MO');
    expect(container.querySelector('img')).toBeNull();
  });

  it('legacy: the photo’s URL is the src', () => {
    const { container } = render(<PersonAvatar initials="MO" avatarUrl={PHOTO} size={32} />);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(PHOTO);
  });

  it('managed: streamed once through the session, then drawn at once from the cache', async () => {
    const { resources, get } = cache();
    const value = { mode: 'session' as const, session: {} as ApplianceSession, resources };
    const first = render(
      <AttachmentSourceProvider value={value}>
        <PersonAvatar initials="MO" avatarUrl={PHOTO} size={32} />
      </AttachmentSourceProvider>,
    );
    // The initials while it loads.
    expect(first.container.querySelector('img')).toBeNull();
    await waitFor(() =>
      expect(first.container.querySelector('img')?.getAttribute('src')).toBe('blob:att_photo'),
    );
    const again = render(
      <AttachmentSourceProvider value={value}>
        <PersonAvatar initials="MO" avatarUrl={PHOTO} size={20} />
      </AttachmentSourceProvider>,
    );
    expect(again.container.querySelector('img')?.getAttribute('src')).toBe('blob:att_photo');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
