/**
 * The `record_deploy` MCP tool (Whombat improvement-review feature 5, RF-02; contracts 0.55.0, CT-296): an agent records
 * every deploy it does. Spread into `MCP_TOOLS` (`./mcp`); no key (recording isn't deploying: the deploy itself needed
 * its key). The server records the deployment for the turn's agent, resolves `previousId` (the deploy of the same
 * service and environment that succeeded before), posts the `deploy` card in the turn's thread as the agent, publishes
 * `deployment.recorded` and signs `deploy.recorded`. Not a posting tool (`MCP_POSTING_TOOLS`): the agent still says what
 * it did in its own words.
 */
import { z } from 'zod';
import { RepoFullName } from '../domain/common.js';
import {
  DEPLOY_SUMMARY_MAX,
  DeployEnvironmentName,
  DeploymentHow,
  DeploymentStatus,
  DeployRef,
  DeployServiceName,
  DeploySha,
  DeployUrl,
} from '../domain/deployment.js';
import { DeploymentId, MessageId, RunId } from '../ids.js';
import { commitOutcome } from './errors.js';
import type { McpTool } from './mcp.js';

export const RecordDeployInput = z.object({
  environment: DeployEnvironmentName.describe(
    'Where it went, as the person names it: production, staging, preview-482.',
  ),
  service: DeployServiceName.describe('What you deployed: the app, site or service (api, web, whombat.com).'),
  status: DeploymentStatus.describe('succeeded or failed.'),
  how: DeploymentHow.describe(
    'github_actions (a workflow), ssh (ssh, scp or rsync to a server), cli (another command-line tool) or other.',
  ),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(DEPLOY_SUMMARY_MAX)
    .describe(
      'One or two sentences for the person: what changed, or why it failed, and anything to watch. No secrets.',
    ),
  sha: DeploySha.optional().describe('The commit you deployed.'),
  ref: DeployRef.optional().describe('The branch or tag you deployed (main, v1.4.2).'),
  url: DeployUrl.optional().describe('Where people can see it (https://…).'),
  repo: RepoFullName.optional().describe('The repository it came from (owner/name).'),
  runId: RunId.optional().describe(
    'The run it belongs to; leave out for the run this turn works on, if any.',
  ),
});
export type RecordDeployInput = z.input<typeof RecordDeployInput>;

/** `record_deploy`'s answer: the deployment, the one it follows (null: the first there) and the card's message. */
export const RecordDeployOutput = commitOutcome({
  deploymentId: DeploymentId,
  previousId: DeploymentId.nullable(),
  messageId: MessageId.nullable(),
});
export type RecordDeployOutput = z.infer<typeof RecordDeployOutput>;

function deployTool<I extends z.ZodObject, O extends z.ZodType>(def: McpTool<I, O>): McpTool<I, O> {
  return def;
}

export const DEPLOY_MCP_TOOLS = {
  record_deploy: deployTool({
    name: 'record_deploy',
    title: 'Record a deploy',
    description:
      'Call it after every deploy you do, whether it succeeded or failed: it records the deploy on the burrow’s Deploys board and posts a deploy card here. The summary shows on the Deploys board, so keep secrets out of it.',
    input: RecordDeployInput,
    output: RecordDeployOutput,
    requiredKey: null,
    readOnly: false,
  }),
} as const;
