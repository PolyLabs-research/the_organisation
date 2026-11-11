// The organisation's memory: everything it has reported, decided, planned and written, in every cycle, as one thing
// that can be searched. What a search returns is the same for a lead's prompt, an agent's tool and a person's page.

/** What kind of thing a remembered item is. */
export type MemoryKind = 'cycle' | 'report' | 'decision' | 'plan' | 'task' | 'steer' | 'request' | 'knowledge' | 'file';

export const MEMORY_KINDS: readonly MemoryKind[] = ['cycle', 'report', 'decision', 'plan', 'task', 'steer', 'request', 'knowledge', 'file'];

/** How each kind reads where a person or a model is told what an item is. */
export const MEMORY_KIND_LABEL: Record<MemoryKind, string> = {
  cycle: 'what a cycle came to',
  report: 'report to the board',
  decision: 'decision',
  plan: 'plan',
  task: 'agent’s task report',
  steer: 'shareholder steer',
  request: 'request to the signatory',
  knowledge: 'business knowledge',
  file: 'file',
};

export interface MemoryItem {
  /** The kind and the item's own id, such as report:rep12, or for a part of a file file:engineering/spec.md#2. */
  id: string;
  kind: MemoryKind;
  /** The cycle it belongs to. Null for what belongs to no cycle: a file, a steer, a piece of knowledge. */
  cycle: number | null;
  at: string;
  /** The seat it came from, "shareholders", or empty where nobody is recorded. */
  from: string;
  title: string;
  /** For a file: its path in the workspace. */
  path?: string;
}

/** One thing a search found, with the passage that matched. */
export interface MemoryHit extends MemoryItem {
  excerpt: string;
  score: number;
  /** How many of the words asked about the item has, and how many were asked about. */
  matched: number;
  asked: number;
}

/** The whole of one remembered item. For a file, the part of it that was found. */
export interface MemoryWhole extends MemoryItem {
  text: string;
}

/** How much the memory holds. */
export interface MemoryStats {
  items: number;
  /** How many there are of each kind. A file counts once for each part of it that can be found on its own. */
  byKind: Record<MemoryKind, number>;
  /** How many files of the workspace are among them. */
  files: number;
  /** The earliest and latest cycle anything is remembered from, or null where nothing belongs to a cycle yet. */
  cycles: { from: number; to: number } | null;
  /** Older task reports that were left out to keep the memory within its size. */
  leftOut: number;
  /** Cycles that are in the archive and could not be read from it. Nothing from them can be found. */
  unread: number[];
}

/** What a person's search comes back with: what was found, and how much there was to look through. */
export interface MemorySearch {
  hits: MemoryHit[];
  stats: MemoryStats;
}

/**
 * One time the memory was put to use, kept so that a person can see it at work: passages put in front of a lead
 * before it decided, or a search that an agent or a lead made for itself.
 */
export interface MemoryUse {
  at: string;
  cycle: number;
  /** The lead it was for: the one that was shown, the one whose agent searched, or the one that searched from its session. */
  seatId: string;
  /** shown: passages put in front of a lead. agent: an agent's own search. lead: a lead's own search, from a hosted session. */
  by: 'shown' | 'agent' | 'lead';
  /** For what was shown: the step the lead was at. For a search: the words that were searched for. */
  about: string;
  /** What was shown, oldest first, or what the search found, closest first. None where a search found nothing. */
  items: Array<Pick<MemoryItem, 'id' | 'kind' | 'cycle' | 'title' | 'from' | 'path'>>;
}
/** How many uses are kept: enough to see the memory at work, and few enough to send with every change. */
export const MAX_MEMORY_USES = 30;

// ---- words ----
// The memory finds things by their words. The page marks the same words in what it shows, so both read a text the same way.

const STOP = new Set('a an and are as at be been but by can could did do does for from had has have how if in into is it its may more most no nor not of on or our out over should so than that the their then there these they this those to too very was we were what when where which who why will with would you your'.split(' '));
/** Writing with no spaces between words: Thai, Lao, Burmese, Khmer, kana and Han characters. Pairs of characters stand in for words there. */
const UNSPACED = /[\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const undoubled = (word: string) => (/([b-df-hj-np-tv-z])\1$/.test(word) && !/(ll|ss|zz)$/.test(word) ? word.slice(0, -1) : word);
/** A word cut back far enough that its plain forms meet: price, prices, priced and pricing; plan, plans, planned and planning. Crude, and the same every time. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 3 && w.endsWith('ies')) w = w.slice(0, -3) + 'y';
  // Boxes and wishes lose two letters. Longer words that end the same way are brought together by the last step.
  else if (w.length > 4 && /(x|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = undoubled(w.slice(0, -3));
  else if (w.length > 4 && w.endsWith('ed')) w = undoubled(w.slice(0, -2));
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}
/** The words of a text as they are indexed and looked for. */
export function words(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (UNSPACED.test(raw)) {
      const letters = [...raw];
      if (letters.length === 1) out.push(raw);
      for (let i = 0; i + 1 < letters.length; i++) out.push(letters[i]! + letters[i + 1]!);
    } else if (raw.length >= 2 && raw.length <= 40 && !STOP.has(raw)) out.push(stem(raw));
  }
  return out;
}
