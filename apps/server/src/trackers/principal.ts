/**
 * The burrow's tracker system principal (docs/decisions/report-trackers.md TA-07): an agent-shaped principal named
 * “Report trackers” (`principals.system = 'tracker'`) that signs a new report's `tracker.item_opened`. Its signature
 * attests that Whombat saw the report in its tracker, never who sent it. Made on first use, like GitHub's and
 * Feedback's: one per burrow, not on the roster, no keys, no channels, never dispatched. Clients see it as `system:
 * 'feedback'` (TA-D02: `Principal.system` is a closed enum older clients parse strictly).
 */
import { burrowSystemPrincipal } from '../domain/system-principals';

/** `principals.system` of the tracker signer. */
export const SYSTEM_TRACKER = 'tracker';

const signer = burrowSystemPrincipal({
  system: SYSTEM_TRACKER,
  name: 'Report trackers',
  handle: 'trackers',
  doing: 'Notices new reports in your trackers for the automations that listen to them.',
  job: 'Notices new reports your customers send through your trackers, so automations can assess them.',
  line: { type: 'tracker.system_principal', where: 'Report trackers' },
});

/** Whether a principal row is the tracker signer. */
export const isTrackerPrincipal = signer.is;

/** The tracker principal inside an open session of `session.burrowId`, made with its signed line if missing. */
export const trackerPrincipalIn = signer.inSession;
