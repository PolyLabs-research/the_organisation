import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app';
import { serveBuiltClient, serveClientFromSource } from './client';
import { ROOT_DIR, loadConfig } from './config';
import { ConnectionStore } from './connections';
import { DataDirInUse, claimDataDir } from './lock';
import { ProviderRouter } from './providers/router';
import { Registry } from './registry';
import { SandboxRuntime } from './sandbox';
import { Store } from './store';

/** How to give the data folder back, once this server has taken it. */
let releaseData: (() => Promise<void>) | null = null;

async function main(): Promise<void> {
  // "npm start" says so with a flag, not by setting a variable in front of the command, which only some shells allow.
  if (process.argv.includes('--production')) process.env.NODE_ENV = 'production';
  const envFile = path.join(ROOT_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig();

  // One server to a data folder: a second would save over this one's state and could run the same organisations.
  releaseData = await claimDataDir(config.dataDir, config.port);
  const store = new Store(config.dataDir);
  await store.init();
  // The keys this server can call models with: those in the environment, and those added through the interface.
  const connections = new ConnectionStore(path.join(config.dataDir, 'connections.json'), process.env, config.anthropicAmbient);
  await connections.load();
  const provider = new ProviderRouter(connections, {
    forceMock: config.provider === 'mock',
    // The simulator answers in about a second so the dashboard has something to show as it runs.
    mock: { delayMs: [500, 1600] },
    claude: { managedStateFile: path.join(config.dataDir, 'managed.json'), workspace: config.workspace },
    claudeCode: {
      command: config.claudeCode.command,
      dir: path.join(config.dataDir, 'claude-code'),
      extraUsage: config.claudeCode.extraUsage,
      ...(config.claudeCode.blocked ? { blocked: config.claudeCode.blocked } : {}),
    },
  });
  // What code is run with, for the roles the shareholders let run it. Whether there is anything here to run it with is found out when it is first wanted.
  const registry = new Registry(store, provider, { sandbox: new SandboxRuntime(config.sandbox ?? { blocked: 'Running code is not set up on this server.' }) });
  await registry.load();
  // What each key can call is asked for in the background: the server does not wait on other people's APIs to start.
  void provider.refreshStale();

  const app = createApp(registry, config, provider);
  const clientDir = path.join(ROOT_DIR, 'dist', 'client');
  if (config.production) {
    if (!existsSync(path.join(clientDir, 'index.html'))) {
      throw new Error('The client has not been built. Run "npm run build" first, or use "npm run dev".');
    }
    serveBuiltClient(app, clientDir);
  } else {
    // In development Vite serves the client from source, with hot reload, on the same port as the API.
    await serveClientFromSource(app, { root: ROOT_DIR, dataDir: config.dataDir, allowedHosts: config.allowedHosts });
  }

  const server = app.listen(config.port, config.host, () => {
    const shown = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host;
    console.log(`the_organisation is running at http://${shown}:${config.port}`);
    const info = provider.info();
    console.log(
      info.simulated
        ? `Simulating: ${config.provider === 'mock' ? 'ORG_PROVIDER=mock' : 'no API key is connected yet. Add one under "Models and keys".'}`
        : info.connections?.length
          ? `Connected: ${info.label}`
          : 'No API key is connected. Organisations pause when they next need a model: add a key under "Models and keys", or start with ORG_PROVIDER=mock to simulate.',
    );
    console.log(`Data: ${config.dataDir}`);
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT to another one.` : err);
    void (releaseData?.() ?? Promise.resolve()).catch(() => {}).then(() => process.exit(1));
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nPausing organisations and saving state…');
    await registry.shutdown();
    await releaseData?.().catch(() => {});
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  console.error(err instanceof DataDirInUse ? err.message : err);
  await releaseData?.().catch(() => {});
  process.exit(1);
});
