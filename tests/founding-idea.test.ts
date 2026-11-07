import { describe, expect, it } from 'vitest';
import { systemFor } from '../src/server/engine/prompts';
import { createOrganisation } from '../src/server/engine/state';

const idea = 'Promote https://github.com/PolyLabs-research/the_organisation until it is the default tool for running organisations of agents.';

describe('the founding idea', () => {
  it('reaches every seat in the founders’ own words, beside the shorter mission', () => {
    const org = createOrganisation({ name: 'Amplify', idea, mission: 'Grow the project.', executives: [{ profileId: 'marketing' }] }, 'org_1');
    for (const seat of org.executives) {
      const { charter } = systemFor(org, seat);
      expect(charter).toContain('Grow the project.');
      expect(charter).toContain(idea);
    }
  });

  it('is not repeated when the mission is the idea itself', () => {
    const org = createOrganisation({ name: 'Amplify', idea, executives: [{ profileId: 'marketing' }] }, 'org_1');
    const { charter } = systemFor(org, org.executives[0]!);
    expect(charter.split(idea)).toHaveLength(2);
    expect(charter).not.toContain('# The founding idea');
  });
});
