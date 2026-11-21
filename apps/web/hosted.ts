/**
 * The page's hardening (AP-23; both builds, hermes-engine-app.md AP-5322 — the hosted app and the box's own page):
 *
 * - no inline script: the theme no-flash snippet becomes `/theme-init.js`;
 * - no third-party requests: the fonts are the app's own copy (every build since WE-05, `src/app/fonts/fonts.css`);
 * - a strict Content-Security-Policy as a `<meta>` (everything a meta can carry) and in `_headers` (for the static
 *   host; adds `frame-ancestors` and the other security headers a meta can't set). `connect-src` is only the
 *   control API, the relay and a box's Tailscale name (its direct socket, HE-50); images may be `blob:` (decrypted attachments) and `data:`, audio and video only
 *   `blob:`; no `eval`, no objects, no analytics or session replay of any kind. The only frames are this origin's
 *   own: the HTML preview frame (`/sandbox/html-frame.html`, AP-320), which `_headers` gives its own policy.
 */
import type { Plugin } from 'vite';
import { contentSecurityPolicy, PAGE_POLICY } from '../../packages/core/src/text/page';

export interface HostedOptions {
  controlUrl: string;
  /** Relay origins (`wss://relay.whombat.com`, `wss://*.relay.whombat.com`). */
  relayOrigins: readonly string[];
  noFlashScript: string;
  /**
   * The box's own page (HE-50; hermes-engine-app.md AP-5322): it talks only to its own origin's direct socket
   * (`connect-src 'self'`), and the box sends the headers itself, so no `_headers` file.
   */
  box?: boolean;
}

export { contentSecurityPolicy, TAILSCALE_SOCKETS } from '../../packages/core/src/text/page';

/**
 * The HTML preview frame's policy (AP-320; the `/sandbox/*` block of `_headers`, and the meta in
 * `public/sandbox/html-frame.html` without `frame-ancestors`): an agent's page runs inline scripts and styles
 * with embedded assets only. Remote resource requests can leak the page's contents in their URLs.
 * The frame is also `sandbox="allow-scripts"` (an opaque origin: no cookies, storage or access to the app; no
 * popups, forms, downloads or top navigation). `'self'` loads the frame's own script and the Mermaid runtime.
 */
export function sandboxContentSecurityPolicy(forHeader: boolean): string {
  return forHeader ? `${PAGE_POLICY}; frame-ancestors 'self'` : PAGE_POLICY;
}

/**
 * Dev and preview servers (every mode): `/sandbox/*` answers with the frame's policy, as the hosted static host does,
 * so development sees what production enforces. The legacy server serves the same files; the frame's own meta policy
 * applies there.
 */
export function sandboxHeaders(): Plugin {
  const apply = (server: { middlewares: { use: (fn: SandboxMiddleware) => void } }) => {
    server.middlewares.use((req, res, next) => {
      if (req.url?.startsWith('/sandbox/')) {
        res.setHeader('Content-Security-Policy', sandboxContentSecurityPolicy(true));
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
      }
      next();
    });
  };
  return { name: 'whombat-sandbox-headers', configureServer: apply, configurePreviewServer: apply };
}

type SandboxMiddleware = (
  req: { url?: string },
  res: { setHeader: (name: string, value: string) => void },
  next: () => void,
) => void;

export function hostedHardening(options: HostedOptions): Plugin {
  return {
    name: 'whombat-hosted-hardening',
    apply: 'build',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        if (/fonts\.(googleapis|gstatic)\.com/.test(html))
          throw new Error('hosted build: a Google Fonts link is left');
        const stripped = html
          // The no-flash snippet as a file (vite.config's themeNoFlash adds it inline for other builds).
          .replace(/<script>[\s\S]*?<\/script>/, '<script src="/theme-init.js"></script>');
        if (/<script>(?!\s*<\/script>)/.test(stripped))
          throw new Error('hosted build: an inline <script> is left');
        // The policy first, so it governs everything after it (the theme script included).
        return stripped
          .replace('<script src="/theme-init.js"></script>', '')
          .replace(
            '<meta charset="UTF-8" />',
            `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(options, false)}" />\n    <meta name="referrer" content="no-referrer" />\n    <script src="/theme-init.js"></script>`,
          );
      },
    },
    generateBundle() {
      // Runs before any module: the theme (no flash) and zod's jitless mode, so no schema ever probes `new Function`
      // under a CSP without 'unsafe-eval' (zod reads globalThis.__zod_globalConfig).
      this.emitFile({
        type: 'asset',
        fileName: 'theme-init.js',
        source: `${options.noFlashScript}\nglobalThis.__zod_globalConfig = Object.assign(globalThis.__zod_globalConfig || {}, { jitless: true });\n`,
      });
      if (options.box) return;
      this.emitFile({
        type: 'asset',
        fileName: '_headers',
        source: [
          '/*',
          `  Content-Security-Policy: ${contentSecurityPolicy(options, true)}`,
          '  X-Content-Type-Options: nosniff',
          '  Referrer-Policy: no-referrer',
          '  Cross-Origin-Opener-Policy: same-origin',
          // The microphone for voice typing, on the app's own pages only (docs/decisions/dictation.md).
          '  Permissions-Policy: camera=(), microphone=(self), geolocation=(), payment=()',
          '  Strict-Transport-Security: max-age=63072000; includeSubDomains',
          // The HTML preview frame (AP-320): its values replace the `/*` ones (appliance IN-121).
          '/sandbox/*',
          `  Content-Security-Policy: ${sandboxContentSecurityPolicy(true)}`,
          '',
        ].join('\n'),
      });
    },
  };
}
