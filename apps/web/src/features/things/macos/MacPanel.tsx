/**
 * A Mac's tabs (Whombat macos-servers.md; MAC-30): Screen · Storage · Sensors · System after the Summary, which is every
 * server's dashboard with “This Mac” in its Technical details and a link to its Find My connection. Storage, Sensors and
 * System are every server's; the Screen is the Mac's own. Find My is a connection's page of its own; on a Whombat from
 * before that the Mac keeps it as a tab, drawn the same.
 */
import type { MacServerTab } from '@whombat/client/hosts';
import { FindMyTab } from '../findmy/FindMyTab';
import { SensorsTab } from '../tabs/SensorsTab';
import { StorageTab } from '../tabs/StorageTab';
import { SystemTab } from '../tabs/SystemTab';
import type { TabProps } from '../tabs/tabProps';
import { MacScreenTab } from './MacScreenTab';

export function MacPanel({ tab, ...props }: TabProps & { tab: Exclude<MacServerTab, 'summary'> }) {
  switch (tab) {
    case 'screen':
      return <MacScreenTab {...props} />;
    case 'findmy':
      return <FindMyTab burrow={props.burrow} serverId={props.serverId} />;
    case 'storage':
      return <StorageTab burrow={props.burrow} detail={props.detail} />;
    case 'sensors':
      return <SensorsTab {...props} />;
    default:
      return <SystemTab {...props} />;
  }
}
