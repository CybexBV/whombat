/**
 * A sample shared copy for fixture mode and tests (`/s/<id>#<key>`): sealed here with the location's own id and key, so
 * the page opens it exactly as it opens one from control.
 */
import { parseShareLocation, type SharedSnapshot, sealSnapshot } from '@whombat/core/share';

const at = (minutes: number) => Date.UTC(2026, 10, 5, 9, minutes);

export const SAMPLE_SNAPSHOT: SharedSnapshot = {
  v: 1,
  title: 'A weekend in Lisbon in May',
  sharedAt: at(40),
  person: { name: 'Mara' },
  assistant: { name: 'Dusty', face: 'dusty' },
  messages: [
    {
      from: 'person',
      at: at(2),
      text: 'Can you plan a long weekend in Lisbon in May? Two of us, not too expensive.',
    },
    {
      from: 'assistant',
      at: at(4),
      text: 'May is a good time: warm, and before the summer crowds.\n\n**Friday** — Alfama and the castle, dinner in Mouraria.\n**Saturday** — tram 28 to Estrela, then LX Factory.\n**Sunday** — Belém in the morning, the river at sunset.\n\nFlights from Amsterdam start around €90 each if you book this month.',
    },
    { from: 'person', at: at(9), text: 'Where should we stay?' },
    {
      from: 'assistant',
      at: at(11),
      text: 'Stay in **Príncipe Real** or **Chiado**: quiet at night, a short walk to everything above. Expect €110–140 a night for a double.',
    },
  ],
  pictures: [],
};

export function fixtureSharedFetcher(location: { pathname: string; hash: string }) {
  return async (id: string): Promise<Uint8Array | null> => {
    const parsed = parseShareLocation(location.pathname, location.hash);
    if (!parsed) return null;
    return sealSnapshot(SAMPLE_SNAPSHOT, id, parsed.key);
  };
}
