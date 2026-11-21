/**
 * Types of the desk socket's shapes (`@whombat/control-contracts/local`, contracts 0.101.0), for those its schemas
 * don't export as types.
 */
import type {
  DeskAck as DeskAckSchema,
  DeskAsk as DeskAskSchema,
  DeskBox as DeskBoxSchema,
  DeskFound as DeskFoundSchema,
  DeskGlance as DeskGlanceSchema,
  DeskLockState as DeskLockStateSchema,
  DeskLook as DeskLookSchema,
  DeskMeter as DeskMeterSchema,
  DeskPhoneUnlockAnswer as DeskPhoneUnlockAnswerSchema,
  DeskPower as DeskPowerSchema,
  DeskServer as DeskServerSchema,
  DeskTile as DeskTileSchema,
  DeskTouchAnswer as DeskTouchAnswerSchema,
} from '@whombat/control-contracts/local';
import type { z } from 'zod';

export type DeskAck = z.infer<typeof DeskAckSchema>;
export type DeskAsk = z.infer<typeof DeskAskSchema>;
export type DeskBox = z.infer<typeof DeskBoxSchema>;
export type DeskFound = z.infer<typeof DeskFoundSchema>;
export type DeskGlance = z.infer<typeof DeskGlanceSchema>;
export type DeskLockState = z.infer<typeof DeskLockStateSchema>;
export type DeskLook = z.infer<typeof DeskLookSchema>;
export type DeskMeter = z.infer<typeof DeskMeterSchema>;
export type DeskPhoneUnlockAnswer = z.infer<typeof DeskPhoneUnlockAnswerSchema>;
export type DeskPower = z.infer<typeof DeskPowerSchema>;
export type DeskServer = z.infer<typeof DeskServerSchema>;
export type DeskTile = z.infer<typeof DeskTileSchema>;
export type DeskTouchAnswer = z.infer<typeof DeskTouchAnswerSchema>;
