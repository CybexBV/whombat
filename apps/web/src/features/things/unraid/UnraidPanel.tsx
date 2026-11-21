/**
 * An Unraid server's tabs (Whombat incus-unraid.md IU-03; AP-1587): Array · Shares · Guests · Plugins · Sensors ·
 * System after the Summary, which is every server's dashboard (`ServerSummary`, dashboards-web.md AP-2050…). Sensors
 * and System are every server's (System with Unraid's updates and notifications first); the rest are Unraid's own.
 */
import type { UnraidTab } from '@whombat/client/hosts';
import { NewVmButton } from '../libvirt/LibvirtCreate';
import { LvImagesCard } from '../libvirt/LibvirtStorage';
import { useLibvirtAccess } from '../libvirt/useLibvirt';
import { GuestsTab } from '../tabs/GuestsTab';
import { SensorsTab } from '../tabs/SensorsTab';
import { SystemTab } from '../tabs/SystemTab';
import { ArrayTab, type UnraidTabProps } from './ArrayTab';
import { PluginsTab } from './PluginsTab';
import { SharesTab } from './SharesTab';
import { useUnraidGuestExtras } from './UnraidGuests';
import { UnraidSystemCards } from './UnraidSystemCards';

export function UnraidPanel({ tab, ...props }: UnraidTabProps & { tab: Exclude<UnraidTab, 'summary'> }) {
  switch (tab) {
    case 'array':
      return <ArrayTab {...props} />;
    case 'shares':
      return <SharesTab {...props} />;
    case 'guests':
      return <UnraidGuestsTab {...props} />;
    case 'plugins':
      return <PluginsTab {...props} />;
    case 'sensors':
      return <SensorsTab {...props} />;
    default:
      return (
        <>
          <UnraidSystemCards {...props} />
          <SystemTab {...props} />
        </>
      );
  }
}

function UnraidGuestsTab({ burrow, serverId, detail }: UnraidTabProps) {
  const { extras, dialogs } = useUnraidGuestExtras(burrow, detail, true);
  // libvirt's VMs the Unraid way (IU-13, stream WQ): New VM, and the VM Manager's ISO folder.
  const lv = useLibvirtAccess(burrow, detail);
  return (
    <>
      <GuestsTab
        burrow={burrow}
        serverId={serverId}
        detail={detail}
        extras={{
          ...extras,
          head: (
            <>
              {extras.head}
              <NewVmButton burrow={burrow} detail={detail} />
            </>
          ),
        }}
      />
      {detail.libvirt?.folders?.isos && detail.server.remoteControl.manage ? (
        <LvImagesCard burrow={burrow} detail={detail} canChange={lv.can} />
      ) : null}
      {dialogs}
    </>
  );
}
