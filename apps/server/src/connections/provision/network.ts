/**
 * Sign in once for UniFi OS (Network and Protect), OPNsense, Unraid, Portainer, Grafana and Forgejo / Gitea
 * (docs/decisions/connections-setup.md CS-30…CS-35).
 */
import { provisionForgejo } from './forgejo';
import { provisionGrafana } from './grafana';
import { provisionOpnsense } from './opnsense';
import { provisionPortainer } from './portainer';
import type { Provisioner } from './types';
import { provisionUnifi } from './unifi';
import { provisionUnraid } from './unraid';

export const NETWORK_PROVISIONERS: Readonly<Record<string, Provisioner>> = {
  // One key serves both (CS-30).
  unifi_network: provisionUnifi,
  unifi_protect: provisionUnifi,
  opnsense: provisionOpnsense,
  unraid: provisionUnraid,
  portainer: provisionPortainer,
  grafana: provisionGrafana,
  forgejo: provisionForgejo,
};
