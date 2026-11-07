import { describe, expect, it } from 'vitest';
import { MockProvider } from '../src/server/providers/mock';
import type { AgentRequest, StructuredRequest } from '../src/server/providers/types';
import { harness, QUIET, waitFor } from './helpers';

/** A simulator that records how many calls were in flight at once, and when each started and ended. */
class Watched extends MockProvider {
  now = 0;
  most = 0;
  calls: Array<{ start: number; end: number }> = [];
  private async watch<T>(call: () => Promise<T>): Promise<T> {
    const entry = { start: Date.now(), end: 0 };
    this.calls.push(entry);
    this.most = Math.max(this.most, ++this.now);
    try {
      return await call();
    } finally {
      this.now--;
      entry.end = Date.now();
    }
  }
  override structured<T>(req: StructuredRequest<T>) {
    return this.watch(() => super.structured(req));
  }
  override agent(req: AgentRequest) {
    return this.watch(() => super.agent(req));
  }
}

describe('pace', () => {
  it('at the step pace starts nothing until a person takes a step, and one piece of work for each step', async () => {
    const provider = new Watched({ ...QUIET, delayMs: 20 });
    const h = await harness({ provider, settings: { pace: 'step' } });
    try {
      h.runner.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(provider.calls).toHaveLength(0);
      const preview = h.runner.view().pace.next;
      expect(preview.length).toBeGreaterThan(0);

      h.runner.step();
      expect(h.runner.view().active.map((a) => a.key)).toEqual([expect.stringContaining(preview[0]!.kind)]);
      await waitFor(() => !h.runner.busy, 'the step to finish');
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(provider.calls).toHaveLength(1);

      // A step while work is under way starts the next piece beside it: a person can move other work along.
      h.runner.step();
      h.runner.step();
      expect(h.runner.view().active).toHaveLength(2);
      await waitFor(() => !h.runner.busy, 'the step to finish');
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(provider.calls).toHaveLength(3);
    } finally { await h.cleanup(); }
  });

  it('at the steady pace runs a whole cycle one call at a time', async () => {
    const provider = new Watched({ ...QUIET, delayMs: 2 });
    const h = await harness({ provider, settings: { pace: 'steady', maxConcurrentCalls: 4 } });
    try {
      h.runner.start();
      await waitFor(() => h.org.status === 'paused' && !h.runner.busy, 'the cycle to finish', 30_000);
      expect(h.org.pauseReason).toBe('cycle_limit');
      expect(provider.most).toBe(1);
    } finally { await h.cleanup(); }
  });

  it('at the slow pace leaves a pause between one call ending and the next starting', async () => {
    const provider = new Watched({ ...QUIET, delayMs: 2 });
    const h = await harness({ provider, settings: { pace: 'slow' }, runner: { paceGapMs: 60 } });
    try {
      h.runner.start();
      await waitFor(() => provider.calls.length >= 3, 'three calls');
      expect(h.runner.view().pace.nextAt === null || Date.parse(h.runner.view().pace.nextAt!) > Date.now() - 60).toBe(true);
      const [a, b, c] = provider.calls;
      expect(b!.start - a!.end).toBeGreaterThanOrEqual(50);
      expect(c!.start - b!.end).toBeGreaterThanOrEqual(50);
      expect(provider.most).toBe(1);
    } finally { await h.cleanup(); }
  });

  it('carries on at full speed when the pace is raised, and takes no step at any other pace', async () => {
    const provider = new Watched({ ...QUIET, delayMs: 2 });
    const h = await harness({ provider, settings: { pace: 'step' } });
    try {
      h.runner.start();
      h.runner.updateSettings({ pace: 'free' });
      expect(() => h.runner.step()).toThrow('step pace');
      await waitFor(() => h.org.status === 'paused' && !h.runner.busy, 'the cycle to finish', 30_000);
      expect(h.org.pauseReason).toBe('cycle_limit');
      expect(provider.most).toBeGreaterThan(1);
    } finally { await h.cleanup(); }
  });
});
