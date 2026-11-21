/**
 * What the health pass reads from an Unraid connection (sidebar.md SB-09): the server's own name, so the server Whombat
 * watches is found when the connection's address isn't the one the server reports (a second network card). Its page is
 * the server's (CP-10); nothing else is read here.
 */

import { externalEffect } from '../../commit/scope';
import { signedConnectionFetch } from '../../connections/http';
import type { CatalogConnectionRow } from '../../connections/types';
import type { Services } from '../../services';
import { KIND_DEADLINE_MS, problemOf, ReadProblem } from './read';

const HOSTNAME_QUERY = JSON.stringify({ query: '{ info { os { hostname } } }' });

/** The hostname in Unraid's answer (`{ data: { info: { os: { hostname } } } }`), or null. */
export function unraidHostnameOf(answer: unknown): string | null {
  const data = (answer as { data?: { info?: { os?: { hostname?: unknown } } } } | null)?.data;
  const name = data?.info?.os?.hostname;
  return typeof name === 'string' && name.trim() ? name.trim().slice(0, 120) : null;
}

/** Unraid's hostname as the connection reads it; a refusal or an error is a `ReadProblem`. */
export async function unraidHostname(services: Services, row: CatalogConnectionRow): Promise<string | null> {
  const url = `${row.baseUrl.replace(/\/+$/, '')}/graphql`;
  let res: Awaited<ReturnType<typeof signedConnectionFetch>>;
  try {
    res = await externalEffect(
      'things.read',
      () =>
        signedConnectionFetch(
          services,
          row,
          {
            method: 'POST',
            url,
            headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: HOSTNAME_QUERY,
          },
          { maxBytes: 64 * 1024, deadlineMs: KIND_DEADLINE_MS },
        ),
      { idempotent: true },
    );
  } catch (err) {
    throw problemOf(err, 'Unraid');
  }
  if (res.status === 401 || res.status === 403)
    throw new ReadProblem('Unraid refused Whombat’s sign-in.', res.status === 401);
  if (res.status >= 400) throw new ReadProblem('Unraid answered with an error.');
  try {
    return unraidHostnameOf(JSON.parse(res.body.toString('utf8')));
  } catch {
    throw new ReadProblem('Unraid answered with something Whombat can’t read.');
  }
}
