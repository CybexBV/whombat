/**
 * What a turn holds while it is prepared and runs, each kept here as soon as it is acquired — so a step that fails
 * leaves nothing behind — and let go of in a fixed order: the provider's side first (gh, the AI gateway's forwarder,
 * the browser, the commands' part; one-person.md OP-S105), then the task's processes, then its folders and files.
 */

import type { SandboxSession } from '@whombat/agent-runtime';
import type { TurnFiles } from '../attachments';
import type { Browser } from '../browser';
import type { CommandsPlace } from '../commands/place';
import type { TurnCommands } from '../commands/turn';
import type { TurnConversationFiles } from '../files';
import type { GatewayForwarder } from '../gateway';
import type { GhService } from '../gh';
import type { TurnLogins } from '../logins';
import type { PodTurn } from '../pods';
import type { TurnFollowUps } from '../steering';
import type { PreparedCwd } from '../workspace';

export class TurnResources {
  /** The turn's working directory: a checkout, a scratch folder, the agent's work folder. */
  prepared: PreparedCwd | null = null;
  /** The dispatch's attachments, as the provider takes them. */
  turnFiles: TurnFiles | null = null;
  /** The conversation's Files at `~/files` or in the scratch folder (files-space.md FS-09). */
  conversationFiles: TurnConversationFiles | null = null;
  /** Managed: the turn's sandbox session. */
  sandbox: SandboxSession | null = null;
  /** A Hermes turn in its person's pod instead (hermes-native.md HN-W01): its slot and routes there. */
  pod: PodTurn | null = null;
  /** The turn's part of the agent's commands (one-person.md OP-07): the guard, its view, its keys. */
  commands: TurnCommands | null = null;
  /** An outsiders' turn's own commands' place (OP-17), in its task sandbox; a pod's is the pod's. */
  place: CommandsPlace | null = null;
  /** An assessment's own browser (HE-S140), in its task sandbox; a person's is the pod's. */
  browser: Browser | null = null;
  /** The turn's logins service (HE-S141): one password at a fill, for this turn only. */
  logins: TurnLogins | null = null;
  /** The turn's gh service (agent-gh.md AGH-02), when its gh goes through Whombat. */
  gh: GhService | null = null;
  /** A managed gateway turn's forwarder to the server's relay (AIG-08), bridged into its sandbox. */
  aiGateway: GatewayForwarder | null = null;
  /** The follow-ups the turn took, with their files. */
  followUps: TurnFollowUps | null = null;

  /**
   * gh and the commands' part of the turn end with the provider, before anything is pushed or landed (AC-21: git's
   * control files back); the AI gateway's forwarder too.
   */
  async endWithProvider(): Promise<void> {
    // The pod first: from now on the turn's Hermes session reaches nothing of it (HN-W04), and its slot is free.
    await this.pod?.release().catch(() => {});
    this.pod = null;
    await this.gh?.close().catch(() => {});
    await this.aiGateway?.close().catch(() => {});
    await this.logins?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
    await this.commands?.close().catch(() => {});
  }

  /** Everything, once the turn completed: the task's processes are all gone before its folders go. */
  async release(): Promise<void> {
    await this.endWithProvider();
    await this.sandbox?.close().catch(() => {});
    await this.place?.close().catch(() => {});
    await this.prepared?.release().catch(() => {});
    await this.turnFiles?.release().catch(() => {});
    await this.followUps?.release().catch(() => {});
    // After the commands that saw it ended (FS-09).
    await this.conversationFiles?.release().catch(() => {});
  }
}
