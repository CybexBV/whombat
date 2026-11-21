// The transcript as the panel shows it: a tool call and its result become
// one step; a call that waits for an approval becomes the approval card
// (with its decision and, once it ran, its output); usage events only feed
// the cost in the header. Pure, so the grouping is unit tested.

import type { InvestigationEvent, InvestigationState } from '../../api/assist';

type Ev<K extends InvestigationEvent['kind']> = Extract<InvestigationEvent, { kind: K }>;
export type ToolEvent = Ev<'tool'>;
export type ToolResult = Ev<'tool_result'>;
export type ApprovalEvent = Ev<'approval'>;
export type ApprovalDecided = Ev<'approval_decided'>;

export type TranscriptItem =
  | { kind: 'user'; seq: number; at: string; text: string; by: string }
  | { kind: 'assistant'; seq: number; text: string }
  | { kind: 'step'; seq: number; tool: ToolEvent; result: ToolResult | null }
  | { kind: 'approval'; seq: number; approval: ApprovalEvent; tool: ToolEvent | null; decision: ApprovalDecided | null; result: ToolResult | null }
  | { kind: 'status'; seq: number; state: InvestigationState; text: string | null }
  | { kind: 'summary'; seq: number; text: string; resolved: boolean }
  | { kind: 'error'; seq: number; text: string };

/** Status changes worth a line without a text of their own. */
const STATUS_LINE = new Set<InvestigationState>(['stopped', 'failed']);

export function buildTranscript(events: InvestigationEvent[]): TranscriptItem[] {
  const results = new Map<string, ToolResult>();
  const approvals = new Map<string, ApprovalEvent>();
  const decisions = new Map<string, ApprovalDecided>();
  const tools = new Map<string, ToolEvent>();
  for (const e of events) {
    if (e.kind === 'tool_result') results.set(e.tool_id, e);
    else if (e.kind === 'approval') approvals.set(e.tool_id, e);
    else if (e.kind === 'approval_decided') decisions.set(e.approval_id, e);
    else if (e.kind === 'tool') tools.set(e.tool_id, e);
  }
  const out: TranscriptItem[] = [];
  const shown = new Set<string>();
  const approvalItem = (a: ApprovalEvent, seq: number): TranscriptItem => ({
    kind: 'approval',
    seq,
    approval: a,
    tool: tools.get(a.tool_id) ?? null,
    decision: decisions.get(a.approval_id) ?? null,
    result: results.get(a.tool_id) ?? null,
  });
  for (const e of events) {
    switch (e.kind) {
      case 'user':
        out.push({ kind: 'user', seq: e.seq, at: e.at, text: e.text, by: e.by });
        break;
      case 'assistant':
        if (e.text.trim()) out.push({ kind: 'assistant', seq: e.seq, text: e.text });
        break;
      case 'tool': {
        // A call that needed an approval shows as the approval card, where the call was made.
        const a = approvals.get(e.tool_id);
        if (a) {
          out.push(approvalItem(a, e.seq));
          shown.add(a.approval_id);
        } else out.push({ kind: 'step', seq: e.seq, tool: e, result: results.get(e.tool_id) ?? null });
        break;
      }
      case 'approval':
        if (!shown.has(e.approval_id)) {
          out.push(approvalItem(e, e.seq));
          shown.add(e.approval_id);
        }
        break;
      case 'status':
        if (e.text || STATUS_LINE.has(e.state)) out.push({ kind: 'status', seq: e.seq, state: e.state, text: e.text });
        break;
      case 'summary':
        out.push({ kind: 'summary', seq: e.seq, text: e.text, resolved: e.resolved });
        break;
      case 'error':
        out.push({ kind: 'error', seq: e.seq, text: e.text });
        break;
    }
  }
  return out;
}

/** Approvals still waiting for a decision. */
export function pendingApprovals(events: InvestigationEvent[]): ApprovalEvent[] {
  const decided = new Set(events.filter((e): e is ApprovalDecided => e.kind === 'approval_decided').map((e) => e.approval_id));
  return events.filter((e): e is ApprovalEvent => e.kind === 'approval' && !decided.has(e.approval_id));
}

/** A tool's input as label / value rows: nested objects as "key=value" pairs, lists joined. */
export function inputRows(input: Record<string, unknown>): [string, string][] {
  const fmt = (v: unknown): string => {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (Array.isArray(v)) return v.map(fmt).join(', ');
    if (typeof v === 'object') {
      return Object.entries(v as Record<string, unknown>)
        .map(([k, x]) => `${k}=${typeof x === 'object' && x !== null ? JSON.stringify(x) : fmt(x)}`)
        .join(' ');
    }
    return JSON.stringify(v);
  };
  return Object.entries(input ?? {})
    .map(([k, v]) => [k, fmt(v)] as [string, string])
    .filter(([, v]) => v !== '');
}

/** "820 ms", "4.2 s", "1 min 5 s". */
export function stepDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)} min ${s % 60} s`;
}
