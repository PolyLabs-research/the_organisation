import { CircleHelp, X } from 'lucide-react';
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import readme from '../../README.md?raw';
import businessOperations from '../../docs/business-operations.md?raw';
import codeRepositories from '../../docs/code-repositories.md?raw';
import emailAndAccounts from '../../docs/email-and-accounts.md?raw';
import toolServers from '../../docs/tool-servers.md?raw';
import userGuide from '../../docs/user-guide.md?raw';

// The guides are the repository's own docs, so what the app shows cannot drift from what the docs say.
export const GUIDES = {
  'user-guide': { title: 'Using the dashboard', file: 'user-guide.md', text: userGuide },
  'email-and-accounts': { title: 'Email & accounts', file: 'email-and-accounts.md', text: emailAndAccounts },
  'code-repositories': { title: 'GitHub repositories', file: 'code-repositories.md', text: codeRepositories },
  'tool-servers': { title: 'Tool servers', file: 'tool-servers.md', text: toolServers },
  'business-operations': { title: 'Calendar & business', file: 'business-operations.md', text: businessOperations },
  reference: { title: 'Full reference', file: 'README.md', text: readme },
} as const;
export type GuideId = keyof typeof GUIDES;
type Target = { guide: GuideId; section?: string };

// The docs give addresses for the app's default origin; here they can name the one it is open on.
const DEFAULT_ORIGIN = 'http://127.0.0.1:4780';
const SOURCE = 'https://github.com/PolyLabs-research/the_organisation/blob/main/';
const IMAGES = import.meta.glob<string>('../../docs/*.png', { eager: true, query: '?url', import: 'default' });

/** The anchor GitHub gives a heading, so that links written for the docs on GitHub work here too. */
function slug(text: string): string {
  return text.trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-');
}
function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (node && typeof node === 'object' && 'props' in node) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}
function guideFor(file: string): GuideId | undefined {
  const name = file.split('/').pop();
  return (Object.keys(GUIDES) as GuideId[]).find((id) => GUIDES[id].file === name);
}

const HelpContext = createContext<(target: Target) => void>(() => {});
export const useHelp = () => useContext(HelpContext);

/** Opens a guide at a section; place it next to whatever the section explains. */
export function HelpLink({ guide, section, children = 'How to set this up' }: Target & { children?: ReactNode }) {
  const open = useHelp();
  return (
    <button type="button" className="help-link" onClick={() => open({ guide, section })}>
      <CircleHelp size={14} aria-hidden="true" /> {children}
    </button>
  );
}

export function HelpButton({ guide = 'user-guide' }: { guide?: GuideId }) {
  const open = useHelp();
  return (
    <button type="button" className="icon-button" onClick={() => open({ guide })} aria-label="Help and setup guides" title="Help and setup guides">
      <CircleHelp size={18} />
    </button>
  );
}

export function HelpProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Target | null>(null);
  return (
    <HelpContext.Provider value={setTarget}>
      {children}
      {target ? <GuideDialog target={target} onNavigate={setTarget} onClose={() => setTarget(null)} /> : null}
    </HelpContext.Provider>
  );
}

function GuideDialog({ target, onNavigate, onClose }: { target: Target; onNavigate: (target: Target) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    const heading = target.section ? body.current?.querySelector(`[id="${CSS.escape(target.section)}"]`) : null;
    if (heading) heading.scrollIntoView({ block: 'start' });
    else body.current?.scrollTo({ top: 0 });
  }, [target]);

  const follow = (href: string) => {
    const [path, section] = href.split('#');
    if (!path) return onNavigate({ guide: target.guide, section });
    const guide = guideFor(path);
    if (guide) return onNavigate({ guide, section });
    window.open(SOURCE + path.replace(/^(\.\.\/)+/, ''), '_blank', 'noopener,noreferrer');
  };
  const heading = (Tag: 'h1' | 'h2' | 'h3' | 'h4') =>
    function Heading({ children }: { children?: ReactNode }) {
      return <Tag id={slug(textOf(children))}>{children}</Tag>;
    };
  // Drawn once for each guide. This dialog is drawn again at every change in the organisation behind it, and the components
  // for headings, links and images, made afresh each time, were then new components to React: it parsed the whole guide
  // again, took every heading, link and picture out of the page and built another.
  const text = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: heading('h1'),
          h2: heading('h2'),
          h3: heading('h3'),
          h4: heading('h4'),
          a: ({ href = '', children }) =>
            /^[a-z]+:/i.test(href) ? (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ) : (
              <a href={href} onClick={(event) => { event.preventDefault(); follow(href); }}>
                {children}
              </a>
            ),
          img: ({ alt, src = '' }) => {
            const url = IMAGES[`../../docs/${src.split('/').pop()}`];
            return url ? <img src={url} alt={alt ?? ''} loading="lazy" /> : <span className="muted">[image: {alt || src}]</span>;
          },
        }}
      >
        {GUIDES[target.guide].text.replaceAll(DEFAULT_ORIGIN, window.location.origin)}
      </ReactMarkdown>
    ),
    [target.guide, onNavigate],
  );

  return (
    <dialog ref={dialog} className="dialog guide" onClose={onClose} aria-labelledby="guide-title">
      <header className="dialog-head">
        <h2 id="guide-title">Help</h2>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close help">
          <X size={18} />
        </button>
      </header>
      <div className="chips guide-picker" role="group" aria-label="Guide">
        {(Object.keys(GUIDES) as GuideId[]).map((id) => (
          <button key={id} type="button" className={`chip${id === target.guide ? ' is-on' : ''}`} aria-pressed={id === target.guide} onClick={() => onNavigate({ guide: id })}>
            {GUIDES[id].title}
          </button>
        ))}
      </div>
      <div className="dialog-body md guide-body" ref={body}>
        {text}
      </div>
    </dialog>
  );
}
