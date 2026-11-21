/**
 * The reader of a pinned server-metric widget (home/widgets.ts): each refresh reads the server's last hour of metrics
 * from the hosts service as the person (a viewer) and keeps each series' newest value. Registered by `setUpHosts`.
 */
import type { WidgetSource } from '@whombat/core';
import { metricKey, WidgetReadError, type WidgetReader } from '../home/widgets';
import { HOSTS_API, HostsError, seg } from './client';
import { toHostSeries } from './map';
import { serverLabel } from './self';
import { actorOf, hostsFor } from './service';

/** Old names the service now splits (`net_mbps` was the fleet's sum): read as the sum of their parts. */
const SUMS: Readonly<Record<string, readonly string[]>> = {
  net_mbps: ['net_rx_mbps', 'net_tx_mbps'],
};

/** A series' newest measured value, or null. */
export function newestValue(points: readonly (number | null)[] | undefined): number | null {
  if (!points) return null;
  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    if (typeof p === 'number' && Number.isFinite(p)) return p;
  }
  return null;
}

/** The widget's values from the service's series: each name's newest value (a sum's when every part has one). */
export function metricValues(
  names: readonly string[],
  series: Readonly<Record<string, readonly (number | null)[]>>,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const name of names) {
    const own = newestValue(series[name]);
    const parts = SUMS[name];
    if (own !== null || !parts) {
      out[metricKey(name)] = own;
      continue;
    }
    const values = parts.map((p) => newestValue(series[p]));
    out[metricKey(name)] = values.every((v) => v !== null)
      ? (values as number[]).reduce((a, v) => a + v, 0)
      : null;
  }
  return out;
}

export const readServerMetric: WidgetReader = async (services, widget, person) => {
  const source = widget.source as WidgetSource;
  if (source.kind !== 'server_metric') throw new WidgetReadError('This widget can’t be read here.');
  const hosts = hostsFor(services);
  if (!(await hosts.serves(person.burrowId)))
    throw new WidgetReadError('Servers aren’t connected to this Whombat.');
  const wanted = [...new Set(source.series.flatMap((name) => [name, ...(SUMS[name] ?? [])]))];
  let raw: unknown;
  try {
    raw = await hosts.call<unknown>({
      path: `${HOSTS_API}/servers/${seg(source.serverId)}/metrics`,
      query: { range: '1h', series: wanted.join(',') },
      actor: actorOf(person, 'viewer'),
    });
  } catch (err) {
    if (err instanceof HostsError && err.status === 404)
      throw new WidgetReadError('That server isn’t in your servers any more.');
    throw new WidgetReadError(`Couldn’t read ${serverLabel(source.serverId)} just now.`);
  }
  const series = toHostSeries(raw, source.serverId, null, services.clock());
  const values = metricValues(source.series, series.series);
  if (Object.values(values).every((v) => v === null))
    throw new WidgetReadError(`${serverLabel(source.serverId)} had none of these figures in the last hour.`);
  return values;
};
