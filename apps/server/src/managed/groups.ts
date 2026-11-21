/** Unix groups for the runtime's local files and sockets (MR-15, MR-52). */
import { readFileSync } from 'node:fs';

/** A group's id from `/etc/group` (Node has no getgrnam), or null. */
export function groupId(name: string, file = '/etc/group'): number | null {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const [group, , gid] = line.split(':');
      if (group === name && gid && /^\d+$/.test(gid)) return Number(gid);
    }
  } catch {
    // no /etc/group
  }
  return null;
}
