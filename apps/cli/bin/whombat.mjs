#!/usr/bin/env node
// `whombat` from a checkout (`pnpm whombat …`): the CLI is TypeScript, loaded through tsx. The runtime bundle runs
// its esbuild bundle `app/cli.mjs` instead.
import { register } from 'tsx/esm/api';

register();
await import('../src/bin.ts');
