/**
 * Whombat's words in a turn (docs/decisions/hermes-engine.md HE-34): `SOUL.md`, `whombat.md` and the per-turn preface
 * (`prompt.ts`), the helpers they are made of, and what a turn may do (`access.ts`).
 */
export {
  holdsKey,
  isCommandsTurn,
  isWorkFolderTurn,
  keyOutcome,
  networkFor,
  personaGrants,
  sandboxFor,
  toolKeyAccess,
} from './access';
export { grantedApprovalLine, retryLine, undoRequestLines } from './approvals';
export { attachmentNote } from './attachments';
export { cardNote } from './cards';
export { CONNECTIONS_HEADING, connectionLines, usesConnections } from './connections';
export { deskTurnLines } from './desk';
export {
  ASSESSOR_TOOLS,
  defuseFeedback,
  feedbackHandoffLines,
  feedbackPrompt,
  feedbackSystemPrompt,
  feedbackTools,
  promptText,
  reportCardNote,
  showsMessageFiles,
} from './feedback';
export { GH_LISTED_MAX, ghLines, ghThroughWhombat } from './gh';
export { personalLines } from './personal';
export { planStepLines } from './plans';
export {
  AUTOMATION_REPLY_LINE,
  NO_REPLY,
  notesMd,
  prefaceLines,
  REPLY_STYLE_LINES,
  replyLengthLines,
  reviewsChange,
  soulMd,
  type TurnPromptOptions,
  turnPrompt,
  WRITING_LINES,
  whombatMd,
} from './prompt';
export {
  TRACKER_ITEM_TOOL,
  TRACKER_READ_TOOL,
  trackerReads,
  trackerTools,
  trackerTurnLines,
  unservedTrackerTools,
} from './tracker';
export { AGENT_VOICE_CUES, AGENT_VOICES, voiceCueLines, voiceLimits } from './voices';
export {
  councilTurnLines,
  delegationTurnLines,
  lookTurnLines,
  notifyTurnLines,
  scheduleTurnLines,
  t3ThreadTurnLines,
  taskFinishedTurnLines,
} from './wakes';
