/** Every Whombat Feedback command the commit pipeline knows (docs/decisions/feedback.md). */
import type { CommandDef } from '../commit/types';
import {
  assessorReply,
  recordAssessment,
  retryAssessment,
  settleAssessment,
  startAssessment,
} from './assessment';
import { requestHandoff, startHandoff } from './handoff';
import { receiveFeedbackReport } from './intake';
import { INTEGRATION_COMMANDS } from './integrations';
import { REPORT_COMMANDS } from './reports';

export const FEEDBACK_COMMANDS = [
  ...INTEGRATION_COMMANDS,
  receiveFeedbackReport,
  ...REPORT_COMMANDS,
  startAssessment,
  settleAssessment,
  recordAssessment,
  assessorReply,
  retryAssessment,
  requestHandoff,
  startHandoff,
] as CommandDef[];
