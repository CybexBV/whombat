# What runtime-live-turn needs beside the real bundle (NX-75):
#
#   world        live-turn/world.ts bundled from the runtime's source (the runtime derivation's source and pnpm
#                store; esbuild with the release bundles' options): seeds the server's integration-test world and
#                commits one message to an agent through the commit pipeline. VM tests only; never in an image.
#   fakeClaude   live-turn/fake-claude.js: Claude Code's stream-JSON protocol for one turn, replying with what it saw
#                of its sandbox. Installed by the test where the manager installs clients.
{ pkgs, lib }:
let
  runtime = pkgs.whombat-runtime;
  nodejs = runtime.nodejs;
  pnpm = pkgs.pnpm_12.override { nodejs-slim = nodejs; };
in
{
  world = pkgs.stdenv.mkDerivation {
    pname = "whombat-vmtest-world";
    inherit (runtime)
      version
      src
      pnpmDeps
      patches
      ;
    # The runtime's pnpm store holds only its own packages and the web app's (nix/packages/runtime): installing the whole
    # workspace from it failed offline on the mobile app's (expo-build-properties). The world is the server's code.
    pnpmWorkspaces = runtime.pnpmWorkspaces or [ ];
    nativeBuildInputs = [
      nodejs
      pnpm
      pkgs.pnpmConfigHook
      pkgs.makeBinaryWrapper
    ];
    buildPhase = ''
      runHook preBuild
      cp ${./live-turn/world.ts} apps/server/src/vmtest-world.ts
      # The release bundles' options (scripts/package/src/build.ts bundleOptions); WHOMBAT_APP_DIR is the runtime's.
      cat > build-world.mjs <<'JS'
      import * as esbuild from 'esbuild';
      await esbuild.build({
        absWorkingDir: process.env.SRC_ROOT,
        entryPoints: ['apps/server/src/vmtest-world.ts'],
        outfile: process.env.OUT_FILE,
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'esm',
        external: ['@embedded-postgres/*', '@anthropic-ai/claude-code-*', 'node-pty'],
        // The bundle's own file and directory for CommonJS that reads `__filename` / `__dirname` at load (ssh2's agent
        // module): a bare ESM bundle stops there with ERR_AMBIGUOUS_MODULE_SYNTAX (NX-437).
        banner: {
          js: [
            "import { createRequire as __wbCreateRequire } from 'node:module';",
            "import { fileURLToPath as __wbFileURLToPath } from 'node:url';",
            "import { dirname as __wbDirname } from 'node:path';",
            'const require = __wbCreateRequire(import.meta.url);',
            'const __wbModuleFile = __wbFileURLToPath(import.meta.url);',
            'const __wbModuleDir = __wbDirname(__wbModuleFile);',
            `process.env.WHOMBAT_APP_DIR = ''${JSON.stringify(process.env.APP_DIR)};`,
          ].join('\n'),
        },
        define: {
          __WHOMBAT_BUILD__: JSON.stringify({ version: 'vmtest', gitSha: process.env.GIT_SHA, buildTime: '1970-01-01T00:00:00.000Z' }),
          __filename: '__wbModuleFile',
          __dirname: '__wbModuleDir',
        },
        legalComments: 'none',
        charset: 'utf8',
        logLevel: 'warning',
      });
      JS
      mkdir -p $out/lib
      cp build-world.mjs scripts/package/build-world.mjs
      (cd scripts/package && SRC_ROOT=$PWD/../.. OUT_FILE=$out/lib/world.mjs APP_DIR=${runtime} GIT_SHA=${runtime.passthru.stamp.rev} node build-world.mjs)
      runHook postBuild
    '';
    installPhase = ''
      makeWrapper ${lib.getExe nodejs} $out/bin/whombat-vmtest-world --add-flags $out/lib/world.mjs
    '';
    disallowedReferences = [
      pnpm
      runtime.pnpmDeps
    ];
  };

  fakeClaude = pkgs.runCommand "fake-claude" { } ''
    install -Dm0555 ${./live-turn/fake-claude.js} $out/claude
  '';
}
