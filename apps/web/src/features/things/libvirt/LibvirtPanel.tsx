/**
 * A QEMU/KVM server's tabs (Whombat incus-unraid.md IU-03, IU-13; AP-1647): Guests · Storage · Network · Backups ·
 * Sensors · System after the Summary, which is every server's dashboard (`ServerSummary`, dashboards-web.md
 * AP-2050…). Sensors and System are every server's (System gains QEMU/KVM's facts and tasks); Guests gets libvirt's
 * Autostart column (stream WU's) and New VM; the rest are libvirt's own.
 */
import type { LibvirtServerTab } from '@whombat/client/hosts';
import { GuestsTab } from '../tabs/GuestsTab';
import { SensorsTab } from '../tabs/SensorsTab';
import { SystemTab } from '../tabs/SystemTab';
import type { TabProps } from '../tabs/tabProps';
import { useUnraidGuestExtras } from '../unraid/UnraidGuests';
import { LvServerBackups } from './LibvirtBackups';
import { NewVmButton } from './LibvirtCreate';
import { LibvirtNetwork } from './LibvirtNetwork';
import { LibvirtStorage } from './LibvirtStorage';
import { useLibvirtAccess } from './useLibvirt';

export function LibvirtPanel({ tab, ...props }: TabProps & { tab: Exclude<LibvirtServerTab, 'summary'> }) {
  switch (tab) {
    case 'guests':
      return <LibvirtGuestsTab {...props} />;
    case 'storage':
      return <LibvirtStorage burrow={props.burrow} detail={props.detail} />;
    case 'network':
      return <LibvirtNetwork burrow={props.burrow} detail={props.detail} />;
    case 'backups':
      return <LibvirtBackupsTab {...props} />;
    case 'sensors':
      return <SensorsTab {...props} />;
    default:
      return <SystemTab {...props} />;
  }
}

function LibvirtGuestsTab({ burrow, serverId, detail }: TabProps) {
  const { extras, dialogs } = useUnraidGuestExtras(burrow, detail, false);
  return (
    <>
      <GuestsTab
        burrow={burrow}
        serverId={serverId}
        detail={detail}
        extras={{ ...extras, head: <NewVmButton burrow={burrow} detail={detail} /> }}
      />
      {dialogs}
    </>
  );
}

function LibvirtBackupsTab({ burrow, detail, timeZone }: TabProps) {
  const access = useLibvirtAccess(burrow, detail);
  return <LvServerBackups burrow={burrow} detail={detail} canChange={access.can} timeZone={timeZone} />;
}
