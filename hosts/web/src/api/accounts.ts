// Accounts: users (Settings › Users, admins), API tokens and kiosk links
// (Account page). Endpoints in docs/REST-API.md (Users, Tokens).

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { apiRequest } from './client';
import type { Role } from './types';

export type UserSource = 'local' | 'oidc';

export interface User {
  id: number;
  name: string;
  role: Role;
  source: UserSource;
  created_at: string;
  last_login_at: string | null;
  passkeys: number;
  /** Live browser sessions, kiosk sessions included. */
  sessions: number;
  has_password: boolean;
  /** Signs in with a temporary password that must be replaced. */
  must_change_password: boolean;
  /** Single sign-on account that has signed in at least once. */
  oidc_linked: boolean;
  /** The role comes from the single sign-on provider. */
  role_managed: boolean;
  self: boolean;
}

export interface UserChange {
  user: User;
  /** Shown once: a new password account or a reset. */
  temporary_password?: string;
}

export interface UserSession {
  id: string;
  created_at: string | null;
  last_seen_at: string | null;
  expires_at: string | null;
  ip: string;
  user_agent: string;
  kiosk: boolean;
  current: boolean;
}

export type TokenKind = 'api' | 'kiosk';

export interface ApiToken {
  id: string;
  name: string;
  role: Role;
  user: string;
  kind: TokenKind;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
}

export interface CreatedToken extends ApiToken {
  /** The secret, shown once. */
  token: string;
}

const enc = encodeURIComponent;

export const accountsApi = {
  users: async (signal?: AbortSignal): Promise<User[]> => ((await apiRequest('GET', '/users', { signal })) ?? []) as User[],
  createUser: async (u: { name: string; role: Role; source: UserSource }): Promise<UserChange> => (await apiRequest('POST', '/users', { body: u })) as UserChange,
  setRole: async (id: number, role: Role): Promise<UserChange> => (await apiRequest('PATCH', `/users/${id}`, { body: { role } })) as UserChange,
  resetPassword: async (id: number): Promise<UserChange> => (await apiRequest('PATCH', `/users/${id}`, { body: { reset_password: true } })) as UserChange,
  deleteUser: async (id: number): Promise<void> => {
    await apiRequest('DELETE', `/users/${id}`);
  },
  sessions: async (id: number, signal?: AbortSignal): Promise<UserSession[]> => ((await apiRequest('GET', `/users/${id}/sessions`, { signal })) ?? []) as UserSession[],
  revokeSessions: async (id: number): Promise<void> => {
    await apiRequest('DELETE', `/users/${id}/sessions`);
  },
  revokeSession: async (id: number, sid: string): Promise<void> => {
    await apiRequest('DELETE', `/users/${id}/sessions/${enc(sid)}`);
  },

  tokens: async (signal?: AbortSignal): Promise<ApiToken[]> => ((await apiRequest('GET', '/tokens', { signal })) ?? []) as ApiToken[],
  createToken: async (t: { name: string; kind: TokenKind; role?: Role; expires_days?: number }): Promise<CreatedToken> =>
    (await apiRequest('POST', '/tokens', { body: t })) as CreatedToken,
  deleteToken: async (id: string): Promise<void> => {
    await apiRequest('DELETE', `/tokens/${enc(id)}`);
  },

  /** Opens a kiosk session from a kiosk link's token. */
  kiosk: async (token: string): Promise<void> => {
    await apiRequest('POST', '/auth/kiosk', { body: { token } });
  },
  /** Replaces a temporary password (no current password within the sign-in window). */
  replaceTemporaryPassword: async (next: string): Promise<void> => {
    await apiRequest('POST', '/auth/password', { body: { new: next } });
  },
};

export const accountKeys = {
  users: ['users'] as const,
  sessions: (id: number) => ['users', id, 'sessions'] as const,
  tokens: ['tokens'] as const,
};

export function useUsers(enabled = true): UseQueryResult<User[]> {
  return useQuery({ queryKey: accountKeys.users, queryFn: ({ signal }) => accountsApi.users(signal), enabled, refetchInterval: 30_000 });
}

export function useUserSessions(id: number): UseQueryResult<UserSession[]> {
  return useQuery({ queryKey: accountKeys.sessions(id), queryFn: ({ signal }) => accountsApi.sessions(id, signal) });
}

export function useTokens(enabled = true): UseQueryResult<ApiToken[]> {
  return useQuery({ queryKey: accountKeys.tokens, queryFn: ({ signal }) => accountsApi.tokens(signal), enabled });
}

/** Where a kiosk link opens (the token stays in the fragment, never sent to a server log). */
export function kioskUrl(token: string, origin: string = window.location.origin): string {
  return `${origin}/kiosk#${token}`;
}

/** Start of single sign-on: a full-page navigation to the hub, which redirects to the provider. */
export function ssoStartUrl(next: string, reauth = false): string {
  const qs = new URLSearchParams({ next });
  if (reauth) qs.set('reauth', '1');
  return `/api/v1/auth/oidc/start?${qs.toString()}`;
}
