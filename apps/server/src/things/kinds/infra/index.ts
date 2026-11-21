/** The infra services' kinds (service-dashboards.md; brief `docs/implementation/service-dashboards/assignment.md`). */
import type { KindModule } from '../registry';
import { CLOUDFLARE_KIND } from './cloudflare';
import { GRAFANA_KIND } from './grafana';
import { NPM_KIND } from './nginx-proxy-manager';
import { OPNSENSE_KIND } from './opnsense';
import { PORTAINER_KIND } from './portainer';
import { PTERODACTYL_KIND } from './pterodactyl';
import { TAILSCALE_KIND } from './tailscale';

export const INFRA_KINDS: Record<string, KindModule> = {
  cloudflare: CLOUDFLARE_KIND,
  grafana: GRAFANA_KIND,
  nginx_proxy_manager: NPM_KIND,
  opnsense: OPNSENSE_KIND,
  portainer: PORTAINER_KIND,
  pterodactyl: PTERODACTYL_KIND,
  tailscale: TAILSCALE_KIND,
};
