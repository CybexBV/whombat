// Guest configuration and lifecycle (Proxmox VE, Incus): types, calls and
// query hooks of the "manage" endpoints (docs/MANAGE.md, docs/REST-API.md).
// Everything here needs the host's Manage switch (hub and agent.toml) and
// operator access; create, clone, convert to template, delete, restore,
// downloads and HA need an admin and a recent sign-in (the client's reauth
// handler asks and retries).

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { ApiError, apiRequest } from './client';
import { LIVE_REFRESH_MS } from './queries';
import type { Guest } from './types';

export type {
  ManagePlatform,
  GuestConfig,
  GuestDisk,
  ConfigChange,
  ConfigPatch,
  TaskRef,
  ManageResult,
  ChoiceStorage,
  StorageVolume,
  TemplateGuest,
  IncusImage,
  Choices,
  BackupVolume,
  Appliance,
  TaskState,
  TaskStatus,
  FirewallRule,
  GuestFirewall,
  HASettings,
  HAState,
  ReplicationJob,
  CreateGuestInput,
  CloneInput,
  BackupInput,
  RestoreInput,
  DownloadInput,
} from './manage-types';
import type {
  ManagePlatform,
  GuestConfig,
  ConfigPatch,
  ManageResult,
  StorageVolume,
  Choices,
  BackupVolume,
  Appliance,
  TaskStatus,
  FirewallRule,
  GuestFirewall,
  HASettings,
  CreateGuestInput,
  CloneInput,
  BackupInput,
  RestoreInput,
  DownloadInput,
} from './manage-types';

// ------------------------------------------------------------------ calls

const e = encodeURIComponent;
const srv = (serverId: string) => `/servers/${e(serverId)}`;
const gst = (serverId: string, guestId: string) => `${srv(serverId)}/guests/${e(guestId)}`;
const res = (v: unknown) => (v ?? { ok: true }) as ManageResult;

export const manageApi = {
  /** One guest from the host's latest report (GET /servers/{id}/guests/{guestId}). */
  guest: async (serverId: string, guestId: string, signal?: AbortSignal): Promise<Guest> => (await apiRequest('GET', gst(serverId, guestId), { signal })) as Guest,

  config: async (serverId: string, guestId: string, signal?: AbortSignal): Promise<GuestConfig> =>
    (await apiRequest('GET', `${gst(serverId, guestId)}/config`, { signal })) as GuestConfig,
  setConfig: async (serverId: string, guestId: string, patch: ConfigPatch): Promise<ManageResult> =>
    res(await apiRequest('PUT', `${gst(serverId, guestId)}/config`, { body: patch })),
  resizeDisk: async (serverId: string, guestId: string, disk: string, size: string): Promise<ManageResult> =>
    res(await apiRequest('POST', `${gst(serverId, guestId)}/disks/${e(disk)}/resize`, { body: { size } })),
  moveDisk: async (serverId: string, guestId: string, disk: string, storage: string, deleteSource: boolean): Promise<ManageResult> =>
    res(await apiRequest('POST', `${gst(serverId, guestId)}/disks/${e(disk)}/move`, { body: { storage, delete_source: deleteSource } })),

  choices: async (serverId: string, platform: ManagePlatform, signal?: AbortSignal): Promise<Choices> =>
    (await apiRequest('GET', `${srv(serverId)}/manage/choices`, { params: { platform }, signal })) as Choices,

  create: async (serverId: string, input: CreateGuestInput): Promise<ManageResult> => res(await apiRequest('POST', `${srv(serverId)}/guests`, { body: input })),
  clone: async (serverId: string, guestId: string, input: CloneInput): Promise<ManageResult> =>
    res(await apiRequest('POST', `${gst(serverId, guestId)}/clone`, { body: input })),
  convertToTemplate: async (serverId: string, guestId: string): Promise<ManageResult> =>
    res(await apiRequest('POST', `${gst(serverId, guestId)}/template`, { body: { confirm: true } })),
  deleteGuest: async (serverId: string, guestId: string, confirmName: string, purge: boolean): Promise<ManageResult> =>
    res(await apiRequest('DELETE', gst(serverId, guestId), { params: { confirm_name: confirmName, purge: purge ? 1 : undefined } })),

  backups: async (serverId: string, guestId: string, signal?: AbortSignal): Promise<BackupVolume[]> =>
    ((await apiRequest('GET', `${gst(serverId, guestId)}/backups`, { signal })) as { items?: BackupVolume[] } | null)?.items ?? [],
  backup: async (serverId: string, guestId: string, input: BackupInput): Promise<ManageResult> =>
    res(await apiRequest('POST', `${gst(serverId, guestId)}/backups`, { body: input })),
  restore: async (serverId: string, input: RestoreInput): Promise<ManageResult> => res(await apiRequest('POST', `${srv(serverId)}/backups/restore`, { body: input })),
  updateBackup: async (serverId: string, platform: ManagePlatform, volume: string, patch: { notes?: string; protected?: boolean }): Promise<ManageResult> =>
    res(await apiRequest('PATCH', `${srv(serverId)}/backups`, { body: { platform, volume, ...patch } })),
  deleteBackup: async (serverId: string, platform: ManagePlatform, volume: string): Promise<ManageResult> =>
    res(await apiRequest('DELETE', `${srv(serverId)}/backups`, { params: { platform, volume } })),

  content: async (serverId: string, platform: ManagePlatform, storage: string, content: StorageVolume['content'], signal?: AbortSignal): Promise<StorageVolume[]> =>
    ((await apiRequest('GET', `${srv(serverId)}/storage/${e(storage)}/content`, { params: { platform, content }, signal })) as { items?: StorageVolume[] } | null)?.items ?? [],
  download: async (serverId: string, storage: string, input: DownloadInput): Promise<ManageResult> =>
    res(await apiRequest('POST', `${srv(serverId)}/storage/${e(storage)}/download`, { body: input })),
  deleteContent: async (serverId: string, platform: ManagePlatform, volume: string): Promise<ManageResult> =>
    res(await apiRequest('DELETE', `${srv(serverId)}/storage/content`, { params: { platform, volume } })),
  appliances: async (serverId: string, platform: ManagePlatform, signal?: AbortSignal): Promise<Appliance[]> =>
    ((await apiRequest('GET', `${srv(serverId)}/appliances`, { params: { platform }, signal })) as { items?: Appliance[] } | null)?.items ?? [],
  downloadAppliance: async (serverId: string, platform: ManagePlatform, storage: string, template: string): Promise<ManageResult> =>
    res(await apiRequest('POST', `${srv(serverId)}/storage/${e(storage)}/appliances`, { body: { platform, template } })),

  guestTasks: async (serverId: string, guestId: string, signal?: AbortSignal): Promise<TaskStatus[]> =>
    ((await apiRequest('GET', `${gst(serverId, guestId)}/tasks`, { signal })) as { items?: TaskStatus[] } | null)?.items ?? [],
  hostTasks: async (serverId: string, platform: ManagePlatform, signal?: AbortSignal): Promise<TaskStatus[]> =>
    ((await apiRequest('GET', `${srv(serverId)}/tasks`, { params: { platform }, signal })) as { items?: TaskStatus[] } | null)?.items ?? [],
  /** One task with its log from line logStart on (-1: without the log). */
  task: async (serverId: string, platform: ManagePlatform, taskId: string, logStart = 0, signal?: AbortSignal): Promise<TaskStatus> =>
    (await apiRequest('GET', `${srv(serverId)}/tasks/${e(taskId)}`, { params: { platform, log_start: logStart }, signal })) as TaskStatus,
  stopTask: async (serverId: string, platform: ManagePlatform, taskId: string): Promise<void> => {
    await apiRequest('DELETE', `${srv(serverId)}/tasks/${e(taskId)}`, { params: { platform } });
  },

  firewall: async (serverId: string, guestId: string, signal?: AbortSignal): Promise<GuestFirewall> =>
    (await apiRequest('GET', `${gst(serverId, guestId)}/firewall`, { signal })) as GuestFirewall,
  setFirewallOptions: async (serverId: string, guestId: string, patch: { digest?: string; set?: Record<string, string>; delete?: string[] }): Promise<ManageResult> =>
    res(await apiRequest('PUT', `${gst(serverId, guestId)}/firewall/options`, { body: patch })),
  addFirewallRule: async (serverId: string, guestId: string, rule: Omit<FirewallRule, 'pos'> & { pos?: number }): Promise<ManageResult> =>
    res(await apiRequest('POST', `${gst(serverId, guestId)}/firewall/rules`, { body: { rule } })),
  updateFirewallRule: async (serverId: string, guestId: string, pos: number, body: { digest?: string; rule?: FirewallRule; move_to?: number }): Promise<ManageResult> =>
    res(await apiRequest('PUT', `${gst(serverId, guestId)}/firewall/rules/${pos}`, { body })),
  deleteFirewallRule: async (serverId: string, guestId: string, pos: number, digest?: string): Promise<ManageResult> =>
    res(await apiRequest('DELETE', `${gst(serverId, guestId)}/firewall/rules/${pos}`, { params: { digest } })),

  setHA: async (serverId: string, guestId: string, ha: HASettings): Promise<ManageResult> => res(await apiRequest('PUT', `${gst(serverId, guestId)}/ha`, { body: ha })),
  removeHA: async (serverId: string, guestId: string): Promise<ManageResult> => res(await apiRequest('DELETE', `${gst(serverId, guestId)}/ha`)),
  addReplication: async (serverId: string, guestId: string, job: { target: string; schedule?: string; rate?: string; comment?: string }): Promise<ManageResult> =>
    res(await apiRequest('POST', `${gst(serverId, guestId)}/replication`, { body: job })),
  deleteReplication: async (serverId: string, guestId: string, jobId: string): Promise<ManageResult> =>
    res(await apiRequest('DELETE', `${gst(serverId, guestId)}/replication/${e(jobId)}`)),
};

// ------------------------------------------------------------------ queries

/** Query keys, for invalidation after changes and task.finished events. */
export const manageKeys = {
  /** Everything of one server (invalidate after a finished task). */
  server: (serverId: string) => ['manage', serverId] as const,
  config: (serverId: string, guestId: string) => ['manage', serverId, 'config', guestId] as const,
  choices: (serverId: string, platform: string) => ['manage', serverId, 'choices', platform] as const,
  backups: (serverId: string, guestId: string) => ['manage', serverId, 'backups', guestId] as const,
  content: (serverId: string, storage: string, content: string) => ['manage', serverId, 'content', storage, content] as const,
  appliances: (serverId: string) => ['manage', serverId, 'appliances'] as const,
  guestTasks: (serverId: string, guestId: string) => ['manage', serverId, 'tasks', guestId] as const,
  hostTasks: (serverId: string) => ['manage', serverId, 'tasks'] as const,
  firewall: (serverId: string, guestId: string) => ['manage', serverId, 'firewall', guestId] as const,
};

/** Retry only what may pass on a second try: not refusals (4xx) or what the platform cannot do (501). */
const retry = (count: number, err: Error) => !(err instanceof ApiError && (err.status < 500 || err.status === 501)) && count < 2;

export function useGuest(serverId: string, guestId: string): UseQueryResult<Guest> {
  return useQuery({ retry, queryKey: ['guest', serverId, guestId], queryFn: ({ signal }) => manageApi.guest(serverId, guestId, signal), refetchInterval: LIVE_REFRESH_MS });
}

export function useGuestConfig(serverId: string, guestId: string, enabled = true): UseQueryResult<GuestConfig> {
  return useQuery({ retry, queryKey: manageKeys.config(serverId, guestId), queryFn: ({ signal }) => manageApi.config(serverId, guestId, signal), enabled, staleTime: 5_000 });
}

export function useChoices(serverId: string, platform: ManagePlatform, enabled = true): UseQueryResult<Choices> {
  return useQuery({ retry, queryKey: manageKeys.choices(serverId, platform), queryFn: ({ signal }) => manageApi.choices(serverId, platform, signal), enabled, staleTime: 30_000 });
}

export function useBackups(serverId: string, guestId: string, enabled = true): UseQueryResult<BackupVolume[]> {
  return useQuery({ retry, queryKey: manageKeys.backups(serverId, guestId), queryFn: ({ signal }) => manageApi.backups(serverId, guestId, signal), enabled, staleTime: 10_000 });
}

export function useStorageContent(serverId: string, platform: ManagePlatform, storage: string, content: StorageVolume['content'], enabled = true): UseQueryResult<StorageVolume[]> {
  return useQuery({
    retry,
    queryKey: manageKeys.content(serverId, storage, content),
    queryFn: ({ signal }) => manageApi.content(serverId, platform, storage, content, signal),
    enabled,
    staleTime: 10_000,
  });
}

export function useAppliances(serverId: string, platform: ManagePlatform, enabled = true): UseQueryResult<Appliance[]> {
  return useQuery({ retry, queryKey: manageKeys.appliances(serverId), queryFn: ({ signal }) => manageApi.appliances(serverId, platform, signal), enabled, staleTime: 5 * 60_000 });
}

export function useGuestTasks(serverId: string, guestId: string, enabled = true): UseQueryResult<TaskStatus[]> {
  return useQuery({ retry, queryKey: manageKeys.guestTasks(serverId, guestId), queryFn: ({ signal }) => manageApi.guestTasks(serverId, guestId, signal), enabled, refetchInterval: 10_000 });
}

export function useFirewall(serverId: string, guestId: string, enabled = true): UseQueryResult<GuestFirewall> {
  return useQuery({ retry, queryKey: manageKeys.firewall(serverId, guestId), queryFn: ({ signal }) => manageApi.firewall(serverId, guestId, signal), enabled, staleTime: 5_000 });
}
