/**
 * A Find My connection's timeline (docs/implementation/macos/findmy-timeline.md): where the people the person ticked
 * were, kept on the box for 30 days. Spread into `api.connections` (op names `connections.findMyTimeline…`): the
 * timeline belongs to the Find My connection, under its own path. Only the box's person (an owner's route, as
 * `hosts.findMy`); never on the desk display, an Overview tile, a share link or in outsiders' turns. Whether the
 * assistant can read it is the `findmy_timeline` tool's tier (`connections.setTool`).
 */
import { z } from 'zod';
import {
  FindMyTimeline,
  FindMyTimelineChanged,
  FindMyTimelineDeleteBody,
  FindMyTimelineMap,
  FindMyTimelineMapQuery,
  FindMyTimelineQuery,
  FindMyTimelineSetBody,
} from '../domain/findmy-timeline.js';
import { ConnectionId } from '../ids.js';
import { BurrowParam, endpoint } from './endpoint.js';

const BC = z.object({ burrow: BurrowParam, connectionId: ConnectionId });

/** Merged into `api.connections` (op names `connections.<action>`). */
export const findMyTimelineEndpoints = {
  findMyTimeline: endpoint({
    id: 'connections.findMyTimeline',
    method: 'GET',
    path: '/burrows/:burrow/connections/:connectionId/find-my/timeline',
    summary:
      'A Find My connection’s timeline: for each day asked (one, or up to seven ending on `date`, in the viewer’s time zone) each kept person’s stays, trips and gaps; everyone on the Mac’s last read and whether each is kept; how often it reads, when it last read and whether the assistant can read it. Can be larger than one session message: clients read it through an export stream.',
    params: BC,
    query: FindMyTimelineQuery,
    response: FindMyTimeline,
  }),
  findMyTimelineSet: endpoint({
    id: 'connections.findMyTimelineSet',
    method: 'PUT',
    path: '/burrows/:burrow/connections/:connectionId/find-my/timeline',
    summary:
      'Choose whose days a Find My connection keeps: someone unticked loses their days, and no one stops the timeline and deletes everything. Signs `findmy.timeline_set` with names only.',
    params: BC,
    body: FindMyTimelineSetBody,
    response: FindMyTimelineChanged,
  }),
  findMyTimelineDelete: endpoint({
    id: 'connections.findMyTimelineDelete',
    method: 'POST',
    path: '/burrows/:burrow/connections/:connectionId/find-my/timeline/delete',
    summary:
      'Delete every day a Find My connection’s timeline kept so far; whose days it keeps stays. Signs `findmy.timeline_deleted`.',
    params: BC,
    body: FindMyTimelineDeleteBody,
    response: FindMyTimelineChanged,
  }),
  findMyTimelineMap: endpoint({
    id: 'connections.findMyTimelineMap',
    method: 'GET',
    path: '/burrows/:burrow/connections/:connectionId/find-my/timeline/map',
    summary:
      'A map picture drawn by the connection’s Mac around one person’s stops of one day, and where each pin is on it with the stops it stands for. 409 `find_my_no_places` when the day has no spot. Larger than one session message: clients read it through an export stream.',
    params: BC,
    query: FindMyTimelineMapQuery,
    response: FindMyTimelineMap,
  }),
};
