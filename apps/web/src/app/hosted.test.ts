import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, sandboxContentSecurityPolicy } from '../../hosted';

const OPTIONS = { controlUrl: 'https://api.whombat.com', relayOrigins: ['wss://relay.whombat.com'] };
const directives = (policy: string) =>
  Object.fromEntries(policy.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]));

describe('the hosted CSP (AP-23, AP-320, AP-326)', () => {
  it('allows only this origin’s frames and object URLs for media, nothing wider', () => {
    const app = directives(contentSecurityPolicy(OPTIONS, true));
    expect(app['frame-src']).toBe("'self'");
    expect(app['media-src']).toBe('blob:');
    expect(app['object-src']).toBe("'none'");
    expect(app['script-src']).toBe("'self'");
    expect(app['style-src']).toBe("'self'");
    expect(app['frame-ancestors']).toBe("'none'");
  });

  it('reaches control, the relay and a box’s Tailscale name; the box’s own page only its own origin', () => {
    expect(directives(contentSecurityPolicy(OPTIONS, true))['connect-src']).toBe(
      'https://api.whombat.com wss://relay.whombat.com wss://*.ts.net:*',
    );
    const box = directives(contentSecurityPolicy({ ...OPTIONS, box: true }, true));
    expect(box['connect-src']).toBe("'self'");
    expect(box['upgrade-insecure-requests']).toBeUndefined();
  });

  it('lets the preview frame run scripts with embedded assets only', () => {
    const frame = directives(sandboxContentSecurityPolicy(true));
    expect(frame).toEqual({
      'default-src': "'none'",
      'script-src': "'self' 'unsafe-inline' data:",
      'style-src': "'unsafe-inline'",
      'img-src': 'data: blob:',
      'font-src': 'data:',
      'media-src': 'data: blob:',
      'connect-src': "'none'",
      'form-action': "'none'",
      'frame-src': "'none'",
      'base-uri': "'none'",
      'frame-ancestors': "'self'",
    });
    expect(sandboxContentSecurityPolicy(false)).not.toContain('frame-ancestors');
  });

  it('is the policy the static frame page carries as a meta', () => {
    const page = readFileSync(resolve(import.meta.dirname, '../../public/sandbox/html-frame.html'), 'utf8');
    expect(page).toContain(`content="${sandboxContentSecurityPolicy(false)}"`);
    expect(page).toContain('<script src="/sandbox/html-frame.js"></script>');
  });
});
