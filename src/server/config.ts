import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  provider: 'claude' | 'mock';
  /** Why that provider was chosen, for the startup log and the UI. */
  providerReason: string;
  production: boolean;
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
  } else if (claudeCredentialsPresent(env)) {
    provider = 'claude';
    providerReason = 'Anthropic credentials found';
  } else {
    provider = 'mock';
    providerReason = 'no Anthropic credentials found (set ANTHROPIC_API_KEY to use Claude)';
  }
  return {
    port: Number(env.PORT ?? 4780),
    host: env.HOST ?? '127.0.0.1',
    dataDir: path.resolve(env.ORG_DATA_DIR ?? path.join(ROOT_DIR, 'data')),
    provider,
    providerReason,
    production: env.NODE_ENV === 'production',
  };
}
