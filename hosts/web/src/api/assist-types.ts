// Types of the assistant endpoints (docs/ASSIST.md 6): settings, the
// Claude Code / Codex providers and investigations with their transcript.
// Pure types, shared by the UI (api/assist.ts) and the fixture server.

export type ProviderId = 'claude' | 'codex';
export type Access = 'read' | 'ask' | 'full';
export type InvestigationState = 'starting' | 'running' | 'waiting' | 'idle' | 'done' | 'failed' | 'stopped';

export interface AssistantSettings {
  enabled: boolean;
  provider: ProviderId;
  access: Access;
  auto_investigate: 'off' | 'critical' | 'all';
  auto_update: boolean;
  claude_model: string;
  codex_model: string;
  claude_channel: 'stable' | 'latest';
}

export interface ProviderState {
  id: ProviderId;
  name: string;                 // "Claude Code" | "Codex"
  installed: boolean;
  version: string | null;
  latest: string | null;        // newest known version
  update_available: boolean;
  checked_at: string | null;    // last update check
  busy: 'installing' | 'removing' | null;
  progress: number | null;      // 0..1 while downloading
  signed_in: boolean;
  account: string | null;       // e.g. "john@example.com (plus)", "Claude subscription"
  login: { verification_url: string; user_code: string; expires_at: string } | null; // Codex device login in progress
  error: string | null;         // last install / sign-in error
}

export interface AssistantState {
  settings: AssistantSettings;
  runner: { connected: boolean; sandboxed: boolean; error: string | null };
  providers: Record<ProviderId, ProviderState>;
  running: number;              // investigations running now
}

export interface Investigation {
  id: string;
  title: string;
  server: string | null;        // server id, null: fleet-wide
  server_name: string | null;
  alert_id: string | null;
  provider: ProviderId;
  model: string | null;
  state: InvestigationState;
  access: Access;               // the level it started with
  auto: boolean;                // started on its own for an alert
  created_by: string;           // user name, or "auto"
  created_at: string;
  updated_at: string;
  summary: string | null;       // from finish
  resolved: boolean | null;
  cost_usd: number | null;      // Claude Code's estimate (subscriptions are not billed per call)
  pending_approvals: number;
}

export type InvestigationEvent = {
  seq: number;
  at: string;
} & (
  | { kind: 'user'; text: string; by: string }                       // by: user name or "auto"
  | { kind: 'assistant'; text: string }                              // Markdown
  | { kind: 'tool'; tool_id: string; tool: string; title: string; server: string | null; input: Record<string, unknown> }
  | { kind: 'tool_result'; tool_id: string; ok: boolean; output: string; truncated: boolean; duration_ms: number }
  | { kind: 'approval'; approval_id: string; tool_id: string; server: string; action: 'command' | 'guest_action'; command: string; reason: string }
  | { kind: 'approval_decided'; approval_id: string; decision: 'approved' | 'declined' | 'expired'; by: string; reply: string | null }
  | { kind: 'status'; state: InvestigationState; text: string | null }
  | { kind: 'summary'; text: string; resolved: boolean }
  | { kind: 'error'; text: string }
  | { kind: 'usage'; cost_usd: number | null; input_tokens: number | null; output_tokens: number | null }
);

/** GET /investigations/{id}. */
export interface InvestigationDetail {
  investigation: Investigation;
  events: InvestigationEvent[];
}

/** POST /investigations. */
export interface InvestigationStart {
  server?: string;
  alert?: string;
  prompt?: string;
  provider?: ProviderId;
}

/** GET /investigations filters. */
export interface InvestigationFilter {
  server?: string;
  alert?: string;
  limit?: number;
}
