/**
 * A Mac's tabs (Whombat macos-servers.md; MAC-30): Screen · Find My · Storage · Sensors · System after the Summary, which
 * is every server's dashboard with “This Mac” in its Technical details. Storage, Sensors and System are every server's;
 * the Screen and Find My are the Mac's own.
 */
import type { MacServerTab } from '@whombat/client/hosts';
import { SensorsTab } from '../tabs/SensorsTab';
import { StorageTab } from '../tabs/StorageTab';
import { SystemTab } from '../tabs/SystemTab';
import type { TabProps } from '../tabs/tabProps';
import { MacFindMyTab } from './MacFindMyTab';
import { MacScreenTab } from './MacScreenTab';

export function MacPanel({ tab, ...props }: TabProps & { tab: Exclude<MacServerTab, 'summary'> }) {
  switch (tab) {
    case 'screen':
      return <MacScreenTab {...props} />;
    case 'findmy':
      return <MacFindMyTab {...props} />;
    case 'storage':
      return <StorageTab burrow={props.burrow} detail={props.detail} />;
    case 'sensors':
      return <SensorsTab {...props} />;
    default:
      return <SystemTab {...props} />;
  }
}
