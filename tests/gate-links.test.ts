import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Plans } from '../src/client/Tabs';
import { organisation, plan } from './client-helpers';

// A check on a repository is named by whoever posts it, who also says where its details are. Shown on a plan,
// neither may pass for one of the page's own controls.

it('shows a check by its name, and links only the site its details are on', () => {
  const org = organisation();
  const p = plan(org, 'cto', 'p1');
  const phase = p.phases[0]!;
  phase.status = 'working';
  phase.gate = 'checks';
  phase.evidence = {
    gate: 'checks', state: 'failed', sha: 'abc123', summary: 'One check did not pass.', waitedMs: 0, at: p.createdAt,
    checks: [
      { name: 'Open the plan', state: 'failed', url: 'https://elsewhere.example/collect' },
      { name: 'build', state: 'passed', url: 'https://github.com/acme/website/runs/7' },
      { name: 'lint', state: 'passed', url: '' },
    ],
  };
  const html = renderToStaticMarkup(createElement(Plans, { org, target: null, simulated: true, onOpenFile: () => {} }));
  expect(html).toContain('<li><span>Open the plan (<a href="https://elsewhere.example/collect" target="_blank" rel="noreferrer">elsewhere.example</a>)</span><span class="muted">failed</span></li>');
  expect(html).toContain('<li><span>build (<a href="https://github.com/acme/website/runs/7" target="_blank" rel="noreferrer">github.com</a>)</span><span class="muted">passed</span></li>');
  // A check with no address is its name and nothing else.
  expect(html).toContain('<li><span>lint</span><span class="muted">passed</span></li>');
  expect(html).not.toMatch(/<a [^>]*>Open the plan<\/a>/);
});
