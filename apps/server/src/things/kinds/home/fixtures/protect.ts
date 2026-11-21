/**
 * UniFi Protect's integration API as its OpenAPI document (developer.ui.com/protect v7.3.70) describes the answers, with
 * its own example ids and names, cut to the fields Whombat reads (no Protect console here to read a real one): cameras,
 * the application's version, the NVR's arm mode, an arm profile, sensors and lights, and event-stream messages
 * (`/v1/subscribe/events`).
 */
const camera = (id: string, name: string, state: string) => ({
  id,
  modelKey: 'camera',
  state,
  name,
  type: 'UVC G4 Doorbell Pro',
  mac: '24A43C3DFEB9',
  isMicEnabled: true,
  featureFlags: {
    smartDetectTypes: ['person', 'vehicle', 'package'],
    smartDetectAudioTypes: ['alrmSmoke'],
    hasMic: true,
  },
  hasPackageCamera: false,
});

export const PROTECT_cameras = [
  camera('66d025b301ebc903e80003ea', 'Front Door', 'CONNECTED'),
  camera('672094f900e26303e800062a', 'Office Entrance', 'CONNECTED'),
  camera('672094f900e26303e8000700', 'Server Room', 'DISCONNECTED'),
];

export const PROTECT_info = { applicationVersion: '7.3.70' };

export const PROTECT_nvr = {
  id: '66d025b301ebc903e80003ea',
  modelKey: 'nvr',
  name: 'UNVR Pro',
  type: 'UNVR-PRO',
  mac: 'D021F98B6AED',
  armMode: {
    status: 'disabled',
    armProfileId: null,
    armedAt: null,
    willBeArmedAt: null,
    breachDetectedAt: null,
    breachEventCount: 0,
    breachTriggerEventId: null,
    breachEventId: null,
  },
};

export const PROTECT_profiles = [
  {
    id: '66d025b301ebc903e80003ea',
    name: 'Arm Profile',
    automations: [],
    creator: null,
    schedules: [],
    recordEverything: false,
    activationDelay: 30,
    createdAt: 1761052800000,
    updatedAt: 1761052800000,
  },
];

/**
 * `/v1/sensors` and `/v1/lights` as the API reference describes them (developer.ui.com/protect v7.2.105, “Get all
 * sensors” and “Get all lights”), cut to what Whombat reads: a door sensor that is open, one with a low battery, a
 * floodlight that is on.
 */
const sensor = (id: string, name: string, mountType: string, isOpened: boolean, isLow: boolean) => ({
  id,
  modelKey: 'sensor',
  state: 'CONNECTED',
  name,
  mac: 'F4E2C6000001',
  mountType,
  batteryStatus: { percentage: null, isLow },
  stats: {
    light: { value: 0, status: 'neutral' },
    humidity: { value: 0, status: 'neutral' },
    temperature: { value: 0, status: 'neutral' },
  },
  isOpened,
  openStatusChangedAt: 1792612000000,
  isMotionDetected: false,
  motionDetectedAt: null,
});

export const PROTECT_sensors = [
  sensor('67a0000000000000000000a1', 'Back door', 'door', true, false),
  sensor('67a0000000000000000000a2', 'Garage door', 'garage', false, true),
];

export const PROTECT_lights = [
  {
    id: '67a0000000000000000000b1',
    modelKey: 'light',
    state: 'CONNECTED',
    name: 'Driveway light',
    isDark: true,
    isLightOn: true,
    isLightForceEnabled: false,
    lastMotion: 1792613000000,
    isPirMotionDetected: false,
    camera: '672094f900e26303e800062a',
  },
];

/** Event-stream messages: a person in a zone (added, then updated with its end and a vehicle), a ring, plain motion. */
export const PROTECT_events = [
  {
    type: 'add',
    item: {
      id: '6717a0010000000000000001',
      modelKey: 'event',
      type: 'smartDetectZone',
      start: 1792612800000,
      end: null,
      device: '66d025b301ebc903e80003ea',
      smartDetectTypes: ['person'],
    },
  },
  {
    type: 'update',
    item: {
      id: '6717a0010000000000000001',
      modelKey: 'event',
      type: 'smartDetectZone',
      start: 1792612800000,
      end: 1792612812000,
      device: '66d025b301ebc903e80003ea',
      smartDetectTypes: ['person', 'vehicle'],
    },
  },
  {
    type: 'add',
    item: {
      id: '6717a0010000000000000002',
      modelKey: 'event',
      type: 'ring',
      start: 1792613400000,
      end: null,
      device: '66d025b301ebc903e80003ea',
    },
  },
  {
    type: 'add',
    item: {
      id: '6717a0010000000000000003',
      modelKey: 'event',
      type: 'motion',
      start: 1792613500000,
      end: null,
      device: '672094f900e26303e800062a',
    },
  },
];
