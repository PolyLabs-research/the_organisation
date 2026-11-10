import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../src/client/ui';

// How the dashboard shows text an agent wrote: board messages, reports, gate reviews and the workspace's
// Markdown files. It is laid out as Markdown, with nothing in it that can be clicked or fetched.

const shown = (text: string) => renderToStaticMarkup(createElement(Markdown, { children: text }));

describe('text an agent wrote, as the dashboard shows it', () => {
  it('writes a link out as its label and its address, with nothing to click', () => {
    // A label that reads like one of the page's own controls, and one that reads like a different address.
    const control = shown('Done.\n\n[Open the plan](https://elsewhere.example/collect?d=quote)');
    expect(control).not.toContain('<a');
    expect(control).toContain('<p>Open the plan (https://elsewhere.example/collect?d=quote)</p>');
    const address = shown('Sign in again at [https://bank.example/login](https://elsewhere.example/login).');
    expect(address).not.toContain('<a');
    expect(address).toContain('https://bank.example/login (https://elsewhere.example/login)');
    // A path in the workspace, which is what most links in a report are.
    expect(shown('See [the **spec**](engineering/spec.md).')).toBe('<div class="md"><p>See the <strong>spec</strong> (engineering/spec.md).</p></div>');
    expect(shown('[Pay here][1]\n\n[1]: https://elsewhere.example/pay')).toContain('<p>Pay here (https://elsewhere.example/pay)</p>');
  });

  it('shows an address once when the link is nothing but its address', () => {
    expect(shown('<https://example.com/quote>')).toBe('<div class="md"><p>https://example.com/quote</p></div>');
  });

  it('gives an address that could run something no place at all', () => {
    const html = shown('[Open the plan](javascript:alert(1))');
    expect(html).toBe('<div class="md"><p>Open the plan</p></div>');
  });

  it('shows an image as its label and fetches nothing', () => {
    const html = shown('![the quote](https://elsewhere.example/pixel.png?d=quote)');
    expect(html).not.toContain('<img');
    expect(html).toContain('[image: the quote]');
  });
});
