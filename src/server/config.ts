import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  /**
   * mock: always simulate, whatever keys there are. auto: call real models once any key is connected, and
   * simulate until then. `claude` is the old name for auto and means the same.
   */
  provider: 'claude' | 'mock' | 'auto';
  /** Why that provider was chosen, for the startup log and the UI. */
  providerReason: string;
  /** True when Anthropic credentials can be found without a key being handed over (a login profile, say). */
  anthropicAmbient: boolean;
  production: boolean;
  /** The Anthropic workspace the API key belongs to, as it appears in Console links to hosted sessions. */
  workspace: string;
}

/** True when the Anthropic SDK would find credentials without being handed a key. */
function claudeCredentialsPresent(env: NodeJS.ProcessEnv): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return true;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && env.ANTHROPIC_ORGANIZATION_ID) return true;
  // `ant auth login` stores its profiles here.
  return existsSync(path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'anthropic'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const requested = (env.ORG_PROVIDER ?? 'auto').toLowerCase();
  let provider: Config['provider'];
  let providerReason: string;
  if (requested === 'mock') {
    provider = 'mock';
    providerReason = 'ORG_PROVIDER=mock';
  } else if (requested === 'claude') {
    provider = 'claude';
    providerReason = 'ORG_PROVIDER=claude';
  } else {
    provider = 'auto';
    providerReason = 'models are called once a key is connected';
  }
  return {
    port: Number(env.PORT ?? 4780),
    host: env.HOST ?? '127.0.0.1',
    dataDir: path.resolve(env.ORG_DATA_DIR ?? path.join(ROOT_DIR, 'data')),
    provider,
    providerReason,
    // A key in the environment is picked up by name like any other provider's. This is for the other ways the
    // Anthropic client finds credentials by itself.
    anthropicAmbient: !env.ANTHROPIC_API_KEY && claudeCredentialsPresent(env),
    production: env.NODE_ENV === 'production',
    workspace: (env.ANTHROPIC_WORKSPACE_ID ?? '').trim() || 'default',
  };
}
