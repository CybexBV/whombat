/**
 * A `connection_call` approval's call (connections-catalog.md CX-21; contracts CT-271; app AP-763): which connection and
 * tool, and the arguments as its deciders see them (`Approval.connection.argumentsPreview`, the pack-tool precedent
 * BP-D14). Pure: the card and the modal show it the same way, as a run_command's COMMAND block.
 */
import { type Approval, catalogEntry } from '@whombat/core/domain';

export interface ConnectionCallView {
  /** “CALL · Home Assistant · home.lan” */
  label: string;
  /** `HassTurnOn(…)` arguments, pretty JSON when they parse (a cut preview stays as sent); null for non-deciders. */
  text: string | null;
  tool: string;
}

export function connectionCallView(approval: Approval): ConnectionCallView | null {
  if (approval.action.type !== 'connection_call') return null;
  const detail = approval.connection;
  const { tool, handle } = approval.action.params;
  const where = detail ? detail.label : handle;
  const service = detail ? catalogEntry(detail.catalogId)?.name : null;
  const label = ['CALL', service && !where.startsWith(service) ? service : null, where]
    .filter(Boolean)
    .join(' · ');
  const preview = detail?.argumentsPreview ?? null;
  return { label, tool, text: preview === null ? null : pretty(preview) };
}

function pretty(preview: string): string {
  try {
    return JSON.stringify(JSON.parse(preview), null, 2);
  } catch {
    return preview;
  }
}
