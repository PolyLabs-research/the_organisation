import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Overseer, Timeline } from '../src/client/Overseer';
import type { ActivityEntry, OrgView } from '../src/shared/types';
import { organisation } from './client-helpers';

// The Overseer draws its views from every call an organisation has made, and a long-lived one has made a great many.

const NOON = Date.parse('2026-11-08T12:00:00Z');

/** That many calls by one lead, twenty seconds apart, the last of them at noon. */
function log(count: number): ActivityEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `a${i + 1}`, at: new Date(NOON - (count - 1 - i) * 20_000).toISOString(), kind: 'consult' as const, execId: 'cto', label: `Call ${i + 1}`, model: 'claude-sonnet-5-5',
    ms: 5000, ok: true, error: null, inputTokens: 3000, outputTokens: 300, costUsd: 0.01,
  }));
}

describe('the overseer on a long log', () => {
  // More calls than a function can be handed as arguments, which is how the earliest and the latest used to be found.
  const calls = log(150_000);

  it('opens on a paused organisation, where the forecast runs from the last call', () => {
    const org = organisation();
    org.status = 'paused';
    org.pauseReason = 'user';
    const view: OrgView = { org, active: [], draining: false, pace: { next: [], nextAt: null } };
    expect(renderToStaticMarkup(createElement(Overseer, { view, activity: calls }))).toContain('class="overseer"');
  });

  it('draws the timeline', () => {
    const html = renderToStaticMarkup(createElement(Timeline, { org: organisation(), entries: calls, projected: [], now: NOON, running: false }));
    expect(html).toContain('class="gantt"');
    expect(html).toContain('Call 150000');
  });
});
