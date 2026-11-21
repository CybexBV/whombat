/** Entry point of `whombat` (`pnpm whombat …` in a checkout, `app/cli.mjs` in the runtime bundle). */
import { main } from './main';

const code = await main(process.argv.slice(2));
// Pipes and files are written synchronously on Linux, so nothing printed is lost.
process.exit(code);
