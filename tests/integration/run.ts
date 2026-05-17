import { spawn, type ChildProcess } from 'node:child_process';
import { writeFileSync, unlinkSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
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
const HARNESS_FILE = join(HERE, '__harness__.json');

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

async function waitForServer(url: string, deadlineMs = 30_000): Promise<void> {
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

interface Handle {
  dbDir: string;
  mock: MockServer;
  child: ChildProcess;
}

async function setup(): Promise<Handle> {
  const dbDir = mkdtempSync(join(tmpdir(), 'pantry-host-integration-'));
  const dbPath = join(dbDir, 'pantry.db');
  console.log(`\n[harness] SQLite database: ${dbPath}`);

  console.log('[harness] Starting mock HTTP server…');
  const mock = await startMockServer();
  console.log(`[harness] Mock server ready: ${mock.url}`);

  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  console.log(`[harness] Spawning GraphQL server on :${port}…`);
  // tsx (not bare node) — server has `.js` extension imports node strip-types won't rewrite.
  const child = spawn('npx', ['tsx', 'graphql-server.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      SQLITE_DB_PATH: dbPath,
      GRAPHQL_PORT: String(port),
      ANTHROPIC_BASE_URL: mock.url,
      AI_API_KEY: 'test-key-anthropic-mock',
      ENABLE_IMAGE_PROCESSING: 'false',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const prefix = (chunk: Buffer) => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) process.stderr.write(`[server] ${line}\n`);
    }
  };
  child.stdout?.on('data', prefix);
  child.stderr?.on('data', prefix);
  child.on('exit', (code, signal) => {
    // 143 = SIGTERM (expected on teardown).
    if (code != null && code !== 0 && code !== 143) {
      console.error(`[harness] Server exited unexpectedly (code=${code}, signal=${signal})`);
    }
  });

  try {
    await waitForServer(url);
  } catch (err) {
    child.kill('SIGTERM');
    await mock.stop().catch(() => {});
    rmSync(dbDir, { recursive: true, force: true });
    throw err;
  }
  console.log('[harness] Server ready.\n');

  writeFileSync(
    HARNESS_FILE,
    JSON.stringify(
      {
        url,
        dbPath,
        mockUrl: mock.url,
        serverPid: child.pid,
      },
      null,
      2,
    ),
  );

  return { dbDir, mock, child };
}

async function teardown(h: Handle): Promise<void> {
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
