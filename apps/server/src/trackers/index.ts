/** The commands of tracker reports through automations (docs/decisions/report-trackers.md), for the registry. */
import { mirrorTrackerItem } from './mirror';
import { reportUpdated } from './people';

export const TRACKER_COMMANDS = [mirrorTrackerItem, reportUpdated];
