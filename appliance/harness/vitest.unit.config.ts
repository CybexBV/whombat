import { defineConfig } from 'vitest/config';

// The unit tests that read pins read a set that is in the repository (`manifest/pins.json`, the last one the flow
// before the one repository validated) unless `WB_MGD_PINS` names another: a checkout's own pins need the private
// repository control and the relay live in, which a unit test must not.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    env: { WB_MGD_PINS: process.env.WB_MGD_PINS ?? 'manifest/pins.json' },
  },
});
