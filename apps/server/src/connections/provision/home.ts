/**
 * Sign in once for Proxmox VE, Proxmox Backup Server, Home Assistant, Nextcloud, Paperless-ngx and Immich
 * (docs/decisions/connections-setup.md CS-20…CS-25).
 */
import { provisionHomeAssistant } from './homeassistant';
import { provisionImmich } from './immich';
import { provisionNextcloud } from './nextcloud';
import { provisionPaperless } from './paperless';
import { provisionProxmoxBackup, provisionProxmoxVe } from './proxmox';
import type { Provisioner } from './types';

export const HOME_PROVISIONERS: Readonly<Record<string, Provisioner>> = {
  proxmox: provisionProxmoxVe,
  proxmox_backup: provisionProxmoxBackup,
  homeassistant: provisionHomeAssistant,
  nextcloud: provisionNextcloud,
  paperless: provisionPaperless,
  immich: provisionImmich,
};
