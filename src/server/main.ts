import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createApp } from './app';
import { ROOT_DIR, loadConfig } from './config';
import { ConnectionStore } from './connections';
import { ProviderRouter } from './providers/router';
import { Registry } from './registry';
import { Store } from './store';

async function main(): Promise<void> {
  const envFile = path.join(ROOT_DIR, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const config = loadConfig();

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
  const registry = new Registry(store, provider);
  await registry.load();
  // What each key can call is asked for in the background: the server does not wait on other people's APIs to start.
  void provider.refreshStale();

  const app = createApp(registry, config, provider);
  const clientDir = path.join(ROOT_DIR, 'dist', 'client');
  if (config.production) {
    if (!existsSync(path.join(clientDir, 'index.html'))) {
      throw new Error('The client has not been built. Run "npm run build" first, or use "npm run dev".');
    }
    app.use(express.static(clientDir));
    app.get('/{*path}', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
  } else {
    // In development Vite serves the client from source, with hot reload, on the same port as the API.
    const { createServer } = await import('vite');
    const vite = await createServer({ root: ROOT_DIR, server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
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
    process.exit(1);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('\nPausing organisations and saving state…');
    await registry.shutdown();
    server.closeAllConnections();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
