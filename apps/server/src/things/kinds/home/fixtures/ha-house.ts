/**
 * Home Assistant's answers for the house panels (`ha-house.ts`), in the shapes it sends: the house template's event
 * (its JSON as text), the registries of a small house, `weather.get_forecasts` daily and twice daily (Met.no's and
 * a provider's that only has twice daily), `energy/get_prefs` in the grid's older and newer shapes, and hourly
 * `recorder/statistics_during_period` for 2026-10-21 in Europe/Amsterdam (midnight is 2026-10-20T22:00Z).
 */

const house = {
  people: [
    ['person.anna', 'Anna', 'home', '2026-10-21T15:12:40.120000+00:00'],
    ['person.john', 'John', 'Work', '2026-10-21T07:31:02.000000+00:00'],
    ['person.sam', 'Sam', 'not_home', '2026-10-21T11:00:00.000000+00:00'],
  ],
  lights: [3, 14],
  doors: 6,
  open: [['binary_sensor.back_door', 'Back door', 'door', '2026-10-21T12:02:11.000000+00:00']],
  locks: [
    ['lock.front_door', 'Front door', 'locked', '2026-10-21T08:00:00.000000+00:00'],
    ['lock.shed', 'Shed', 'locked', '2026-10-20T08:00:00.000000+00:00'],
  ],
  alarms: [['alarm_control_panel.house', 'Alarm', 'disarmed']],
  readings: [
    ['sensor.living_room_temperature', 'temperature', '21.4', '°C'],
    ['sensor.living_room_thermostat_temperature', 'temperature', '21.8', '°C'],
    ['sensor.living_room_humidity', 'humidity', '48', '%'],
    ['sensor.bedroom_temperature', 'temperature', '15.2', '°C'],
    ['sensor.bedroom_humidity', 'humidity', '55.4', '%'],
    ['sensor.garden_temperature', 'temperature', '9.1', '°C'],
    // A plug's own temperature (diagnostic), a hidden one and one without an area: none is a room's.
    ['sensor.kitchen_plug_device_temperature', 'temperature', '38.0', '°C'],
    ['sensor.hidden_temperature', 'temperature', '30.0', '°C'],
    ['sensor.loose_temperature', 'temperature', '25.0', '°C'],
  ],
  weather: [['weather.forecast_home', 'Forecast Home', 'partlycloudy', 14.3, '°C', 62, 9.4, 'km/h', 1 | 2]],
  cameras: [
    ['camera.front_door', 'Front door', 'idle'],
    ['camera.garden', 'Garden', 'recording'],
  ],
  automations: ['automation.hall_light_at_sunset', 'automation.morning_heating'],
  automationCount: 2,
};

/** `render_template`'s event: the rendered JSON as text, and what it listens to. */
export const HA_houseEvent = {
  result: JSON.stringify(house),
  listeners: { all: false, entities: [], domains: ['person', 'binary_sensor'], time: false },
};

/** The same with the door shut, the shed open and the alarm going off. */
export const HA_houseAlarm = {
  result: JSON.stringify({
    ...house,
    open: [],
    locks: [house.locks[0], ['lock.shed', 'Shed', 'unlocked', '2026-10-21T19:40:00.000000+00:00']],
    alarms: [['alarm_control_panel.house', 'Alarm', 'triggered']],
  }),
};

/** A house with nothing the panels show (no people, lights, doors, locks, sensors or weather). */
export const HA_houseEmpty = {
  result: {
    people: [],
    lights: [0, 0],
    doors: 0,
    open: [],
    locks: [],
    alarms: [],
    readings: [],
    weather: [],
    cameras: [],
    automations: [],
    automationCount: 0,
  },
};

export const HA_houseRegistry = {
  entity_categories: { 0: 'config', 1: 'diagnostic' },
  entities: [
    { ei: 'sensor.living_room_temperature', ai: 'living_room' },
    { ei: 'sensor.living_room_thermostat_temperature', di: 'dev_thermostat' },
    { ei: 'sensor.living_room_humidity', ai: 'living_room' },
    { ei: 'sensor.bedroom_temperature', ai: 'bedroom' },
    { ei: 'sensor.bedroom_humidity', ai: 'bedroom' },
    { ei: 'sensor.garden_temperature', ai: 'garden' },
    { ei: 'sensor.kitchen_plug_device_temperature', ai: 'kitchen', ec: 1 },
    { ei: 'sensor.hidden_temperature', ai: 'kitchen', hb: true },
    { ei: 'sensor.loose_temperature' },
  ],
};

/** Since 2024 the registries say when each device and area was added (`created_at`, seconds), as 2026.10.4 does. */
export const HA_houseDevices = [
  {
    id: 'dev_thermostat',
    area_id: 'living_room',
    name: 'Thermostat',
    disabled_by: null,
    created_at: 1760000000.1,
  },
  // Added on 2026-10-19, two days before the fixtures' now.
  { id: 'dev_plug', area_id: 'kitchen', name: 'Kitchen plug', disabled_by: null, created_at: 1792404000.5 },
  { id: 'dev_old', area_id: null, name: 'Old sensor', disabled_by: 'user', created_at: 1792404000.5 },
];

export const HA_houseAreas = [
  { area_id: 'living_room', name: 'Living room', created_at: 1760000000.2 },
  { area_id: 'kitchen', name: 'Kitchen', created_at: 1760000000.3 },
  { area_id: 'bedroom', name: 'Bedroom', created_at: 1760000000.4 },
  { area_id: 'garden', name: 'Garden', created_at: 1760000000.5 },
];

/**
 * `logbook/get_events` for the automations (Home Assistant 2026.10.4 in a throwaway container, 2026-11-04, moved to
 * 2026-10-21): runs by an event and by hand (`source` null), and an automation switched off, which is no run.
 */
export const HA_logbook = [
  {
    name: 'Hall light at sunset',
    message: "triggered by event 'wb_test'",
    source: "event 'wb_test'",
    entity_id: 'automation.hall_light_at_sunset',
    context_id: '01M6KSD58WS7991PW819XA96BR',
    domain: 'automation',
    when: 1792611026.0767252,
  },
  {
    name: 'Hall light at sunset',
    message: "triggered by event 'wb_test'",
    source: "event 'wb_test'",
    entity_id: 'automation.hall_light_at_sunset',
    context_id: '01M6KSD58YNTBK5Q3Y8AW2VEP0',
    domain: 'automation',
    when: 1792611026.0786617,
  },
  {
    name: 'Hall light at sunset',
    message: 'triggered',
    source: null,
    entity_id: 'automation.hall_light_at_sunset',
    context_id: '01M6KSD5923HX9VBARHP57D3MP',
    domain: 'automation',
    when: 1792524626.0823827,
  },
  {
    name: 'Morning heating',
    state: 'off',
    entity_id: 'automation.morning_heating',
    when: 1792476000.5,
  },
];

/** `call_service` `weather.get_forecasts` `{type: 'daily'}` with `return_response` (Met.no). */
export const HA_forecastDaily = {
  context: { id: '01JB7Z', parent_id: null, user_id: 'u1' },
  response: {
    'weather.forecast_home': {
      forecast: [
        {
          condition: 'rainy',
          datetime: '2026-10-21T10:00:00+00:00',
          wind_bearing: 220,
          temperature: 16.2,
          templow: 8.4,
          wind_speed: 18.4,
          precipitation: 4.1,
          humidity: 81,
        },
        {
          condition: 'cloudy',
          datetime: '2026-10-22T10:00:00+00:00',
          temperature: 12.4,
          templow: 6.1,
          precipitation_probability: 40,
        },
        { condition: 'sunny', datetime: '2026-10-23T10:00:00+00:00', temperature: 13, templow: -1.4 },
        { condition: 'sunny', datetime: '2026-10-24T10:00:00+00:00', temperature: 14, templow: 5 },
      ],
    },
  },
};

/** `weather.get_forecasts` `{type: 'twice_daily'}`: a day and a night per date. */
export const HA_forecastTwiceDaily = {
  'weather.knmi': {
    forecast: [
      { datetime: '2026-10-21T18:00:00+00:00', is_daytime: false, condition: 'clear-night', temperature: 7 },
      { datetime: '2026-10-22T06:00:00+00:00', is_daytime: true, condition: 'pouring', temperature: 12 },
      { datetime: '2026-10-22T18:00:00+00:00', is_daytime: false, condition: 'rainy', temperature: 5 },
    ],
  },
};

/** `energy/get_prefs` with the grid's older shape: meters from and to the grid, solar panels and a battery. */
export const HA_energyPrefsLegacy = {
  energy_sources: [
    {
      type: 'grid',
      flow_from: [
        { stat_energy_from: 'sensor.energy_import_t1', stat_cost: null },
        { stat_energy_from: 'sensor.energy_import_t2', stat_cost: null },
      ],
      flow_to: [{ stat_energy_to: 'sensor.energy_export_t1' }],
      cost_adjustment_day: 0,
    },
    { type: 'solar', stat_energy_from: 'sensor.solar_energy', config_entry_solar_forecast: null },
    { type: 'gas', stat_energy_from: 'sensor.gas' },
  ],
  device_consumption: [{ stat_consumption: 'sensor.washing_machine_energy' }],
};

/** `energy/get_prefs` with the grid's newer single pair and a battery, no solar. */
export const HA_energyPrefsGrid = {
  energy_sources: [
    { type: 'grid', stat_energy_from: 'sensor.p1_import', stat_energy_to: null, cost_adjustment_day: 0 },
    { type: 'battery', stat_energy_from: 'sensor.battery_out', stat_energy_to: 'sensor.battery_in' },
  ],
  device_consumption: [],
};

const hour = (h: number) => Date.UTC(2026, 9, 20, 22 + h);
const rows = (values: number[]) => values.map((change, h) => ({ start: hour(h), end: hour(h + 1), change }));

/** Hourly `change` in kWh from local midnight; the last full hour before 21:50 isn't in yet for every meter. */
export const HA_energyStats = {
  'sensor.energy_import_t1': rows([
    0.3, 0.2, 0.2, 0.2, 0.2, 0.3, 0.5, 0.6, 0.2, 0, 0, 0, 0, 0, 0, 0, 0.2, 0.6, 0.9,
  ]),
  'sensor.energy_import_t2': rows([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.1]),
  'sensor.energy_export_t1': rows([0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.4, 0.8, 1.0, 0.9, 0.6, 0.3, 0, 0, 0, 0]),
  'sensor.solar_energy': rows([0, 0, 0, 0, 0, 0, 0, 0.1, 0.6, 1.1, 1.6, 1.9, 1.8, 1.4, 0.9, 0.4, 0.1, 0, 0]),
};
