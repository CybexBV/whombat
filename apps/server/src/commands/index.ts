/** Every command the commit pipeline knows by name (REST routes, MCP tools, deferred approvals). */

import { COMMAND_APPROVAL_COMMANDS } from '../agent-commands/commands';
import { AUTOMATION_COMMANDS } from '../automations/commands';
import { PLAN_COMMANDS } from '../automations/plans';
import { automationStep, continueStep, mergePrStep, openPrStep } from '../automations/steps';
import { BACKUP_COMMANDS } from '../backups/commands';
import { BROWSER_COMMANDS } from '../browser/commands';
import { KEPT_SITE_COMMANDS } from '../browser/kept-sites';
import { recordCanvasEdit } from '../collab/commands';
import type { Pipeline } from '../commit/pipeline';
import type { CommandDef } from '../commit/types';
import { CONNECTION_CALL_COMMANDS } from '../connections/call';
import { CONNECTION_COMMANDS } from '../connections/commands';
import { setConnectionLook } from '../connections/look';
import { CONNECTOR_COMMANDS } from '../connectors/commands';
import { SCREEN_COMMANDS } from '../desk/screens';
import { DESK_COMMANDS } from '../desk/store';
import { DEVICES_COMMANDS } from '../devices/index';
import { FEEDBACK_COMMANDS } from '../feedback/commands';
import { githubGh } from '../github/agent-gh';
import { addRepoForAgent } from '../github/agent-repos';
import { GUIDE_ASK_COMMANDS } from '../guides/ask';
import { GUIDE_COMMANDS } from '../guides/commands';
import { ONE_WHOMBAT_COMMANDS } from '../home/commands';
import { HOSTS_COMMANDS } from '../hosts/commands';
import { FIND_MY_COMMANDS } from '../hosts/findmy-places';
import { FIND_MY_TIMELINE_COMMANDS } from '../hosts/findmy-timeline';
import { FIND_MY_WATCH_COMMANDS } from '../hosts/findmy-watch';
import { FOLLOWED_TASK_COMMANDS } from '../hosts/followed';
import { MAIL_TRIGGER_COMMANDS } from '../mail-triggers/index';
import { setAgentNotes } from '../memory/notes';
import { PROMPT_COMMANDS } from '../prompts/commands';
import { authorizeGit } from '../runtime/git';
import { SETTINGS_COMMANDS } from '../settings/command';
import { SHARE_COMMANDS } from '../shares/commands';
import { recordSkillChange, recordSkillInstall } from '../skills/commands';
import { TRACKER_COMMANDS } from '../trackers/index';
import { ASK_SERVER_COMMANDS } from '../vault/ask-server';
import { VAULT_ENTRY_COMMANDS } from '../vault/commands';
import { VAULT_SSH_COMMANDS } from '../vault/ssh-commands';
import { VAULT_TOTP_COMMANDS } from '../vault/totp';
import { decideVaultUseCommand, recordVaultUse } from '../vault/uses';
import { VOICE_COMMANDS } from '../voice/store';
import {
  failDispatchRuns,
  finishRun,
  runFilesTouched,
  runLogLines,
  runStep,
  runTests,
  startRun,
} from './agent-runs';
import { setAgentStatus, settleAgentStatus } from './agent-status';
import {
  agentSearch,
  deliverAnswer,
  editCanvas,
  openPr,
  performAction,
  postCard,
  recordPush,
} from './agent-tools';
import { grantRequestedKey, setAgentKeys, updateAgent } from './agents';
import { decideApproval, requestApproval, undoDecision } from './approvals';
import { completeOnboarding, setRepoEnabled, updateBurrow, updateOnboarding } from './burrows';
import { addCanvasComment, askSearch, createCanvas, postAnswer, resolveCanvasComment } from './content';
import { updateConversation } from './conversations';
import { deleteMessage, editMessage, pinMessage } from './message-edits';
import { markRead, reactToMessage, requestMore, sendMessage } from './messages';
import { PEOPLE_COMMANDS } from './people';
import {
  addPlanStep,
  createPlan,
  createPlanCanvas,
  removePlanStep,
  startPlanStep,
  updatePlan,
  updatePlanByAgent,
  updatePlanStep,
} from './plans';
import { setMemberAvatar, updateMemberProfile } from './profile';
import { mergePr, recordChecks, reviewPr } from './prs';
import { answerRun, awaitAnswer } from './run-answers';
import { reportWorkspace, retryRun, stallRun } from './run-recovery';
import { pauseRun, resumeRun, takeOverRun } from './runs';

export const COMMANDS: CommandDef[] = [
  sendMessage,
  reactToMessage,
  requestMore,
  markRead,
  decideApproval,
  undoDecision,
  requestApproval,
  setAgentKeys,
  grantRequestedKey,
  updateAgent,
  mergePr,
  reviewPr,
  recordChecks,
  updateBurrow,
  updateOnboarding,
  completeOnboarding,
  setRepoEnabled,
  updateMemberProfile,
  setMemberAvatar,
  updateConversation,
  // Essentials — docs/decisions/essentials-conversations.md.
  editMessage,
  deleteMessage,
  pinMessage,
  askSearch,
  postAnswer,
  createCanvas,
  addCanvasComment,
  resolveCanvasComment,
  // Plans — work-supervision.md WS-01…WS-08.
  createPlan,
  updatePlan,
  addPlanStep,
  updatePlanStep,
  removePlanStep,
  updatePlanByAgent,
  startPlanStep,
  createPlanCanvas,
  pauseRun,
  resumeRun,
  takeOverRun,
  // Runs that don't get stuck — run-checkout.md RC-09…RC-11.
  retryRun,
  reportWorkspace,
  stallRun,
  // A run whose goal waits on a person — resourceful-agents.md RA-DS62.
  awaitAnswer,
  answerRun,
  // Agent runtime (MCP tools, runner, GitHub mirror) — runtime-server.md.
  startRun,
  runStep,
  runLogLines,
  runTests,
  runFilesTouched,
  finishRun,
  failDispatchRuns,
  postCard,
  setAgentStatus,
  settleAgentStatus,
  deliverAnswer,
  performAction,
  openPr,
  recordPush,
  editCanvas,
  agentSearch,
  authorizeGit,
  // An agent's gh through Whombat — agent-gh.md.
  githubGh,
  // GitHub repositories for agents by default — agent-repos.md.
  addRepoForAgent,
  // Collaborative canvas — collab-server.md.
  recordCanvasEdit,
  // The agent's work on the person's accounts — connectors-google-tools.md.
  ...CONNECTOR_COMMANDS,
  // The person's notes for the agent — hermes-engine.md HE-39.
  setAgentNotes,
  // Supervised automations — bp-automations.md.
  ...AUTOMATION_COMMANDS,
  ...PLAN_COMMANDS,
  // Backup files (docs/decisions/backup-file.md): the person's only.
  ...BACKUP_COMMANDS,
  automationStep,
  continueStep,
  openPrStep,
  mergePrStep,
  // Catalog connection tool calls (connections/call.ts, connections-catalog.md CX-20…CX-23).
  ...CONNECTION_CALL_COMMANDS,
  // The assistant changing a setting for the person (settings/command.ts, assistant-settings.md).
  ...SETTINGS_COMMANDS,
  // Shared links (shares/commands.ts, share-links.md): an approval runs `share_create` again by name.
  ...SHARE_COMMANDS,
  // The person's prompts (prompts/commands.ts, prompts.md).
  ...PROMPT_COMMANDS,
  // Settings → Skills and Hermes's hub (hermes-engine.md HE-41, hermes-skills.md HSK-06).
  recordSkillChange,
  recordSkillInstall,
  // Whombat Feedback — feedback.md.
  ...FEEDBACK_COMMANDS,
  // Tracker reports through automations — report-trackers.md.
  ...TRACKER_COMMANDS,
  // Mail-triggered automations: high-water marks and mirrored matching messages.
  ...MAIL_TRIGGER_COMMANDS,
  // Guided setup in the personal assistant's DM — assistant-guides.md.
  ...GUIDE_COMMANDS,
  // Setup cards a turn posts (connect, a Vault field) — connect-in-chat.md.
  ...GUIDE_ASK_COMMANDS,
  // The Vault — vault.md.
  ...VAULT_ENTRY_COMMANDS,
  ...VAULT_TOTP_COMMANDS,
  ...ASK_SERVER_COMMANDS,
  ...VAULT_SSH_COMMANDS,
  decideVaultUseCommand,
  recordVaultUse,
  // The agent's commands that ask first — agent-computer.md AC-41, one-person.md OP-S107.
  ...COMMAND_APPROVAL_COMMANDS,
  // The browser — browser.md.
  ...BROWSER_COMMANDS,
  // Kept sites (docs/decisions/kept-sites.md).
  ...KEPT_SITE_COMMANDS,
  // Notification levels — essentials-people.md.
  ...PEOPLE_COMMANDS,
  // Shared catalog connections — connections-catalog.md CX-22.
  ...CONNECTION_COMMANDS,
  // A Custom connection's logo and page — connection-looks.md.
  setConnectionLook,
  // One Whombat: task chats, Home, changes and Undo, widgets — one-whombat-assistant.md.
  ...ONE_WHOMBAT_COMMANDS,
  // Server changes, signed once the hosts service did them — one-whombat-servers.md.
  ...HOSTS_COMMANDS,
  // Server tasks followed to their end as cards in their thread — task-feedback.md.
  ...FOLLOWED_TASK_COMMANDS,
  // Where people are on Find My, kept for the automations that listen — findmy-connection.md.
  ...FIND_MY_COMMANDS,
  // Where the people the person ticked were, 30 days — findmy-timeline.md.
  ...FIND_MY_TIMELINE_COMMANDS,
  ...FIND_MY_WATCH_COMMANDS,
  // Devices Whombat doesn't support yet — one-whombat-devices.md.
  ...DEVICES_COMMANDS,
  // The desk screen paired to a person — desk-display-server.md.
  ...DESK_COMMANDS,
  ...SCREEN_COMMANDS,
  // Voice typing's settings — dictation.md.
  ...VOICE_COMMANDS,
] as CommandDef[];

export function registerCommands(pipeline: Pipeline): void {
  pipeline.register(...COMMANDS);
}
