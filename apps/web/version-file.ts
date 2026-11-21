/**
 * `version.json` at the web root (AP-259; hermes-engine-app.md AP-5327): what this build is, for the release pipeline's
 * client-floor check (`promote-prod` reads `https://app.whombat.com/version.json`):
 *
 *   { "version": "1.0.0", "build": "1.0.0+1a2b3c4", "buildNumber": 1000000, "protocol": 2, "contracts": "1.0.0" }
 *
 * `buildNumber` is what `hello.client.buildNumber` carries (a box's security floor compares it); `protocol` is the
 * session protocol major it speaks (`SESSION_PROTOCOL.major`: a box on another major refuses it, CT-1260); `contracts`
 * is the contracts version. Every build writes it (the static host serves it with `no-cache`); `vite dev`
 * answers it too.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export interface VersionInfo {
  version: string;
  build: string;
  buildNumber: number;
  protocol: number;
  contracts: string;
}

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The contracts version the build is made of: the version of the workspace's `@whombat/protocol`. */
export function contractsVersion(root = ROOT): string {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'packages/protocol/package.json'), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The session protocol major the build speaks. Vite loads its config with Node before it compiles anything, and Node
 * alone can't load the contracts' sources (their `.js` specifiers name `.ts` files), so tsx imports them.
 */
async function sessionMajor(): Promise<number> {
  const { tsImport } = await import('tsx/esm/api');
  const protocol = (await tsImport(
    '@whombat/protocol/session',
    import.meta.url,
  )) as typeof import('@whombat/protocol/session');
  return protocol.SESSION_PROTOCOL.major;
}

export function versionFile(input: Pick<VersionInfo, 'version' | 'build' | 'buildNumber'>): Plugin {
  let info: VersionInfo | null = null;
  const load = async (): Promise<VersionInfo> => {
    info ??= { ...input, protocol: await sessionMajor(), contracts: contractsVersion() };
    return info;
  };
  return {
    name: 'whombat-version-file',
    async generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: `${JSON.stringify(await load(), null, 2)}\n`,
      });
    },
    configureServer(server) {
      server.middlewares.use('/version.json', (_req, res) => {
        void load().then((v) => {
          res.setHeader('content-type', 'application/json');
          res.setHeader('cache-control', 'no-cache');
          res.end(JSON.stringify(v));
        });
      });
    },
  };
}
