// Establish an organisation from one prompt, against a running server:
//
//   npm run establish -- "A marketplace where local bakeries sell surplus bread"
//   npm run establish -- --no-start --budget 20 "…"
//
// It asks for a recommended executive team, establishes the organisation with
// it, starts the loop (unless --no-start) and prints where to watch it.
import type { OrgView, TeamRecommendation } from '../src/shared/types';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const skip = new Set<number>();
for (const name of ['--budget', '--steer', '--url']) {
  const i = args.indexOf(name);
  if (i >= 0) skip.add(i).add(i + 1);
}
const idea = args
  .filter((arg, i) => !skip.has(i) && !arg.startsWith('--'))
  .join(' ')
  .trim();
const base = (value('--url') ?? process.env.ORG_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4780}`).replace(/\/$/, '');

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(`No server is answering at ${base}. Start one with "npm run dev" and try again.`);
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `The server answered ${res.status}.`);
  return data as T;
}

async function main(): Promise<void> {
  if (!idea || flag('--help')) {
    console.log('Usage: npm run establish -- [--no-start] [--budget <usd>] [--steer "<text>"] [--url <server>] "<the idea>"');
    process.exit(idea ? 0 : 1);
  }
  const budget = value('--budget');
  if (budget !== undefined && !(Number(budget) > 0)) throw new Error('--budget takes a positive number of US dollars.');

  console.log('Asking for a recommended executive team…');
  const team = await call<TeamRecommendation>('POST', '/api/recommend', { idea });
  const view = await call<OrgView>('POST', '/api/orgs', {
    name: team.name,
    idea,
    mission: team.mission,
    executives: team.executives,
    settings: budget === undefined ? undefined : { budgetUsd: Number(budget) },
    steer: value('--steer'),
  });
  const { org } = view;

  console.log(`\n${org.name}\n${org.mission}\n`);
  for (const seat of org.executives) {
    const agents = seat.kind === 'lead' ? `${seat.agentCount} agent${seat.agentCount === 1 ? '' : 's'}` : 'no agents';
    console.log(`  ${seat.short.padEnd(6)} ${seat.title.padEnd(38)} ${seat.phases.map((p) => p.name).join(' → ')}  (${agents})`);
  }
  console.log(`\nBudget: $${org.settings.budgetUsd.toFixed(2)}. The organisation pauses itself when it is reached.`);

  if (flag('--no-start')) {
    console.log('Established, not started.');
  } else {
    await call('POST', `/api/orgs/${org.id}/start`);
    console.log('Established and running.');
  }
  console.log(`Watch it at ${base}/#/org/${org.id}`);
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
