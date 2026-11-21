/**
 * An Incus server's tabs (Whombat incus-unraid.md IU-03, IU-04; AP-1557): Guests (with its profiles under them) ·
 * Storage (pools and custom volumes above the server's own disks) · Images · Network · Backups · Sensors · System (with
 * Incus's version, projects, operations and warnings) after the Summary, which is every server's dashboard
 * (`ServerSummary`, dashboards-web.md AP-2050…). The header, the tab row, the Ask pane and consoles are the server
 * page's, as on every server.
 */
import type { IncusServerTab } from '@whombat/client/hosts';
import { GuestsTab } from '../tabs/GuestsTab';
import { SensorsTab } from '../tabs/SensorsTab';
import { StorageTab } from '../tabs/StorageTab';
import { SystemTab } from '../tabs/SystemTab';
import type { TabProps } from '../tabs/tabProps';
import { IncusBackupsTab } from './IncusBackupsTab';
import { IncusImagesTab } from './IncusImagesTab';
import { IncusNetworkTab } from './IncusNetworkTab';
import { IncusProfilesCard } from './IncusProfiles';
import { IncusStorage } from './IncusStorage';

export function IncusPanel({
  tab,
  burrow,
  serverId,
  detail,
  timeZone,
}: TabProps & { tab: Exclude<IncusServerTab, 'summary'> }) {
  switch (tab) {
    case 'guests':
      return (
        <>
          <GuestsTab burrow={burrow} serverId={serverId} detail={detail} />
          <IncusProfilesCard burrow={burrow} detail={detail} />
        </>
      );
    case 'storage':
      return (
        <>
          <IncusStorage burrow={burrow} detail={detail} />
          <StorageTab burrow={burrow} detail={detail} />
        </>
      );
    case 'images':
      return <IncusImagesTab burrow={burrow} serverId={serverId} detail={detail} timeZone={timeZone} />;
    case 'network':
      return <IncusNetworkTab burrow={burrow} detail={detail} />;
    case 'backups':
      return <IncusBackupsTab burrow={burrow} serverId={serverId} detail={detail} timeZone={timeZone} />;
    case 'sensors':
      return <SensorsTab burrow={burrow} serverId={serverId} detail={detail} timeZone={timeZone} />;
    default:
      return <SystemTab burrow={burrow} serverId={serverId} detail={detail} timeZone={timeZone} />;
  }
}
