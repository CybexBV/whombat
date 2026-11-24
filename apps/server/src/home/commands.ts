/**
 * Every command of one Whombat's assistant side (one-whombat-assistant.md), registered with the pipeline, and the
 * undoers this side brings (the connection undo, ONE-DW19; a reported change's, `reports.ts`, home-redesign.md HR-03).
 */
import { CARE_COMMANDS } from '../care/commands';
import { CHAT_COMMANDS } from '../chats/commands';
import type { CommandDef } from '../commit/types';
import { CONNECTION_UNDO_KIND } from '../connections/changes';
import { undoConnectionChange } from '../connections/undo';
import { WATCH_LIMIT_CHANGE } from '../hosts/commands';
import { undoServerWatchLimit } from '../hosts/quiet';
import { LOOK_COMMANDS } from '../looks/research';
import { THING_ACTION_UNDO_KIND, THING_COMMANDS, undoThingAction } from '../things/actions';
import { undoAgentWatch } from '../things/quiet/agent';
import { AGENT_WATCH_CHANGE_KIND, QUIET_COMMANDS } from '../things/quiet/commands';
import { KEEP_QUIET_CHANGE_KIND, QUIET_WINDOW_COMMANDS } from '../things/quiet/window-commands';
import { undoKeepQuiet } from '../things/quiet/window-service';
import { CHANGE_COMMANDS } from './changes';
import { DONE_COMMANDS } from './done';
import { registerDirectUndoer } from './registry';
import { REPORT_COMMANDS } from './reports';
import { SNOOZE_COMMANDS } from './snoozes';
import { WIDGET_COMMANDS } from './widgets';

registerDirectUndoer(CONNECTION_UNDO_KIND, undoConnectionChange);
// What the assistant switched in what Whombat watches, on the person's word (on-purpose.md).
registerDirectUndoer(AGENT_WATCH_CHANGE_KIND, undoAgentWatch);
registerDirectUndoer(WATCH_LIMIT_CHANGE, undoServerWatchLimit);
// Keeping a thing quiet for a while: Undo ends it now.
registerDirectUndoer(KEEP_QUIET_CHANGE_KIND, undoKeepQuiet);
// Put it back on a service's setting (service-settings.md SST-03).
registerDirectUndoer(THING_ACTION_UNDO_KIND, undoThingAction);

export const ONE_WHOMBAT_COMMANDS: CommandDef[] = [
  ...(CHAT_COMMANDS as CommandDef[]),
  ...(CHANGE_COMMANDS as CommandDef[]),
  // Changes agents report, and asking them to put one back (home-redesign.md HR-03).
  ...(REPORT_COMMANDS as CommandDef[]),
  // What the agent finished, in its own words, for the desk's Done today (done-today.md DN-01).
  ...(DONE_COMMANDS as CommandDef[]),
  ...(WIDGET_COMMANDS as CommandDef[]),
  ...(SNOOZE_COMMANDS as CommandDef[]),
  // A page's actions (connection-pages.md CP-12).
  ...(THING_COMMANDS as CommandDef[]),
  // Ignore, Remind me tomorrow and Stop watching on a thing's lines (quiet-notices.md QN-10…QN-17).
  ...(QUIET_COMMANDS as CommandDef[]),
  // Keep quiet for a while, and End now.
  ...(QUIET_WINDOW_COMMANDS as CommandDef[]),
  // What the assistant found out about a look, and the step the person lets it take (look-research.md LR-01…LR-08).
  ...(LOOK_COMMANDS as CommandDef[]),
  // A care plan when a server is added, and the quiet hours for changes (care-plan.md).
  ...(CARE_COMMANDS as CommandDef[]),
];
