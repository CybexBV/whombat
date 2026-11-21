/**
 * The AI side's reads (CT-70, CT-72) as the setup screens use them: the same `signins.*` / `clients.*` endpoints over
 * REST (self-hosted) and over the session (managed), through the typed client. Nothing secret is cached: the lists
 * carry states, never keys; device codes and console output stay in component state.
 */
import { useQueryClient } from '@tanstack/react-query';
import type { CommitResult } from '@whombat/client';
import { endpointScope } from '@whombat/client/query';
import { useClients, useSignIns } from '@whombat/client/react';
import { appErrorOf, needsClient } from '@whombat/client/signins';
import { api } from '@whombat/core/contracts';
import { useCallback } from 'react';

/**
 * How the AI side's lists stay fresh: `poll` every 30 s (the setup screens; the shell's sign-in notice only while it
 * shows, web-efficiency.md WE-06), else at mount and when an agent changes (`agent.updated`, at most once per 30 s).
 */
export interface AiStatusOptions {
  poll?: boolean;
}

/**
 * The AI clients (Claude Code; an older Whombat's Codex row is ignored, chatgpt-no-client.md AP-5610): every 30 s
 * (`poll`), every second while one installs or updates.
 */
export function useClientsStatus(enabled = true, { poll = true }: AiStatusOptions = {}) {
  return useClients(enabled ? {} : null, {
    retry: false,
    refetchInterval: (q) =>
      q.state.data?.clients.some(
        (c) => needsClient(c.provider) && (c.state === 'installing' || c.state === 'updating'),
      )
        ? 1_000
        : poll
          ? 30_000
          : false,
  });
}

/** The person's own sign-ins, open attempts and consoles. */
export function useSignInsStatus(enabled = true, { poll = true }: AiStatusOptions = {}) {
  return useSignIns(enabled ? {} : null, { retry: false, refetchInterval: poll ? 30_000 : false });
}

/** Read the lists again after a change. */
export function useAiRefresh() {
  const qc = useQueryClient();
  return useCallback(() => {
    for (const ep of [api.signins.list, api.clients.list])
      void qc.invalidateQueries({ queryKey: endpointScope(ep) });
  }, [qc]);
}

/** After a GitHub sign-in or sign-out: the sign-ins and GitHub's status (Software Dev's “Connect GitHub”, CT-181). */
export function useGitHubRefresh() {
  const qc = useQueryClient();
  return useCallback(() => {
    for (const ep of [api.signins.list, api.github.status])
      void qc.invalidateQueries({ queryKey: endpointScope(ep) });
  }, [qc]);
}

/** A mutation's data, or its outcome as an error (these endpoints never ask for approval). */
export function must<T>(result: CommitResult<T>): T {
  if (result.status !== 'ok') throw new Error('message' in result ? result.message : 'Not allowed.');
  return result.data;
}

/** What to tell people about a failed call. */
export function problemText(error: unknown, fallback: string): string {
  return appErrorOf(error).message ?? fallback;
}
