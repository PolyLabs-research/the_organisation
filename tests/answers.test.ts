import { describe, expect, it } from 'vitest';
import { harness, runToRest } from './helpers';

describe('objections the plan’s owner accepts', () => {
  it('revise the plan without the board sitting', async () => {
    const h = await harness({ mock: { objections: 'first_round', answers: 'accept' } });
    try {
      await runToRest(h.runner);
      const decision = h.org.decisions.find((d) => d.kind === 'contested')!;
      expect(decision.outcome).toMatchObject({ method: 'owner', planAction: 'amend' });
      expect(decision.positions).toEqual({});
      const plan = h.org.plans.find((p) => p.id === decision.planId)!;
      expect(plan.amendments).toContain('Start the dependent part only once the other function’s first deliverable is in the workspace.');
      const kinds = h.runner.activity.map((a) => a.kind);
      expect(kinds).toContain('answer');
      expect(kinds).toContain('revise');
      expect(kinds).not.toContain('position');
      expect(kinds).not.toContain('signoff');
      expect(h.org.plans.every((p) => p.status === 'done')).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});

describe('objections the plan’s owner contests', () => {
  it('go to the board, with the owner’s answer as its position', async () => {
    const h = await harness({ mock: { objections: 'first_round', answers: 'contest' } });
    try {
      await runToRest(h.runner);
      const decision = h.org.decisions.find((d) => d.kind === 'contested')!;
      const owner = h.org.plans.find((p) => p.id === decision.planId)!.ownerId;
      expect(decision.positions[owner]?.stance).toBe('back_plan');
      const positions = h.runner.activity.filter((a) => a.kind === 'position');
      expect(positions.map((a) => a.execId)).not.toContain(owner);
      expect(positions).toHaveLength(decision.participantIds.length - 1);
      expect(h.runner.activity.some((a) => a.kind === 'signoff')).toBe(true);
    } finally {
      await h.cleanup();
    }
  });
});
