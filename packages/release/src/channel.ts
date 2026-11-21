/**
 * Update channels (4.4; Whombat whombat-link.md): every box takes the newest release of its channel. `production` is the
 * default; `development` gets builds first. A root-owned helper setting the manager changes only on the owner's word;
 * moving from development to production never goes back: the box keeps its release until production passes it.
 */
import { z } from 'zod';

export const UPDATE_CHANNELS = ['production', 'development'] as const;
export const UpdateChannel = z.enum(UPDATE_CHANNELS);
export type UpdateChannel = z.infer<typeof UpdateChannel>;
export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'production';
