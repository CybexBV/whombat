export const SOCKET: string;
export const TEXT_MAX: number;
export const USAGE: string;
export function parseArgs(argv: string[]): Record<string, unknown>;
export function buildRequest(
  parsed: Record<string, unknown>,
  env?: Record<string, string | undefined>,
  options?: { readStdin?: (max: number) => Promise<string>; eventId?: string },
): Promise<Record<string, unknown>>;
export function exchange(
  request: unknown,
  env?: Record<string, string | undefined>,
  options?: { timeoutMs?: number },
): Promise<{ reply?: Record<string, unknown>; error?: string }>;
export function describeReply(request: { op: string }, reply: Record<string, unknown>): string;
export function main(argv?: string[], env?: Record<string, string | undefined>): Promise<void>;
