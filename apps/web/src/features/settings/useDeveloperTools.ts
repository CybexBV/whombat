/**
 * Whether this Whombat is also used for software (settings-groups.md): GitHub is connected, or a website
 * sends feedback. Only then do the developer's places show — Inbox, Deploys, Canvases, the audit log's link, search's
 * Patches and Runs, and Chat's “settle when its code is merged” — so a home user never meets them. Their pages stay
 * where they are for anyone with a link. While it is still being asked the answer is false: nothing developer-only
 * flashes in.
 */
import { useFeedbackIntegrations, useGitHubStatus, useRepos } from '@whombat/client/react';

export function useDeveloperTools(burrow: string): boolean {
  const github = useGitHubStatus({ params: { burrow } }, { retry: false });
  const repos = useRepos({ params: { burrow } }, { retry: false });
  const feedback = useFeedbackIntegrations({ params: { burrow } }, { retry: false });
  const githubOn = github.data?.connected ?? repos.data?.githubConnected ?? false;
  return githubOn || (feedback.data?.integrations.length ?? 0) > 0;
}
