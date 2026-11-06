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
  /** How the Claude Code on this machine is run, for the connection that uses its login instead of a key. */
  claudeCode: {
    command: string;
    /** Whether to carry on when the plan's included usage is spent and further usage is billed. */
    extraUsage: boolean;
    /** Why the connection may not be used on this server, if it may not. */
    blocked: string | null;
  };
}

/** True when the Anthropic SDK would find credentials without being handed a key. */
function claudeCredentialsPresent(env: NodeJS.ProcessEnv): boolean {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_PROFILE) return true;
  if (env.ANTHROPIC_FEDERATION_RULE_ID && env.ANTHROPIC_ORGANIZATION_ID) return true;
  // `ant auth login` stores its profiles here.
  return existsSync(path.join(env.XDG_CONFIG_HOME ?? path.join(homedir(), '.config'), 'anthropic'));
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

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
  const host = env.HOST ?? '127.0.0.1';
  return {
    port: Number(env.PORT ?? 4780),
    host,
    dataDir: path.resolve(env.ORG_DATA_DIR ?? path.join(ROOT_DIR, 'data')),
    provider,
    providerReason,
    // A key in the environment is picked up by name like any other provider's. This is for the other ways the
    // Anthropic client finds credentials by itself.
    anthropicAmbient: !env.ANTHROPIC_API_KEY && claudeCredentialsPresent(env),
    production: env.NODE_ENV === 'production',
    workspace: (env.ANTHROPIC_WORKSPACE_ID ?? '').trim() || 'default',
    claudeCode: {
      command: (env.CLAUDE_CODE_PATH ?? '').trim() || 'claude',
      extraUsage: (env.CLAUDE_CODE_EXTRA_USAGE ?? '').trim().toLowerCase() === 'allow',
      // A login is one person's. A server that other machines can reach would be lending it out.
      blocked: LOOPBACK.has(host)
        ? null
        : `The Claude Code connection is for your own use on this machine, and is switched off while the server listens on ${host}: anyone who could reach it would be using your login, which Anthropic's terms do not allow. Set HOST back to 127.0.0.1, or use an API key.`,
    },
  };
}
