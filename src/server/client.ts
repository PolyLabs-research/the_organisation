import path from 'node:path';
import express, { type RequestHandler } from 'express';

// Serving the web interface. In development Vite serves it from source, and Vite serves the folder it is
// given: the whole project. By default the data folder is inside the project, and it holds the API keys added
// in the interface, every organisation's state and files, and the vault. None of that is the client's to read.

const slashed = (file: string) => file.split(path.sep).join('/');

/**
 * Turn away any request addressed to the data folder, however the address is written. This stands in front
 * of whatever serves files, so that it holds whatever that is and however it is configured.
 */
export function keepDataPrivate(root: string, dataDir: string): RequestHandler {
  const data = slashed(path.resolve(dataDir)).toLowerCase();
  const inside = path.relative(path.resolve(root), path.resolve(dataDir));
  // The address a browser would know the data folder by, where it is inside the folder being served.
  const local = inside && !inside.startsWith('..') && !path.isAbsolute(inside) ? `/${slashed(inside).toLowerCase()}` : null;
  return (req, res, next) => {
    let asked: string;
    try {
      const raw = req.url.split(/[?#]/, 1)[0] ?? '';
      asked = path.posix.normalize(`/${decodeURIComponent(raw).replace(/\\/g, '/')}`).toLowerCase();
    } catch {
      res.status(400).end();
      return;
    }
    const within = (folder: string) => asked === folder || asked.startsWith(`${folder}/`);
    // Vite also serves files by their full path on disk, under /@fs/.
    if ((local && within(local)) || asked.includes(data)) {
      res.status(404).end();
      return;
    }
    next();
  };
}

/** A path as a pattern that matches only itself, whatever characters it holds. */
const literal = (file: string) => slashed(file).replace(/[\\*?[\]{}()!+@|]/g, '\\$&');

export interface SourceClientOptions {
  /** The folder the client is served from: the project. */
  root: string;
  dataDir: string;
  /** Names the server answers to besides localhost and its addresses. */
  allowedHosts?: string[];
  /** For tests: no log output and no hot-reload socket. */
  quiet?: boolean;
}

/**
 * Serve the client from source through Vite, with hot reload, on the same port as the API. The data folder is
 * kept out of what Vite will read, and out of reach of any request, twice over.
 */
export async function serveClientFromSource(app: express.Express, options: SourceClientOptions): Promise<{ close(): Promise<void>; denied: string[] }> {
  const { createServer, resolveConfig } = await import('vite');
  // Vite refuses a list of sensitive files by itself (.env and the like). The data folder is added to that
  // list, read from Vite so that it stays whole when Vite's own list grows.
  const standing = (await resolveConfig({ root: options.root, configFile: false, logLevel: 'silent' }, 'serve')).server.fs.deny;
  const denied = [...standing, `${literal(path.resolve(options.dataDir))}/**`];
  const vite = await createServer({
    root: options.root,
    appType: 'spa',
    ...(options.quiet ? { logLevel: 'silent' as const } : {}),
    server: {
      middlewareMode: true,
      fs: { deny: denied },
      ...(options.allowedHosts?.length ? { allowedHosts: options.allowedHosts } : {}),
      ...(options.quiet ? { hmr: false, ws: false as const } : {}),
    },
  });
  app.use(keepDataPrivate(options.root, options.dataDir));
  app.use(vite.middlewares);
  // What Vite itself was left holding, for whoever needs to check it.
  return { close: () => vite.close(), denied: vite.config.server.fs.deny };
}

/**
 * Serve the client as it was built: only what is in the build folder. The page finds its own way from what follows
 * "#" in the address, so "/" is the only address it has. Any other that reads like a page's is sent there, and one
 * that reads like a file's (a script from before the last build, say) is simply not there: answered with the page
 * and a 200, as it used to be, a missing script arrived as a page the browser could make nothing of. Neither
 * answer reads anything from disk, so a flood of made-up addresses costs next to nothing.
 */
export function serveBuiltClient(app: express.Express, clientDir: string): void {
  app.use(express.static(clientDir));
  app.get('/{*path}', (req, res) => {
    // "/" comes this far only if the built page has gone since the server started: sending it to "/" would go round for ever.
    if (req.path === '/' || path.posix.extname(req.path)) res.status(404).type('text/plain').send('Not found.');
    else res.redirect(302, '/');
  });
}
