// GET /events: a Server-Sent Events stream per browser (CONTRACT 5). Events
// are pushed only to the streams of the browser whose action caused them.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FxResponse } from './http.ts';
import type { BrowserState, EventRec, FixtureStore } from './state.ts';

const BACKLOG = 200;
export const KEEPALIVE_MS = 15_000;

function frame(ev: EventRec): string {
  return `id: ${ev.id}\nevent: ${ev.name}\ndata: ${ev.data}\n\n`;
}

/** Publish an event to this browser's open streams (and keep it for Last-Event-ID). */
export function pushEvent(st: BrowserState, name: string, data: unknown): EventRec {
  const ev: EventRec = { id: ++st.seq.event, name, data: JSON.stringify(data) };
  st.events.backlog.push(ev);
  if (st.events.backlog.length > BACKLOG) st.events.backlog.shift();
  for (const res of st.events.clients) res.write(frame(ev));
  return ev;
}

/** The SSE response; `lastId` from Last-Event-ID (or ?last_event_id=). */
export function eventStream(store: FixtureStore, st: BrowserState, lastId: number | null): FxResponse {
  return {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
    stream: (req: IncomingMessage, res: ServerResponse) => {
      res.write('retry: 5000\n\n');
      if (lastId !== null) {
        // Missed events: replay them, or ask for a full refetch when they are
        // gone (or the id is from before a dev-server restart), like the hub.
        const oldest = st.events.backlog[0]?.id ?? st.seq.event + 1;
        if (lastId > st.seq.event || lastId + 1 < oldest) res.write(`id: ${st.seq.event}\nevent: resync\ndata: {}\n\n`);
        else for (const ev of st.events.backlog) if (ev.id > lastId) res.write(frame(ev));
      }
      st.events.clients.add(res);
      const keep = setInterval(() => {
        st.lastSeenReal = store.now();
        res.write(': keep-alive\n\n');
      }, KEEPALIVE_MS);
      const done = () => {
        clearInterval(keep);
        st.events.clients.delete(res);
      };
      req.on('close', done);
      res.on('close', done);
    },
  };
}
