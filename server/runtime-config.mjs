import publicConfig from '../portal/public-config.json' with { type: 'json' };

// Only these two public values may come from the tracked browser configuration.
// Private signing credentials must remain in server environment variables.
export function withPublicConfig(env = process.env) {
  return {
    SUPABASE_URL: publicConfig.supabaseUrl,
    SUPABASE_PUBLISHABLE_KEY: publicConfig.publishableKey,
    ...env,
  };
}
