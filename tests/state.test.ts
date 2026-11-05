import { describe, expect, it } from 'vitest';
import { LEAD_PROFILES, PROFILES, executiveFromDraft } from '../src/shared/profiles';
import { DEFAULT_SETTINGS, ValidationError, assertModelRefs, createOrganisation, isModelRef, sanitiseSettings } from '../src/server/engine/state';
import { MODELS, costOfRequest, priceUsage } from '../src/server/providers/pricing';
import { MockProvider } from '../src/server/providers/mock';
import { recommendTeam } from '../src/server/recommend';

describe('the profile library', () => {
  it('gives every profile type a standard operating profile', () => {
    expect(new Set(PROFILES.map((p) => p.id)).size).toBe(PROFILES.length);
    for (const profile of PROFILES) {
      expect(profile.phases.length).toBeGreaterThanOrEqual(3);
      expect(new Set(profile.phases.map((p) => p.id)).size).toBe(profile.phases.length);
      for (const phase of profile.phases) {
        expect(phase.purpose).toBeTruthy();
        expect(phase.deliverable).toBeTruthy();
      }
    }
  });

  it('has the engineering lead spec, build, test and release', () => {
    const cto = PROFILES.find((p) => p.id === 'engineering')!;
    expect(cto.phases.map((p) => p.name)).toEqual(['Spec', 'Build', 'Test', 'Release']);
  });

  it('seats exactly one CEO and one judge profile, neither with agents', () => {
    expect(PROFILES.filter((p) => p.kind === 'ceo')).toHaveLength(1);
    expect(PROFILES.filter((p) => p.kind === 'judge')).toHaveLength(1);
    expect(PROFILES.filter((p) => p.kind !== 'lead').every((p) => p.defaultAgents === 0)).toBe(true);
    expect(LEAD_PROFILES.every((p) => p.defaultAgents >= 1)).toBe(true);
  });

  it('builds a custom seat from a title and its own phases', () => {
    const seat = executiveFromDraft(
      {
        profileId: 'custom',
        title: 'Chief Sustainability Officer',
        remit: 'Sourcing and footprint.',
        phases: [
          { id: '', name: 'Audit', purpose: 'Measure.', deliverable: 'A footprint.' },
          { id: '', name: 'Reduce', purpose: 'Cut it.', deliverable: 'A plan.' },
        ],
        agentCount: 99,
      },
      'cso',
    )!;
    expect(seat).toMatchObject({ profileId: 'custom', kind: 'lead', short: 'CSO', agentCount: 8 });
    expect(seat.phases.map((p) => p.id)).toEqual(['audit', 'reduce']);
    expect(executiveFromDraft({ profileId: 'custom', title: 'No Phases' }, 'x')).toBeNull();
    expect(executiveFromDraft({ profileId: 'nonsense' }, 'x')).toBeNull();
  });
});

describe('establishing an organisation', () => {
  const base = { name: 'Fernery', idea: 'Houseplants by post.' };

  it('always seats a CEO above the leads the founder chose', () => {
    const org = createOrganisation({ ...base, executives: [{ profileId: 'engineering', agentCount: 4 }, { profileId: 'finance' }] }, 'org_1');
    expect(org.executives.map((e) => [e.id, e.kind, e.agentCount])).toEqual([
      ['ceo', 'ceo', 0],
      ['cto', 'lead', 4],
      ['cfo', 'lead', 1],
    ]);
    expect(org.status).toBe('idle');
    expect(org.cycle).toMatchObject({ number: 1, stage: 'consult' });
  });

  it('ignores an attempt to seat a second CEO or a judge by hand', () => {
    const org = createOrganisation({ ...base, executives: [{ profileId: 'ceo' }, { profileId: 'judge' }, { profileId: 'product' }] }, 'org_1');
    expect(org.executives.map((e) => e.id)).toEqual(['ceo', 'cpo']);
  });

  it('seats the judge when the founder chooses one as arbiter', () => {
    const org = createOrganisation({ ...base, executives: [{ profileId: 'product' }], settings: { arbiter: 'judge' } }, 'org_1');
    expect(org.executives.at(-1)).toMatchObject({ id: 'judge', kind: 'judge', agentCount: 0 });
  });

  it('gives two seats of the same profile different ids', () => {
    const org = createOrganisation({ ...base, executives: [{ profileId: 'engineering' }, { profileId: 'engineering', title: 'Platform Lead' }] }, 'org_1');
    expect(org.executives.map((e) => e.id)).toEqual(['ceo', 'cto', 'cto-2']);
  });

  it('records steer given at the outset', () => {
    const org = createOrganisation({ ...base, executives: [{ profileId: 'product' }], steer: 'UK first.' }, 'org_1');
    expect(org.steers).toHaveLength(1);
    expect(org.steers[0]).toMatchObject({ text: 'UK first.', status: 'new' });
  });

  it.each([
    [{ name: '', idea: 'x', executives: [{ profileId: 'product' }] }, /name/],
    [{ name: 'x', idea: ' ', executives: [{ profileId: 'product' }] }, /idea/],
    [{ name: 'x', idea: 'x', executives: [] }, /at least one/],
    [{ name: 'x', idea: 'x', executives: Array.from({ length: 9 }, () => ({ profileId: 'product' })) }, /at most/],
  ])('rejects an organisation that cannot work', (request, message) => {
    expect(() => createOrganisation(request, 'org_1')).toThrow(ValidationError);
    expect(() => createOrganisation(request, 'org_1')).toThrow(message);
  });
});

describe('settings', () => {
  it('takes a model by the connection it is reached through and the provider\'s id for it', () => {
    // Whether the model can be called is for the provider to say; here only the form is checked.
    // Anything a provider's listing could call a model is a name: a local server's may have spaces and brackets in it.
    for (const ref of ['claude-opus-5-5', 'openai:gpt-5', 'deepseek:deepseek-chat', 'openrouter:moonshotai/kimi-k2:free', 'custom:qwen3-30b@q4', 'custom:My Model (Q4)', 'custom:model=b', 'minimax:MiniMax-M3.1-Flash']) {
      expect(isModelRef(ref)).toBe(true);
      expect(sanitiseSettings({ executiveModel: ref }).executiveModel).toBe(ref);
    }
    for (const ref of ['', ' ', ' leading-space', 'x'.repeat(300), 'bell\u0007', 'two\nlines', 42 as never, null as never]) {
      expect(isModelRef(ref)).toBe(false);
      expect(sanitiseSettings({ executiveModel: ref }).executiveModel).toBe(DEFAULT_SETTINGS.executiveModel);
    }
  });

  it('refuses a change that names a model in a form no model has, instead of quietly keeping the old one', () => {
    expect(() => assertModelRefs({ executiveModel: '' })).toThrow(/model named for the executives is not a model’s name/);
    expect(() => assertModelRefs({ workerModel: 7 as never })).toThrow(/model named for the agents/);
    expect(() => assertModelRefs({ workerModel: 'custom:My Model (Q4)', budgetUsd: 3 })).not.toThrow();
    expect(() => assertModelRefs({ budgetUsd: 3 })).not.toThrow();
    expect(() => assertModelRefs(undefined)).not.toThrow();
  });

  it('keeps every value inside its range', () => {
    const s = sanitiseSettings({
      budgetUsd: -5,
      maxCycles: 0,
      maxFollowUpDepth: 99,
      maxConcurrentCalls: 500,
      executiveModel: '',
      workerModel: 'claude-haiku-5-5',
      executiveEffort: 'extreme' as never,
      arbiter: 'king' as never,
    });
    expect(s).toMatchObject({
      budgetUsd: 0.1,
      maxCycles: 1,
      maxFollowUpDepth: 3,
      maxConcurrentCalls: 16,
      executiveModel: DEFAULT_SETTINGS.executiveModel,
      workerModel: 'claude-haiku-5-5',
      executiveEffort: 'medium',
      arbiter: 'ceo',
    });
  });

  it('leaves untouched what a patch does not mention, and can clear the cycle limit', () => {
    const base = sanitiseSettings({ budgetUsd: 42, maxCycles: 7, webResearch: true });
    expect(sanitiseSettings({ arbiter: 'judge' }, base)).toMatchObject({ budgetUsd: 42, maxCycles: 7, webResearch: true, arbiter: 'judge' });
    expect(sanitiseSettings({ maxCycles: null }, base).maxCycles).toBeNull();
  });

  it('defaults to the current Opus model, a modest budget and no web access', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ executiveModel: 'claude-opus-5-5', workerModel: 'claude-opus-5-5', webResearch: false, maxCycles: null });
    expect(DEFAULT_SETTINGS.budgetUsd).toBeLessThanOrEqual(10);
  });
});

describe('pricing', () => {
  it('prices each kind of token at the published rate', () => {
    const usage = priceUsage({ model: 'claude-opus-5-5', inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6, webSearches: 100 });
    expect(usage.costUsd).toBeCloseTo(4 + 20 + 0.2 + 5 + 1, 6);
  });

  it('charges Haiku its higher rate for a prompt over 100,000 tokens', () => {
    const tokens = { inputTokens: 400_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOfRequest('claude-haiku-5-5', tokens)).toBeCloseTo((400_000 * 0.5 + 10_000 * 2.5) / 1e6, 10);
    expect(costOfRequest('claude-haiku-5-5', { ...tokens, inputTokens: 90_000 })).toBeCloseTo((90_000 * 0.1 + 10_000 * 0.5) / 1e6, 10);
    // The threshold counts the whole prompt, cached or not.
    expect(costOfRequest('claude-haiku-5-5', { inputTokens: 1000, outputTokens: 0, cacheReadTokens: 150_000, cacheWriteTokens: 0 })).toBeCloseTo((1000 * 0.5 + 150_000 * 0.05) / 1e6, 10);
  });

  it('knows the rates of the models a declined request can fall back to', () => {
    const tokens = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOfRequest('claude-opus-4-8', tokens)).toBe(30);
    expect(costOfRequest('claude-opus-5', tokens)).toBe(30);
    expect(costOfRequest('claude-opus-5-5', tokens)).toBe(24);
  });

  it('prices a model it does not know as the default model rather than as free', () => {
    const known = priceUsage({ model: 'claude-opus-5-5', inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 });
    const unknown = priceUsage({ model: 'claude-something-new', inputTokens: 1000, outputTokens: 1000, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 0 });
    expect(unknown.costUsd).toBe(known.costUsd);
    expect(MODELS.map((m) => m.id)).toContain('claude-opus-5-5');
  });
});

describe('team recommendation', () => {
  it('turns an idea into a team of library seats', async () => {
    const rec = await recommendTeam(new MockProvider(), 'A mobile app that helps people in regulated healthcare book appointments.', 'claude-opus-5-5', 'medium');
    const ids = rec.executives.map((e) => e.profileId);
    expect(ids).toContain('engineering');
    expect(ids).toContain('legal');
    expect(ids).not.toContain('ceo');
    expect(new Set(ids).size).toBe(ids.length);
    expect(rec.executives.length).toBeGreaterThanOrEqual(3);
    expect(rec.executives.every((e) => (e.agentCount ?? 0) >= 1 && e.rationale)).toBe(true);
    expect(rec.name).toBeTruthy();
    expect(rec.mission).toBeTruthy();
    // The call is paid for but belongs to no organisation, so its cost is reported with it.
    expect(rec.costUsd).toBeGreaterThan(0);
    // What comes back can be used to establish the organisation as is.
    const org = createOrganisation({ name: rec.name, idea: 'x', mission: rec.mission, executives: rec.executives }, 'org_1');
    expect(org.executives).toHaveLength(rec.executives.length + 1);
  });

  it('always recommends at least three leads, whatever the idea', async () => {
    const rec = await recommendTeam(new MockProvider(), 'Something vague and hard to place.', 'claude-opus-5-5', 'medium');
    expect(rec.executives.length).toBeGreaterThanOrEqual(3);
  });
});
