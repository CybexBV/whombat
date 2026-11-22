/**
 * `services.google` (docs/decisions/connectors.md CN-08): the OAuth adapter, the Workspace adapter and the
 * token store for `WHOMBAT_GOOGLE=real|fake|off`. Each part comes from its own factory file so the streams
 * that implement them (connections: oauth.ts + tokens.ts; Google tools: workspace.ts) do not touch this one.
 */
import type { Services } from '../services';
import { createGoogleOAuth } from './oauth';
import { createConnectionTokens } from './tokens';
import type { GoogleServices } from './types';
import { createGoogleWorkspace } from './workspace';

export function createGoogleServices(services: Services): GoogleServices {
  const mode = services.config.WHOMBAT_GOOGLE;
  const oauth = createGoogleOAuth(mode);
  return {
    mode,
    oauth,
    workspace: createGoogleWorkspace(mode, services.clock),
    tokens: createConnectionTokens(services, oauth),
  };
}
