/** A complete, valid production environment for tests (`loadConfig` refuses an incomplete one). */
export function productionTestEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'production',
    WHOMBAT_MASTER_KEY: Buffer.alloc(32, 9).toString('base64'),
    DATABASE_URL: 'postgres://whombat:whombat@127.0.0.1:55440/whombat',
    WHOMBAT_APP_URL: 'https://app.whombat.com',
    RUNNER_TOKEN: 'production-test-runner-token-0123456789abcdef',
    WHOMBAT_GITHUB: 'off',
    // The box's content identity and its manager (never read by `loadConfig`).
    WHOMBAT_CONTENT_KEY_FILE: '/var/lib/whombat/content-key',
    WHOMBAT_MANAGER_SOCKET: '/run/whombat-manager/runtime.sock',
    ...extra,
  };
}
