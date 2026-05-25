import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import {
  writeFileSync,
  unlinkSync,
  readdirSync,
  mkdtempSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { startMockServer, type MockServer } from './helpers/mock-server.ts';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..', '..');
const APP_DIR = join(REPO_ROOT, 'packages', 'app');
const SERVER_DIR = join(REPO_ROOT, 'packages', 'server');
// Workspace target dir lives at the repo root, not under packages/server.
const SERVER_BIN = join(REPO_ROOT, 'target', 'debug', 'pantry-server');
const HARNESS_FILE = join(HERE, '__harness__.json');

// Docker mode: set INTEGRATION_SERVER_IMAGE=<tag> to run the suite against a
// pre-built container image instead of the native binary. INTEGRATION_SERVER_PLATFORM
// optionally pins the docker platform (e.g. linux/arm/v7) so foreign-arch
// images run under QEMU. Used by packages/server/scripts/build-pi.sh.
const SERVER_IMAGE = process.env.INTEGRATION_SERVER_IMAGE ?? '';
const SERVER_PLATFORM = process.env.INTEGRATION_SERVER_PLATFORM ?? '';
const DOCKER_MODE = SERVER_IMAGE.length > 0;

function buildRustServer(): void {
  console.log('[harness] Building Rust server (cargo build)…');
  const r = spawnSync('cargo', ['build', '-p', 'pantry-server'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (r.status !== 0) {
    throw new Error(`cargo build failed with code ${r.status}`);
  }
  if (!existsSync(SERVER_BIN)) {
    throw new Error(`built but missing binary at ${SERVER_BIN}`);
  }

  // rust-embed reads `static/client/` at runtime in dev profile, so the
  // build above succeeds even when the folder only contains `.gitkeep`.
  // With an empty embed the SPA serve path falls through to the bare
  // placeholder HTML, and `frontend.test.ts` stalls node:test's run()
  // stream waiting for shell-bearing pages that never materialize. Catch
  // that ahead of time with a clear pointer at the build script.
  const clientManifest = join(SERVER_DIR, 'static', 'client', 'manifest.json');
  if (!existsSync(clientManifest)) {
    throw new Error(
      `[harness] packages/server/static/client/manifest.json is missing — the\n` +
        `embedded Rex frontend isn't populated. Run:\n\n` +
        `  packages/server/scripts/sync-frontend.sh --build\n\n` +
        `then re-run the suite. (The Rex build output is gitignored, so this\n` +
        `step is required after a fresh clone or whenever packages/app changes.)`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, deadlineMs = 10_000): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (r.ok) {
        const j = (await r.json()) as { data?: { __typename?: string } };
        if (j.data?.__typename === 'Query') return;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(250);
  }
  throw new Error(
    `GraphQL server did not become ready within ${deadlineMs}ms at ${url}` +
      (lastErr ? `\nLast error: ${(lastErr as Error).message}` : ''),
  );
}

/**
 * Mark first-boot setup complete so the `route_by_setup` middleware
 * stops 307-redirecting GETs to `/setup`. Without this, every frontend
 * test that expects a 308 → `/` redirect (and every page-render
 * assertion) fails because the installer wizard intercepts first.
 */
async function markSetupComplete(url: string): Promise<void> {
  const r = await fetch(`${url}/api/setup-complete`, { method: 'POST' });
  if (!r.ok) {
    throw new Error(`POST /api/setup-complete failed: HTTP ${r.status}`);
  }
}

interface Handle {
  dbDir: string;
  mock: MockServer;
  child?: ChildProcess;       // native mode
  containerId?: string;       // docker mode
}

async function setup(): Promise<Handle> {
  if (!DOCKER_MODE) {
    buildRustServer();
  } else {
    console.log(`[harness] Docker mode: image=${SERVER_IMAGE} platform=${SERVER_PLATFORM || '(default)'}`);
  }

  const dbDir = mkdtempSync(join(tmpdir(), 'pantry-host-integration-'));
  const dbPath = join(dbDir, 'pantry.db');
  console.log(`\n[harness] SQLite database: ${dbPath}`);

  console.log('[harness] Starting mock HTTP server…');
  const mock = await startMockServer();
  console.log(`[harness] Mock server ready: ${mock.url}`);

  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  const uploadsDir = join(APP_DIR, 'public', 'uploads');

  const handle: Handle = { dbDir, mock };

  // In docker mode the mock URL embedded in test request bodies has to be
  // reachable *from inside the container* — 127.0.0.1 there is the container's
  // own loopback. Tests that embed mockUrl in /fetch-recipe payloads need this
  // rewritten to host.docker.internal so the container's reqwest client can
  // resolve it. Host-side fetches against the server still go to the mapped
  // 127.0.0.1:${port}, which is `url`.
  const mockPort = new URL(mock.url).port;
  const serverFacingMockUrl = DOCKER_MODE
    ? `http://host.docker.internal:${mockPort}`
    : mock.url;

  try {
    if (DOCKER_MODE) {
      handle.containerId = await spawnContainer({
        port,
        dbDir,
        uploadsDir,
        mockUrl: serverFacingMockUrl,
      });
    } else {
      handle.child = spawnNativeServer({ port, dbPath, uploadsDir, mockUrl: mock.url, dbDir });
    }
    // Foreign-arch containers under QEMU need a longer ready window; native is fast.
    await waitForServer(url, DOCKER_MODE ? 60_000 : 10_000);
    await markSetupComplete(url);
  } catch (err) {
    await teardown(handle).catch(() => {});
    throw err;
  }
  console.log('[harness] Server ready (setup marked complete).\n');

  writeFileSync(
    HARNESS_FILE,
    JSON.stringify(
      {
        url,
        dbPath,
        mockUrl: serverFacingMockUrl,
        serverPid: handle.child?.pid,
        containerId: handle.containerId,
      },
      null,
      2,
    ),
  );

  return handle;
}

function spawnNativeServer(opts: {
  port: number;
  dbPath: string;
  uploadsDir: string;
  mockUrl: string;
  dbDir: string;
}): ChildProcess {
  console.log(`[harness] Spawning Rust GraphQL server on :${opts.port}…`);
  // The Rust server writes uploads relative to its cwd (default
  // `../app/public/uploads`), so run it from packages/server to match.
  const child = spawn(SERVER_BIN, [], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      SQLITE_DB_PATH: opts.dbPath,
      GRAPHQL_PORT: String(opts.port),
      ANTHROPIC_BASE_URL: opts.mockUrl,
      AI_API_KEY: 'test-key-anthropic-mock',
      ENABLE_IMAGE_PROCESSING: 'false',
      UPLOADS_DIR: opts.uploadsDir,
      RUST_LOG: process.env.RUST_LOG ?? 'warn',
      // /api/* routes added in the SPA-embed port. Deterministic test
      // values for the keys settings-read masks; isolated paths for the
      // overrides + cache so each run starts clean.
      RECIPE_API_KEY: 'rapi_test_secret_12345_long_enough_to_mask',
      PIXABAY_API_KEY: 'pixabay_test_secret_67890_long_enough',
      OVERRIDES_PATH: join(opts.dbDir, '.settings-overrides.json'),
      CACHE_DIR: join(opts.dbDir, '.cache'),
      OFF_BASE_URL: opts.mockUrl,
      WIKIBOOKS_BASE_URL: opts.mockUrl,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildLogs(child);
  child.on('exit', (code, signal) => {
    if (code != null && code !== 0 && code !== 143) {
      console.error(`[harness] Server exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });
  return child;
}

async function spawnContainer(opts: {
  port: number;
  dbDir: string;
  uploadsDir: string;
  mockUrl: string;
}): Promise<string> {
  // `--add-host host.docker.internal:host-gateway` makes the host reachable
  // from inside the container on both Docker Desktop (where the name
  // pre-exists) and Linux native Docker (where it doesn't).
  const args: string[] = ['run', '-d', '--rm'];
  if (SERVER_PLATFORM) args.push('--platform', SERVER_PLATFORM);
  args.push(
    '--add-host', 'host.docker.internal:host-gateway',
    '-p', `127.0.0.1:${opts.port}:4001`,
    '-v', `${opts.dbDir}:/data`,
    '-v', `${opts.uploadsDir}:/uploads`,
    '-e', 'SQLITE_DB_PATH=/data/pantry.db',
    '-e', 'GRAPHQL_PORT=4001',
    '-e', 'UPLOADS_DIR=/uploads',
    '-e', `ANTHROPIC_BASE_URL=${opts.mockUrl}`,
    '-e', 'AI_API_KEY=test-key-anthropic-mock',
    '-e', 'ENABLE_IMAGE_PROCESSING=false',
    '-e', `RUST_LOG=${process.env.RUST_LOG ?? 'warn'}`,
    // /api/* route env (mirror spawnNativeServer). OVERRIDES_PATH +
    // CACHE_DIR live under /data so they share the bind-mount lifetime.
    '-e', 'RECIPE_API_KEY=rapi_test_secret_12345_long_enough_to_mask',
    '-e', 'PIXABAY_API_KEY=pixabay_test_secret_67890_long_enough',
    '-e', 'OVERRIDES_PATH=/data/.settings-overrides.json',
    '-e', 'CACHE_DIR=/data/.cache',
    '-e', `OFF_BASE_URL=${opts.mockUrl}`,
    '-e', `WIKIBOOKS_BASE_URL=${opts.mockUrl}`,
    SERVER_IMAGE,
  );

  console.log(`[harness] docker ${args.join(' ')}`);
  const r = spawnSync('docker', args, { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`docker run failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  const containerId = r.stdout.trim();
  console.log(`[harness] Container started: ${containerId.slice(0, 12)}`);

  // Stream container logs to stderr with a [server] prefix so failures are debuggable.
  const logTail = spawn('docker', ['logs', '-f', containerId], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  pipeChildLogs(logTail);

  return containerId;
}

function pipeChildLogs(child: ChildProcess): void {
  const prefix = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) process.stderr.write(`[server] ${line}\n`);
    }
  };
  child.stdout?.on('data', prefix);
  child.stderr?.on('data', prefix);
}

async function teardown(h: Handle): Promise<void> {
  if (h.containerId) {
    spawnSync('docker', ['kill', h.containerId], { stdio: 'ignore' });
  }
  if (h.child && !h.child.killed) {
    h.child.kill('SIGTERM');
    await sleep(300);
    if (!h.child.killed) h.child.kill('SIGKILL');
  }
  await h.mock.stop().catch((err) => console.error('[harness] mock stop failed:', err));
  try {
    unlinkSync(HARNESS_FILE);
  } catch { /* gone already */ }
  rmSync(h.dbDir, { recursive: true, force: true });
}

function discoverTestFiles(): string[] {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join(HERE, f))
    .sort();
}

async function main(): Promise<void> {
  const handle = await setup();
  let failed = 0;

  try {
    const stream = run({
      files: discoverTestFiles(),
      concurrency: false,
    });

    stream.on('test:fail', (event) => {
      if (event.data.details?.error) failed++;
    });

    const reporter = stream.compose(spec);
    reporter.pipe(process.stdout);
    await once(reporter, 'end');
  } finally {
    await teardown(handle);
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
