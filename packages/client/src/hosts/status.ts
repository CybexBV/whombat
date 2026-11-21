/**
 * Whether this Whombat runs the hosts service, on its own: the web shell's sidebar reads only this, and importing it from
 * `./react` would put every server page's hook and helper in the page's first download.
 */
import { api } from '@whombat/core/contracts';
import { queryHook } from '../react/queries';

/** Whether this Whombat runs the hosts service, where agents dial in, whether the viewer may change servers. */
export const useHostsStatus = queryHook(api.hosts.status);
