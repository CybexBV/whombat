/**
 * A question asked at the desk screen (Whombat desk-display.md DK-06, DK-85; desk-display-talk.md DK-T05;
 * desk-display-server.md DK-S89): the person spoke or typed it at the screen on their desk (`DispatchContext.desk`),
 * which shows the answer and reads it aloud. The turn gets one line asking for an answer that reads well aloud, and one
 * more when they asked from a server's own screen: which server they were looking at, so “it” means that one. Pure.
 */
import type { DispatchContext } from '@whombat/core';

/** The lines for a desk question (`asker`: the person's first name); nothing for any other turn. */
export function deskTurnLines(context: Pick<DispatchContext, 'desk'>, asker: string): string[] {
  const desk = context.desk;
  if (!desk) return [];
  const lines = [
    `This came from the screen on ${asker}’s desk${desk.spoken ? ', by voice' : ''}: answer in one message of one or two short sentences that read well aloud — no lists, links, tables or code.`,
  ];
  if (desk.server)
    lines.push(
      `${asker} asked while looking at the server ${desk.server.name} (server id ${desk.server.id}) on that screen, so “it” and “this server” mean ${desk.server.name}.`,
    );
  return lines;
}
