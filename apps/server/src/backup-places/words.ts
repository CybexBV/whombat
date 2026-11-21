/**
 * The places' words for people (docs/decisions/backup-places.md): core's `BACKUP_PLACE_TEXT`, with the hosts service's
 * reason codes mapped to its sentences.
 */
import { BACKUP_PLACE_TEXT } from '@whombat/core';

const R = BACKUP_PLACE_TEXT.reasons;

export const placeWords = {
  /** A server's reason it can't keep backups (`no_docker`, `docker_down`, `array_stopped`, `self`), as a sentence. */
  reason(code: string | null): string {
    switch (code) {
      case 'no_docker':
        return R.noDocker;
      case 'docker_down':
        return R.dockerDown;
      case 'array_stopped':
        return R.arrayStopped;
      case 'self':
        return R.self;
      case 'nfs_off':
        return R.nfsOff;
      case 'agent_too_old':
        return R.helperOld;
      default:
        return R.other;
    }
  },
  helperOld: R.helperOld,
  noAddress: R.noAddress,
} as const;
