import { LEAD_PROFILES, MAX_LEADS, PROFILE_BY_ID } from '../shared/profiles';
import type { Effort, ExecutiveDraft, TeamRecommendation } from '../shared/types';
import { RECOMMEND_SYSTEM, recommendPrompt } from './engine/prompts';
import { RecommendTeam } from './engine/schemas';
import { ProviderError, type Provider } from './providers/types';

const MAX_RECOMMENDED_AGENTS = 6;

/** Ask the model which executive team an idea needs. */
export async function recommendTeam(provider: Provider, idea: string, model: string, effort: Effort): Promise<TeamRecommendation> {
  const library = LEAD_PROFILES.map(
    (p) => `- ${p.id}: ${p.title} (${p.short}), leads ${p.function}. ${p.remit} Operating profile: ${p.phases.map((ph) => ph.name).join(' → ')}.`,
  ).join('\n');
  const data = await provider.structured({
    kind: 'recommend_team',
    system: RECOMMEND_SYSTEM,
    prompt: recommendPrompt(idea, library),
    schema: RecommendTeam,
    model,
    effort,
    context: { idea },
  });

  const seen = new Set<string>();
  const executives: ExecutiveDraft[] = [];
  for (const seat of data.executives) {
    const agentCount = Math.min(MAX_RECOMMENDED_AGENTS, Math.max(1, Math.round(seat.agents) || 1));
    const rationale = seat.rationale.trim();
    const profile = PROFILE_BY_ID[seat.profileId];
    if (profile?.kind === 'lead') {
      if (seen.has(profile.id)) continue;
      seen.add(profile.id);
      executives.push({ profileId: profile.id, remit: seat.remit.trim() || undefined, agentCount, rationale });
    } else if (!profile && seat.title.trim() && seat.phases.length >= 2) {
      // A seat the library does not have: the model supplies its operating profile.
      executives.push({
        profileId: 'custom',
        title: seat.title.trim(),
        short: seat.short.trim() || undefined,
        function: seat.function.trim() || undefined,
        remit: seat.remit.trim(),
        phases: seat.phases.map((p) => ({ id: p.name, name: p.name, purpose: p.purpose, deliverable: p.deliverable })),
        agentCount,
        rationale,
      });
    }
    if (executives.length >= MAX_LEADS) break;
  }
  if (!executives.length) throw new ProviderError('The recommendation named no usable executive seats.', 'invalid_output', true);
  return { name: data.name.trim().slice(0, 80), mission: data.mission.trim().slice(0, 600), executives };
}
