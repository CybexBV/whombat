/** A test double of the server's command endpoints (tool-asks.test.ts, managed-turn.test.ts, the e2e scripts). */
import type {
  AuthorizeCommandBody,
  AuthorizeCommandReply,
  AuthorizeWaitReply,
  RunnerCommandsApi,
  RunnerNotifyBody,
  TurnKeys,
} from './api';

export class FakeServer implements RunnerCommandsApi {
  authorized: AuthorizeCommandBody[] = [];
  notified: RunnerNotifyBody[] = [];
  reply: AuthorizeCommandReply = { outcome: 'run', approvalId: null, message: '', open: [] };
  waits: AuthorizeWaitReply[] = [];
  keys: TurnKeys = { files: [], env: [], mcpServers: [], entries: [] };
  async authorizeCommand(body: AuthorizeCommandBody) {
    this.authorized.push(body);
    return this.reply;
  }
  async authorizeWait() {
    await new Promise((r) => setTimeout(r, 20));
    return this.waits.shift() ?? { outcome: 'pending' as const, scope: null, message: '', open: [] };
  }
  async turnKeys() {
    return this.keys;
  }
  async notify(body: RunnerNotifyBody) {
    this.notified.push(body);
  }
}
