/**
 * The GitHub connection (docs/github.md; Whombat essentials-agents.md EA-10): the burrow runs as the person who connected
 * it, on their own GitHub sign-in (`signins` provider `github`). Every repository that account owns is the burrow's
 * (Whombat agent-repos.md AGR-08); nobody picks them. GitHub changes reach the burrow through the server's poller (no
 * webhooks).
 */
import { z } from 'zod';
import { Timestamp } from '../domain/common.js';
import { BurrowParam, endpoint } from './endpoint.js';

const B = z.object({ burrow: BurrowParam });

/** Which GitHub the server talks to: GitHub itself (through `gh` on a person's sign-in), the in-memory fake (dev, tests, demo) or none. */
export const GitHubMode = z.enum(['gh', 'fake', 'off']);
export type GitHubMode = z.infer<typeof GitHubMode>;

/** A GitHub login (`acme`). */
export const GitHubLogin = z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/);

export const GitHubStatusResponse = z.object({
  mode: GitHubMode,
  /** The person connected this burrow; its repos are mirrored and the agent can push and open PRs. */
  connected: z.boolean(),
  /**
   * The account every GitHub action is performed as ("Connected as @login"). Null while the burrow is not connected.
   */
  login: GitHubLogin.nullable(),
  /** Why GitHub can't be reached (the person who connected it left, or their GitHub sign-in is gone). */
  error: z.string().max(500).nullable(),
  /** What fixes `error`, as a short action (“sign in to GitHub”, “connect GitHub”). */
  fix: z.string().max(200).nullable(),
  /** Something to fix that does not stop the connection (a missing `workflow` scope). */
  note: z.string().max(500).nullable(),
  /** The person may connect (with a GitHub sign-in of their own, when GitHub is not off). */
  canConnect: z.boolean(),
  /** When the poller last read this burrow's repos from GitHub. */
  polledAt: Timestamp.nullable(),
  /**
   * The caller has to sign in to GitHub themselves before connecting (CT-181): an owner without a GitHub sign-in of
   * their own. The app shows “Sign in to GitHub”.
   */
  signInNeeded: z.boolean(),
});
export type GitHubStatusResponse = z.infer<typeof GitHubStatusResponse>;

/** A repo the connected account can reach, for older apps' repo picker. */
export const GitHubRepoChoice = z.object({
  /** `acme/Whombat` */
  fullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
  description: z.string().max(280),
  language: z.string().max(40).nullable(),
  pushedAt: Timestamp.nullable(),
  private: z.boolean(),
  /** Already one of the burrow's repos (`api.repos.list`). */
  added: z.boolean(),
  /** Added and switched on for agents. */
  enabled: z.boolean(),
});
export type GitHubRepoChoice = z.infer<typeof GitHubRepoChoice>;

export const GitHubReposResponse = z.object({
  repos: z.array(GitHubRepoChoice),
  /** More repos past `limit` (most recently pushed first). */
  hasMore: z.boolean(),
});
export type GitHubReposResponse = z.infer<typeof GitHubReposResponse>;

/** The square, in pixels, a GitHub owner's picture is fetched at (0.72, CT-328): two device pixels at 44. */
export const GITHUB_AVATAR_SIZE = 88;
/** Largest picture `github.avatar` passes on, decoded bytes; a larger one is left out (`image` null). */
export const GITHUB_AVATAR_MAX_BYTES = 48 * 1024;

/**
 * A GitHub owner's picture (0.72, CT-328): `image` is a `data:` URL (PNG, JPEG, GIF or WebP, sniffed from the bytes;
 * SVG never), drawn as an `<img>` like the providers' logos, since the strict CSP and offline boxes rule out loading it
 * from GitHub. Null when the Whombat couldn't fetch it (no internet, GitHub refused, too large): the client draws the
 * GitHub mark instead.
 */
export const GitHubAvatar = z.object({
  owner: GitHubLogin,
  image: z
    .string()
    .max(Math.ceil((GITHUB_AVATAR_MAX_BYTES * 4) / 3) + 64)
    .regex(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/)
    .nullable(),
});
export type GitHubAvatar = z.infer<typeof GitHubAvatar>;

export const githubEndpoints = {
  status: endpoint({
    id: 'github.status',
    method: 'GET',
    path: '/burrows/:burrow/github',
    summary:
      'Whether the burrow is connected to GitHub, and as whose GitHub account (or why it can’t be used).',
    params: B,
    response: GitHubStatusResponse,
  }),
  connect: endpoint({
    id: 'github.connect',
    method: 'POST',
    path: '/burrows/:burrow/github/connect',
    summary:
      'Connect the burrow with the caller’s own GitHub sign-in (key burrow.manage): records the login ' +
      '(signed “Connected GitHub as @login”). 409 when the caller has no GitHub sign-in.',
    params: B,
    response: GitHubStatusResponse,
  }),
  repos: endpoint({
    id: 'github.repos',
    method: 'GET',
    path: '/burrows/:burrow/github/repos',
    summary:
      'The repos the connected GitHub account can reach (its own and its organisations’), most recently pushed ' +
      'first, marked when already added to the burrow (older apps’ repo picker).',
    params: B,
    query: z.object({ limit: z.coerce.number().int().min(1).max(300).default(30) }),
    response: GitHubReposResponse,
  }),
  avatar: endpoint({
    id: 'github.avatar',
    method: 'GET',
    path: '/burrows/:burrow/github/owners/:owner/avatar',
    summary:
      'The picture of a GitHub owner whose repo the burrow has or an automation watches (0.72, CT-328), ' +
      `${GITHUB_AVATAR_SIZE} pixels square, fetched by the Whombat and kept for a day. 404 for any other owner.`,
    params: z.object({ burrow: BurrowParam, owner: GitHubLogin }),
    response: GitHubAvatar,
  }),
};
