/** Whose task an id is (a package or app task is the host's; a Proxmox UPID, the default, is `pve`). */
export const taskPlatform = (task: string): 'pve' | 'incus' | 'unraid' | 'libvirt' | 'host' => {
  const kind = /^(incus|unraid|libvirt|pkg|app):/.exec(task)?.[1];
  return kind === 'pkg' || kind === 'app'
    ? 'host'
    : ((kind as 'incus' | 'unraid' | 'libvirt' | undefined) ?? 'pve');
};
