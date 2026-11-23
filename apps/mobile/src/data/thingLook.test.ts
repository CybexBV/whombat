/** A thing's glyph on the phone: Website feedback's bubble, the shared glyph for the rest. */
import { describe, expect, it } from 'vitest';
import { phoneThingGlyph } from './thingLook';

describe('a thing’s glyph', () => {
  it('draws Website feedback’s bubble, by its entry or its icon', () => {
    expect(phoneThingGlyph({ kind: 'connection', icon: 'feedback', catalogId: 'feedback' })).toBe('message');
    expect(phoneThingGlyph({ kind: 'connection', icon: 'feedback' })).toBe('message');
  });

  it('keeps the shared glyph for everything else', () => {
    expect(phoneThingGlyph({ kind: 'connection', icon: 'mail', catalogId: 'google_mail' })).toBe('mail');
    expect(phoneThingGlyph({ kind: 'server', icon: 'proxmox' })).toBe('server');
    expect(phoneThingGlyph({ kind: 'connection', icon: 'github', catalogId: 'github' })).toBe('plug');
  });
});
