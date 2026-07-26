/**
 * Entry point for the HTTP backend.
 *
 *   SPLITLLM_API_TOKEN=… node --experimental-strip-types src/server/index.ts
 *
 * Environment:
 *   SPLITLLM_API_TOKEN     required — a single bearer token
 *   SPLITLLM_API_TOKENS    optional — `label:token,label:token` for several clients
 *   SPLITLLM_BIND          default 127.0.0.1 (loopback: expose it via a proxy, not directly)
 *   SPLITLLM_PORT          default 8080
 *   SPLITLLM_DB            default ./splitllm.db
 *   SPLITLLM_MODEL         default huihui_ai/qwen3.5-abliterated:4B
 *   OLLAMA_HOST            default http://localhost:11434
 *   SPLITLLM_MAX_CONCURRENT default 1
 *
 * The bind address defaults to loopback on purpose. Binding 0.0.0.0 by default
 * would mean a misread env var silently publishes the model to the network;
 * containers set SPLITLLM_BIND=0.0.0.0 explicitly, where the container boundary
 * is the thing limiting exposure.
 */

import { createApi } from './api.ts';
import { seedGraph } from '../graph/seed.ts';
import { GraphDb, defaultDbPath } from '../graph/db.ts';

const HOST = process.env.SPLITLLM_BIND ?? '127.0.0.1';
const PORT = Number(process.env.SPLITLLM_PORT ?? 8080);

function main(): void {
  const dbPath = process.env.SPLITLLM_DB ?? defaultDbPath();

  // Seed before the API opens its own handle, so a fresh container comes up
  // with a usable graph instead of routing nothing until someone runs /learn.
  {
    const db = new GraphDb(dbPath);
    if (db.countModules() === 0) {
      const stats = seedGraph(db);
      console.log(`seeded ${stats.modules} modules, ${stats.edges} edges`);
    }
    db.close();
  }

  let api: ReturnType<typeof createApi>;
  try {
    api = createApi({ dbPath });
  } catch (err) {
    console.error(`refusing to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  api.server.listen(PORT, HOST, () => {
    console.log(`splitllm api on http://${HOST}:${PORT}`);
    console.log(`  db=${dbPath} model=${process.env.SPLITLLM_MODEL ?? 'default'} ollama=${process.env.OLLAMA_HOST ?? 'http://localhost:11434'}`);
  });

  const shutdown = (sig: string): void => {
    console.log(`\n${sig} — shutting down`);
    void api.close().then(() => process.exit(0));
    // A generation in flight can hold the socket for minutes; do not wait for it.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
