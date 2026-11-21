/** The fake ACP agent's path, for the Hermes provider's tests (`fake-agent.mjs` lists its `FAKE_ACP_MODE` flags). */
import { fileURLToPath } from 'node:url';

export const FAKE_ACP_AGENT = fileURLToPath(new URL('./fake-agent.mjs', import.meta.url));
