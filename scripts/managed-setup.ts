// Create, or bring up to date, the agents and the sandbox environment that
// hosted sessions start from, and print their ids:
//
//   npm run managed:setup                          (defaults: agents on Claude Opus 5.5, medium effort, no web)
//   npm run managed:setup -- --model claude-sonnet-5-5 --effort low
//   npm run managed:setup -- --web                 (agents may use the web; the sandbox's network is open)
//   npm run managed:setup -- --no-runs             (a lead that cannot start workflow runs)
//
// This is optional: the first plan carried out in a hosted session does the
// same thing. Run it to see that your credentials can use Claude Managed
// Agents before an organisation depends on it. It creates saved resources on
// your Anthropic account (two agents and one environment) and nothing else:
// no session is started and nothing is spent.
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Effort } from '../src/shared/types';
import { ROOT_DIR, loadConfig } from '../src/server/config';
import { ConnectionStore } from '../src/server/connections';
import { TEAM_AGENT_NAME, teamAgentSystem } from '../src/server/engine/prompts';
import { DEFAULT_SETTINGS } from '../src/server/engine/state';
import { ClaudeProvider } from '../src/server/providers/claude';
import { isKnownModel } from '../src/server/providers/pricing';

const args = process.argv.slice(2);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const EFFORTS: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

async function main(): Promise<void> {
  if (args.includes('--help')) {
    console.log('Usage: npm run managed:setup -- [--model <model id>] [--effort low|medium|high|xhigh|max] [--web] [--no-runs]');
    return;
  }
  const envFile = path.join(ROOT_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig();
  const model = value('--model') ?? DEFAULT_SETTINGS.workerModel;
  const effort = (value('--effort') ?? DEFAULT_SETTINGS.workerEffort) as Effort;
  const web = args.includes('--web');
  const workflows = !args.includes('--no-runs');
  if (!isKnownModel(model)) throw new Error(`"${model}" is not a model this project knows. See src/server/providers/pricing.ts.`);
  if (!EFFORTS.includes(effort)) throw new Error(`--effort takes one of: ${EFFORTS.join(', ')}.`);

  // The same Anthropic key the server would use: one from the environment, or one added under "Models and keys".
  const connections = new ConnectionStore(path.join(config.dataDir, 'connections.json'), process.env, config.anthropicAmbient);
  await connections.load();
  const anthropic = connections.list().find((c) => c.presetId === 'anthropic');
  if (!anthropic) throw new Error('No Anthropic key is connected. Add one under "Models and keys" in the interface, or set ANTHROPIC_API_KEY in .env.');

  const file = path.join(config.dataDir, 'managed.json');
  const provider = new ClaudeProvider({
    managedStateFile: file,
    workspace: config.workspace,
    ...(anthropic.apiKey ? { apiKey: anthropic.apiKey } : {}),
    ...(anthropic.baseURL !== 'https://api.anthropic.com' ? { baseURL: anthropic.baseURL } : {}),
  });
  const made = await provider.prepareManaged({ workerModel: model, workerEffort: effort, workerName: TEAM_AGENT_NAME, workerSystem: teamAgentSystem(web), web, workflows });

  console.log(`Ready for agents on ${model} at ${effort} effort, ${web ? 'with the web (the sandbox network is open)' : 'without the web (the sandbox reaches package registries only)'}.`);
  console.log(`  Environment  ${made.environmentId}`);
  console.log(`  Team agent   ${made.worker.id} (version ${made.worker.version})`);
  console.log(`  Lead agent   ${made.lead.id} (version ${made.lead.version}), ${workflows ? 'which may start workflow runs' : 'which cannot start workflow runs'}`);
  console.log(`Their ids are kept in ${file}.`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
