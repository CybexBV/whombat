/** Burrows (tenants) and accounts. */
import type {
  AgentProvider,
  BackupCategoryId,
  LiveProvider,
  LocalModelCheck,
  Preferences,
  WebSearchCheck,
  WebSearchProvider,
} from '@whombat/core';
import { sql } from 'drizzle-orm';
import { boolean, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { ts } from './common';

export interface OnboardingProgress {
  /** The step: 0 name, 1 set up your AI, 2 meet your agent (one-person.md OP-S03; one-agent.md OA-13). */
  step: number;
  /** The AI provider picked in “Set up your AI” (absent in progress saved before that step existed). */
  provider?: AgentProvider | null;
  /** The AI clients the person chose in “Set up your AI”, in the order picked (CT-68). */
  clients?: LiveProvider[];
  githubConnected: boolean;
  completedAt: string | null;
}

/** Onboarding's last step, “Meet your agent” (OP-S03): three steps, no “Invite people”. */
export const ONBOARDING_LAST_STEP = 2;

/** A stored step as one of the three (an older one is clamped). */
export function onboardingStepOf(o: Pick<OnboardingProgress, 'step'>): number {
  return Math.max(0, Math.min(ONBOARDING_LAST_STEP, Math.trunc(o.step)));
}

export const burrows = pgTable('burrows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  timeZone: text('time_zone').notNull().default('UTC'),
  onboarding: jsonb('onboarding')
    .$type<OnboardingProgress>()
    .notNull()
    .default({ step: 0, githubConnected: false, completedAt: null }),
  createdByAccountId: text('created_by_account_id'),
  createdAt: ts('created_at').notNull().defaultNow(),
  /**
   * Link previews under messages (docs/decisions/essentials-conversations.md EC-21): null or true = on, false = off
   * (the person, `burrows.update`).
   */
  linkPreviews: boolean('link_previews'),
  /**
   * “Agents may reach your local network” (docs/decisions/resourceful-agents.md RA-41): null or true = on, false = off
   * (the person, `burrows.setAgentsReachLan`).
   */
  agentsReachLan: boolean('agents_reach_lan'),
  /**
   * The AI gateway's two switches (docs/decisions/ai-gateway.md AIG-05): which gateway connection and whether Claude
   * Code and Codex turns go through it (the person, `burrows.setAiGateway`). Null: none set (both off). Removing the
   * connection clears it.
   */
  aiGateway: jsonb('ai_gateway').$type<StoredAiGateway>(),
  /**
   * The model on the person's network (docs/decisions/hermes-engine.md HE-08, HE-32; contracts CT-1170): its base URL,
   * model, name and last test (the person, `burrows.setLocalModel`). Null: none set. Its key is `localModelKeyEnc`.
   */
  localModel: jsonb('local_model').$type<StoredLocalModel>(),
  /**
   * The local model's API key, sealed with key custody (`burrow_local_model:<burrow id>:key`); null: none. Only the
   * runner (for a turn on `local`) and a backup file get it opened, never a client.
   */
  localModelKeyEnc: text('local_model_key_enc'),
  /**
   * Web search for the agent (docs/decisions/web-search.md): its service and last check (the person,
   * `burrows.setWebSearch`). Null: off. Its key is `webSearchKeyEnc`.
   */
  webSearch: jsonb('web_search').$type<StoredWebSearch>(),
  /**
   * The Brave Search API key, sealed with key custody (`burrow_web_search:<burrow id>:key`); null: none. Only the
   * runner (for the person's turns) and a backup file get it opened, never a client.
   */
  webSearchKeyEnc: text('web_search_key_enc'),
  /**
   * The disk alert the person last heard (docs/decisions/box-status.md BS-09, BS-D02): 0 (none), 85 or 95
   * percent of the appliance's data disk used. Kept by the runtime's disk check (`hostDiskAlertDue`), so a restart
   * doesn't say it again.
   */
  hostDiskAlert: integer('host_disk_alert').notNull().default(0),
  /**
   * What the person last heard about the power (docs/decisions/desk-display.md DK-10, desk-display-server.md
   * DK-S12): 0 nothing, 1 the power is out, 2 the battery is low. Kept by the runtime's power check, so a restart after a
   * clean shutdown on battery still says the power is back.
   */
  hostPowerAlert: integer('host_power_alert').notNull().default(0),
  /**
   * The categories a new backup file starts with in this burrow (docs/decisions/backup-file.md BF-09): the person's “Make
   * these the default”; null = the starting seven (`BACKUP_DEFAULT_CATEGORIES`). `backupDefaultsAt`: when they chose.
   */
  backupDefaults: jsonb('backup_defaults').$type<BackupCategoryId[]>(),
  backupDefaultsAt: ts('backup_defaults_at'),
  /**
   * The agent's notes (docs/decisions/hermes-engine.md HE-39, HE-S120): one text the person writes (Settings → Agent →
   * Notes), put in the prompt of the person's turns (one-person.md OP-S64). Null: none written.
   */
  agentNotes: jsonb('agent_notes').$type<StoredAgentNotes>(),
  /**
   * The quiet hours for changes (docs/decisions/care-plan.md), `HH:MM` in `time_zone`: when updates, restarts and an
   * approval's *Tonight* happen. Null: never moved (03:00–05:00).
   */
  changeWindowStart: text('change_window_start'),
  changeWindowEnd: text('change_window_end'),
  /**
   * The servers this Whombat had before care plans were made still need writing down as known (care-plan.md): true on
   * a Whombat from before, until its first read of the servers. A new Whombat starts with none, so every server it gets
   * is new.
   */
  careBaselineDue: boolean('care_baseline_due').notNull().default(false),
});

/** `burrows.agent_notes` (HE-S120): the text, when it last changed and by whom (a principal id). */
export interface StoredAgentNotes {
  text: string;
  updatedAt: string;
  updatedById: string | null;
}

/** `burrows.ai_gateway` (AIG-05): the gateway connection the switches point to, and the switches. */
export interface StoredAiGateway {
  connectionId: string;
  claude: boolean;
  codex: boolean;
}

/**
 * `burrows.local_model` (CT-1170): the model on the person's network without its key. `updatedAt` changes with every
 * save, so a test that ran while it changed isn't kept for the new one.
 */
export interface StoredLocalModel {
  baseUrl: string;
  model: string;
  label: string | null;
  check: LocalModelCheck | null;
  updatedAt: string;
}

/** `burrows.web_search`: web search without its key. `updatedAt` changes with every save. */
export interface StoredWebSearch {
  provider: WebSearchProvider;
  check: WebSearchCheck | null;
  updatedAt: string;
}

/** A login identity. Email is stored lowercased. */
export const accounts = pgTable('accounts', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name').notNull().default(''),
  /** "Engineering lead"; '' when not given. New burrows' persons take it. */
  title: text('title').notNull().default(''),
  preferences: jsonb('preferences')
    .$type<Preferences>()
    .notNull()
    .default({ theme: 'system', timeZone: null }),
  createdAt: ts('created_at').notNull().defaultNow(),
  /**
   * When the email was last proven (an emailed code or link, a host-issued link, Tailscale). Null: the account
   * was made by opening an invite link and nobody has proven the address since (AH-05).
   */
  emailVerifiedAt: ts('email_verified_at'),
  /**
   * Managed appliance (MA-04 §6): bumps on endpoint revocation; sessions and event cursors of an older generation are
   * closed / answered `snapshot_required`.
   */
  /**
   * Managed: the account's authorization generation, from the appliance-wide `authz_generation_seq` (MR-36): unique
   * across accounts, bumped to the next value on every revocation.
   */
  authzGeneration: integer('authz_generation').notNull().default(sql`nextval('authz_generation_seq')`),
  /** When the last notification email went to this account (essentials-people.md EP-15: at most one an hour). */
  notificationsEmailedAt: ts('notifications_emailed_at'),
  /**
   * The account's photo (docs/decisions/person-avatars.md PVA-04): what its blob in the file store is, so a person made
   * later for the account (a new burrow) gets it too. The account keeps the blob (the sweep
   * leaves it). Null: no photo, the initials.
   */
  avatar: jsonb('avatar').$type<AccountAvatar>(),
});

/** A photo's bytes as the account keeps them: the blob's sha256 and what the sniffer read (PV-04). */
export interface AccountAvatar {
  sha256: string;
  contentType: string;
  size: number;
  width: number;
  height: number;
}
