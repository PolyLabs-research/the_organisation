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
    id: `a${i + 1}`, at: new Date(NOON - (count - 1 - i) * 20_000).toISOString(), kind: 'consult' as const, execId: 'cto', label: `Call ${i + 1}`, model: 'm',
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

  it('draws the latest calls on the timeline, and says how many there are in all', () => {
    const html = renderToStaticMarkup(createElement(Timeline, { org: organisation(), entries: calls, projected: [], now: NOON, running: false }));
    expect(html).toContain('class="gantt"');
    expect(html.match(/class="gantt-bar/g)).toHaveLength(3000);
    expect(html).toContain('aria-label="Call 150000,');
    expect(html).toContain('aria-label="Call 147001,');
    expect(html).not.toContain('aria-label="Call 147000,');
    expect(html).toContain('The timeline shows the latest 3,000 of 150,000 calls');
  });

  it('draws every call of a log short enough to draw whole, and has nothing to add', () => {
    const html = renderToStaticMarkup(createElement(Timeline, { org: organisation(), entries: log(40), projected: [], now: NOON, running: false }));
    expect(html.match(/class="gantt-bar/g)).toHaveLength(40);
    expect(html).not.toContain('The timeline shows the latest');
  });
});
