/**
 * The box's hardware report (docs/decisions/hardware-support.md HD-03; hardware-support-server.md HD-S02): the manager
 * collects it when asked — sysfs and procfs, names from hwdata, the kernel's firmware and driver errors — and the runtime
 * hands it to the person as it is (`host.hardware`). Nothing of it is kept here or in Postgres.
 *
 * A manager that doesn't answer within 10 s, answers 404 (before 0.102) or answers what the contract doesn't allow makes
 * the report `unavailable`, never an error, logged at most once a minute.
 */
import { MANAGER_PATHS } from '@whombat/control-contracts/local';
import type { HostHardwareOutput } from '@whombat/protocol/session';
import { ApiError } from '../lib/errors';
import type { Services } from '../services';
import { ManagerWarnings, withinMs } from './host-calls';
import { HOST_HARDWARE_TIMEOUT_MS } from './manager-client';
import type { ManagerPort } from './ports';
import type { SessionPrincipal } from './trust';

export class HostHardwareService {
  readonly #warnings: ManagerWarnings;

  constructor(
    services: Services,
    private readonly manager: ManagerPort,
  ) {
    this.#warnings = new ManagerWarnings(services, 'hardware report');
  }

  /** The report, or `unavailable`. Never throws. */
  async read(): Promise<HostHardwareOutput> {
    try {
      const answer = await withinMs(
        this.manager.hostHardware(),
        HOST_HARDWARE_TIMEOUT_MS,
        MANAGER_PATHS.hostHardware,
      );
      return { hardware: answer.hardware };
    } catch (err) {
      this.#warnings.warn(err);
      return { hardware: null, reason: 'unavailable' };
    }
  }
}

/** The session op `host.hardware` (HD-03): the person's devices; `not_managed` where no manager knows the box. */
export async function hostHardwareOp(c: {
  principal: SessionPrincipal;
  hardware: HostHardwareService | undefined;
}): Promise<HostHardwareOutput> {
  if (!c.principal.account) throw new ApiError('unauthorized', 'Enroll this device first.');
  if (!c.hardware) return { hardware: null, reason: 'not_managed' };
  return c.hardware.read();
}
