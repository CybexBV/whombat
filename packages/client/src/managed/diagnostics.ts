/**
 * Customer-approved diagnostic bundles (CT-52), shared by the web and the phone. The person picks scopes, the appliance
 * builds the bundle, the person reads exactly what it contains and downloads it; nothing is sent anywhere by itself.
 * What is shown is checked to be what a download contains: the preview's bytes (`diagnosticBundleBytes`) must hash to
 * the summary's sha256, and so must the downloaded bytes.
 */
import { sha256Hex } from '@whombat/core/audit';
import {
  DIAGNOSTIC_SCOPES,
  DiagnosticBundle,
  type DiagnosticScope,
  diagnosticBundleBytes,
} from '@whombat/protocol/session';
import { type DiagnosticBundleSummary, sessionOps } from '../session/managed-ops';
import type { ApplianceSession } from '../session/types';

export { DIAGNOSTIC_SCOPES, type DiagnosticScope };

/** The scopes in the contract's order, each with its description (what it contains, and what never). */
export const DIAGNOSTIC_SCOPE_LIST = (Object.keys(DIAGNOSTIC_SCOPES) as DiagnosticScope[]).map((scope) => ({
  scope,
  description: DIAGNOSTIC_SCOPES[scope],
}));

/** The bundle shown, or downloaded, isn't the one the appliance recorded: nothing is shown or saved. */
export class DiagnosticsIntegrityError extends Error {
  override name = 'DiagnosticsIntegrityError';
}

export interface CheckedPreview {
  summary: DiagnosticBundleSummary;
  /** The exact bytes a download contains, as text (UTF-8 canonical JSON). */
  text: string;
  /** The same, indented for reading. */
  pretty: string;
  /** Structured, when this client knows the bundle's format; null for a newer runtime's bundle (show `pretty`). */
  bundle: DiagnosticBundle | null;
}

/** `sha256(diagnosticBundleBytes(bundle)) === summary.sha256`, else `DiagnosticsIntegrityError`. */
export function checkPreview(preview: { summary: DiagnosticBundleSummary; bundle: unknown }): CheckedPreview {
  const bytes = diagnosticBundleBytes(preview.bundle);
  if (sha256Hex(bytes) !== preview.summary.sha256 || bytes.byteLength !== preview.summary.size)
    throw new DiagnosticsIntegrityError('The preview doesn’t match the bundle the appliance recorded.');
  const parsed = DiagnosticBundle.safeParse(preview.bundle);
  return {
    summary: preview.summary,
    text: new TextDecoder().decode(bytes),
    pretty: JSON.stringify(preview.bundle, null, 2),
    bundle: parsed.success ? parsed.data : null,
  };
}

export async function previewDiagnostics(
  session: ApplianceSession,
  bundleId: string,
): Promise<CheckedPreview> {
  return checkPreview(await sessionOps.diagnosticsPreview(session, bundleId));
}

/** The downloaded bytes, when they hash to the summary (the stream itself also checks `stream_done`). */
export function checkDownload(summary: DiagnosticBundleSummary, bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength !== summary.size || sha256Hex(bytes) !== summary.sha256)
    throw new DiagnosticsIntegrityError(
      'The downloaded file doesn’t match the bundle the appliance recorded.',
    );
  return bytes;
}

/**
 * Downloads a bundle through the session's export stream (`diagnostics.download`, a signed `downloaded` event on the
 * appliance), bounded by the summary's size, and checks it.
 */
export async function downloadDiagnostics(
  session: ApplianceSession,
  summary: DiagnosticBundleSummary,
  signal?: AbortSignal,
): Promise<{ name: string; bytes: Uint8Array }> {
  const stream = await session.openResource(
    { kind: 'export', op: 'diagnostics.download', input: { bundleId: summary.bundleId } },
    signal ? { signal } : {},
  );
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream.chunks) {
    total += chunk.byteLength;
    if (total > summary.size) {
      stream.cancel();
      throw new DiagnosticsIntegrityError('The download is larger than the bundle the appliance recorded.');
    }
    parts.push(chunk);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.byteLength;
  }
  return {
    name: stream.meta.name ?? `whombat-diagnostics-${summary.bundleId}.json`,
    bytes: checkDownload(summary, bytes),
  };
}
