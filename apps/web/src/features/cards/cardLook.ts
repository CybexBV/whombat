/**
 * How a conversation draws its cards (one-whombat-shell.md AP-1260): `room` as the crew's conversations do, `chat` in a
 * task chat with Whombat — a plan as the compact list of steps of mock 3, whatever its state.
 */
import { createContext, useContext } from 'react';

export type CardLook = 'room' | 'chat';

export const CardLookContext = createContext<CardLook>('room');

export function useCardLook(): CardLook {
  return useContext(CardLookContext);
}

/** The person's time zone for a card's own time (its status line); `MessageCard` gives it from the bootstrap. */
export const CardTimeZoneContext = createContext<string>('Europe/Amsterdam');

export function useCardTimeZone(): string {
  return useContext(CardTimeZoneContext);
}

/**
 * A card shown as it was earlier on a message (card-moves.md): its status says so, and its buttons, menu and
 * Details don't show; the thread also makes it inert, so nothing in it acts on the live card.
 */
export const CardStillContext = createContext(false);

export function useCardStill(): boolean {
  return useContext(CardStillContext);
}
