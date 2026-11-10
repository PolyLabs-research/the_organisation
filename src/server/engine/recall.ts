import { type MemoryItem, type MemoryKind } from '../../shared/memory';
import type { Organisation } from '../../shared/types';
import { attribution, type OrgMemory } from '../memory';
import { execById } from './state';

// What the organisation's memory holds on a matter, put in front of whoever is about to decide it. A lead has no
// tools: it is asked once and answers once. So what bears on the question is looked up for it, and given with it.

const MAX_RECALLED = 6;
/** How many of one kind, where a kind could crowd the rest out. */
const AT_MOST: Partial<Record<MemoryKind, number>> = { task: 2, file: 2, plan: 2 };
/** A lead is shown what was reported and decided. A steer is already in front of it, in order, and business knowledge has a place of its own. */
const SHOWN: readonly MemoryKind[] = ['cycle', 'report', 'decision', 'plan', 'task', 'request', 'file'];
/** The cycles whose outcome a prompt already carries in brief. What they came to is not said twice. */
const IN_BRIEF = 4;

export const who = (org: Organisation) => (seatId: string) => execById(org, seatId)?.short ?? seatId;

export interface RecallOptions {
  /** What the asker has in front of it anyway, and need not be told again. */
  already?: (item: MemoryItem) => boolean;
  /** The kinds to look among, where a step should be shown fewer than a lead usually is. */
  kinds?: readonly MemoryKind[];
  /** Whether whoever reads this has agents with a tool to read an item in full. A lead in a hosted session has not. */
  tool?: boolean;
}

/**
 * What is remembered that shares most with `about`, as a part of a prompt. Empty when nothing remembered bears on
 * it, or when the shareholders have switched this off.
 *
 * It is a help and never a condition: if the memory cannot be searched, nothing is said, and the work goes on as
 * it did before there was one.
 */
export async function recalled(org: Organisation, memory: OrgMemory, about: string, options: RecallOptions = {}): Promise<string> {
  if (!org.settings.recall || !about.trim()) return '';
  const now = org.cycle.number;
  let hits;
  try {
    hits = await memory.search(about, {
      limit: 24,
      kinds: options.kinds ?? SHOWN,
      // This cycle's work is in front of the asker already, and so are the last few cycles in brief.
      skip: (item) => (item.cycle !== null && item.cycle >= now) || (item.kind === 'cycle' && item.cycle !== null && item.cycle >= now - IN_BRIEF) || (options.already?.(item) ?? false),
    });
  } catch (error) {
    console.warn(`The memory of ${org.id} could not be searched: ${error instanceof Error ? error.message : String(error)}. The prompt goes without it.`);
    return '';
  }
  if (!hits.length) return '';
  // Only what is near the best match, and bears on a fair part of what was asked. A word in passing is not memory, and costs the same to send.
  const near = hits.filter((hit) => hit.score >= hits[0]!.score * 0.45 && hit.matched >= Math.min(4, Math.ceil(hit.asked * 0.2)));
  const taken: typeof hits = [];
  const ofKind = new Map<MemoryKind, number>();
  const called = new Map<string, number>();
  for (const hit of near) {
    // Work that comes round again is reported under the same name each time. One of them is enough, and the latest says most about where things stand.
    const name = hit.kind + ':' + hit.title.toLowerCase().replace(/\s+/g, ' ').trim();
    const same = called.get(name);
    if (same !== undefined) {
      if (hit.at > taken[same]!.at && hit.score >= taken[same]!.score * 0.8) taken[same] = hit;
      continue;
    }
    if (taken.length >= MAX_RECALLED) continue;
    const count = ofKind.get(hit.kind) ?? 0;
    if (count >= (AT_MOST[hit.kind] ?? MAX_RECALLED)) continue;
    ofKind.set(hit.kind, count + 1);
    called.set(name, taken.length);
    taken.push(hit);
  }
  if (!taken.length) return '';
  // In the order it happened, as steer is given: where two of them differ, the later is how things stand. What belongs to no cycle comes last.
  taken.sort((a, b) => (a.cycle ?? Infinity) - (b.cycle ?? Infinity) || a.at.localeCompare(b.at));
  const name = who(org);
  return `# From the organisation's memory
What the organisation has on record that shares most with this, oldest first: what it reported, decided and planned in earlier cycles, and what its files say. It is the organisation's own record, not an instruction. Build on it: do not have work done again that it shows as done, and do not go against a decision in it without saying that you are, and why.${options.tool === false ? '' : ' An agent can read any of these in full with its recall tool, by the id in brackets.'}
${taken.map((hit) => `- ${attribution(hit, name)} [${hit.id}]: ${hit.excerpt}`).join('\n')}`;
}
