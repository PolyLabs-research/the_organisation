// See whether the Claude Code on this machine can be used as a connection:
//
//   npm run claude-code:check             which version it is and how it is signed in. Calls no model.
//   npm run claude-code:check -- --call   also makes two short calls on the smallest model, one for a structured
//                                         answer and one that uses a tool, and says what came back and what it used.
//
// The two calls count against the login's usage like any other use of Claude Code: a few thousand tokens.
// CLAUDE_CODE_PATH names the command if it is not "claude" on the PATH.
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { loadConfig } from '../src/server/config';
import { ClaudeCodeProvider, checkClaudeCode, describeStatus } from '../src/server/providers/claude-code';
import type { CallUsage } from '../src/server/providers/types';

const MODEL = 'claude-haiku-5-5';

async function main(): Promise<void> {
  const config = loadConfig();
  const status = await checkClaudeCode(config.claudeCode.command);
  console.log(`${describeStatus(status)}.`);
  if (config.claudeCode.blocked) console.log(`Note: ${config.claudeCode.blocked}`);
  if (!process.argv.includes('--call')) {
    console.log('No model was called. Add "-- --call" to make two short calls and see it work.');
    return;
  }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'the-organisation-claude-code-check-'));
  const provider = new ClaudeCodeProvider({ command: config.claudeCode.command, dir, extraUsage: config.claudeCode.extraUsage });
  const used: CallUsage[] = [];
  const base = { model: MODEL, effort: 'low' as const, context: {}, onUsage: (usage: CallUsage) => used.push(usage) };
  try {
    const answer = await provider.structured({
      ...base,
      kind: 'consult',
      system: { charter: 'You are being asked two short questions to see that a connection works.', role: 'Answer briefly.' },
      prompt: 'What is the capital of France, and is it north or south of Madrid?',
      schema: z.object({ capital: z.string(), direction: z.enum(['north', 'south']) }),
    });
    console.log(`A structured answer: ${JSON.stringify(answer)}`);

    const written: string[] = [];
    const result = await provider.agent({
      ...base,
      kind: 'task',
      system: { charter: 'You are being asked to use a tool to see that a connection works.', role: 'You can do nothing except through your tools.' },
      prompt: 'Record the note "the connection works" with your tool, then say in one line that you have.',
      tools: [
        {
          name: 'record_note',
          description: 'Record a short note. Returns a confirmation.',
          schema: z.object({ note: z.string() }),
          async run(input) {
            written.push(String(input.note));
            return 'Recorded.';
          },
        },
      ],
      webSearch: null,
      maxTurns: 6,
    });
    console.log(`A tool call: the tool was given ${JSON.stringify(written)}; the agent then said: ${result.text.split('\n')[0]}`);
    if (!written.length) console.log('The agent did not use the tool. That is worth looking into before relying on this connection.');

    const total = used.reduce((sum, u) => ({ input: sum.input + u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens, output: sum.output + u.outputTokens, cost: sum.cost + u.costUsd }), { input: 0, output: 0, cost: 0 });
    console.log(`Used: ${total.input} tokens in, ${total.output} out, which the API would charge $${total.cost.toFixed(4)} for. On a subscription that is not billed.`);
    const limits = provider.limits();
    if (limits?.utilization !== null && limits?.utilization !== undefined) {
      console.log(`Plan usage: ${Math.round(limits.utilization * 100)}% of the ${limits.window === 'seven_day' ? 'weekly' : (limits.window ?? '').replace(/_/g, ' ')} limit${limits.resetsAt ? `, which resets ${limits.resetsAt.slice(0, 16).replace('T', ' ')} UTC` : ''}.`);
    }
    if (limits?.extraAllowed) console.log('Paid extra usage is switched on for this account. An organisation pauses rather than start using it, unless the server is started with CLAUDE_CODE_EXTRA_USAGE=allow.');
  } finally {
    provider.close();
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
