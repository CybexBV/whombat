/**
 * The agent's live face where it is there and doing something (a run's header, a new chat, an approval, its settings),
 * and the still face everywhere else (`WhombatAvatar`). `<LiveAgentFace>` is `<LiveFace>` with one addition: a browser that
 * tests drive (the visual suite, the browser journeys) gets faces that change pose without moving, so a screenshot
 * never catches a blink or half a gesture.
 */
import { type FaceMotionMode, LiveFace, type LiveFaceProps } from '@whombat/avatars/live';

const DRIVEN_BY_TESTS: FaceMotionMode | undefined =
  typeof navigator !== 'undefined' && navigator.webdriver ? 'reduced' : undefined;

export function LiveAgentFace(props: LiveFaceProps) {
  return <LiveFace {...props} motion={props.motion ?? DRIVEN_BY_TESTS} />;
}
