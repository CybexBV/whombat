/** Whose task an id is (a package task is the host's; a Proxmox UPID, the default, is `pve`). */
export const taskPlatform = (task: string): 'pve' | 'incus' | 'unraid' | 'libvirt' | 'host' => {
  const kind = /^(incus|unraid|libvirt|pkg):/.exec(task)?.[1];
  return kind === 'pkg' ? 'host' : ((kind as 'incus' | 'unraid' | 'libvirt' | undefined) ?? 'pve');
};
