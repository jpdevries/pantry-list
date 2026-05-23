import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFileSync, readFileSync, unlinkSync, readdirSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { once } from 'node:events';
import { run } from 'node:test';
import { spec } from 'node:test/reporters';
import { Client } from 'pg';
import { startMockServer, type MockServer } from './helpers/mock-server.ts';

const HERE = import.meta.dirname;
const REPO_ROOT = join(HERE, '..', '..');
const APP_DIR = join(REPO_ROOT, 'packages', 'app');
const SCHEMA_SQL = join(APP_DIR, 'schema.sql');
const HARNESS_FILE = join(HERE, '__harness__.json');

const PG_IMAGE = 'postgres:16-alpine';
const CONTAINER_NAME = 'pantry-host-integration-pg';
const PG_USER = 'test';
const PG_PASSWORD = 'test';
const PG_DB = 'test';

const exec = promisify(execFile);

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

async function dockerAvailable(): Promise<boolean> {
  try {
    await exec('docker', ['info']);
    return true;
  } catch {
    return false;
  }
}

async function startPostgres(): Promise<{ id: string; port: number; dbUrl: string }> {
  // Best-effort: clean any leftover from a prior crashed run.
  await exec('docker', ['rm', '-f', CONTAINER_NAME]).catch(() => {});

  const { stdout: idOut } = await exec('docker', [
    'run', '-d', '--rm',
    '--name', CONTAINER_NAME,
    '-e', `POSTGRES_USER=${PG_USER}`,
    '-e', `POSTGRES_PASSWORD=${PG_PASSWORD}`,
    '-e', `POSTGRES_DB=${PG_DB}`,
    '-P',
    PG_IMAGE,
  ]);
  const id = idOut.trim();

  const { stdout: portOut } = await exec('docker', ['port', id, '5432']);
  const portMatch = portOut.match(/:(\d+)/);
  if (!portMatch) throw new Error(`Could not parse mapped Postgres port from: ${portOut}`);
  const port = parseInt(portMatch[1], 10);
  const dbUrl = `postgres://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${port}/${PG_DB}`;

  // Probe via the same path tests use — pg_isready inside the container
  // returns ready before the host port-forward is fully wired, which yields
  // ECONNRESET on the first real client connection.
  const deadline = Date.now() + 30_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    const client = new Client({ connectionString: dbUrl });
    try {
      await client.connect();
      await client.query('SELECT 1');
      await client.end();
      return { id, port, dbUrl };
    } catch (err) {
      lastErr = err;
      await client.end().catch(() => {});
      await sleep(250);
    }
  }
  throw new Error(`Postgres did not become ready within 30s: ${(lastErr as Error)?.message}`);
}

async function stopPostgres(id: string): Promise<void> {
  await exec('docker', ['stop', '-t', '0', id]).catch(() => {});
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
  containerId: string;
  mock: MockServer;
  child: ChildProcess;
}

async function setup(): Promise<Handle> {
  if (!(await dockerAvailable())) {
    console.error('\n✗ Could not reach Docker.');
    console.error('  The integration test harness provisions a Postgres container via');
    console.error('  the docker CLI. Start Docker Desktop (or `colima start`) and re-run:');
    console.error('    npm run test:integration\n');
    process.exit(1);
  }

  console.log(`\n[harness] Starting Postgres container (${PG_IMAGE})…`);
  const { id: containerId, dbUrl } = await startPostgres();
  console.log(`[harness] Postgres ready: ${dbUrl}`);

  // schema.sql's subquery DEFAULTs on kitchen_id are rejected by modern
  // Postgres. Every app INSERT supplies kitchen_id explicitly, so stripping
  // the defaults at apply-time is safe.
  console.log('[harness] Applying schema.sql…');
  const sanitized = readFileSync(SCHEMA_SQL, 'utf8').replace(
    /\s*DEFAULT\s*\(\s*SELECT[^)]*\)/gi,
    '',
  );
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query(sanitized);
    // Quiets the NOTICE chatter the server's IF NOT EXISTS re-adds emit.
    await client.query(`ALTER DATABASE "${PG_DB}" SET client_min_messages = warning`);
  } finally {
    await client.end();
  }

  console.log('[harness] Starting mock HTTP server…');
  const mock = await startMockServer();
  console.log(`[harness] Mock server ready: ${mock.url}`);

  const port = await getFreePort();
  const url = `http://127.0.0.1:${port}`;
  console.log(`[harness] Spawning GraphQL server on :${port}…`);
  const child = spawn('npx', ['tsx', 'graphql-server.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      DATABASE_URL: dbUrl,
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
    await stopPostgres(containerId);
    throw err;
  }
  console.log('[harness] Server ready.\n');

  writeFileSync(
    HARNESS_FILE,
    JSON.stringify(
      {
        url,
        dbUrl,
        mockUrl: mock.url,
        serverPid: child.pid,
        containerId,
        containerName: CONTAINER_NAME,
        dbName: PG_DB,
        dbUser: PG_USER,
      },
      null,
      2,
    ),
  );

  return { containerId, mock, child };
}

async function teardown(h: Handle): Promise<void> {
  if (h.child && !h.child.killed) {
    h.child.kill('SIGTERM');
    await sleep(300);
    if (!h.child.killed) h.child.kill('SIGKILL');
  }
  await h.mock.stop().catch((err) => console.error('[harness] mock stop failed:', err));
  await stopPostgres(h.containerId);
  try {
    unlinkSync(HARNESS_FILE);
  } catch { /* gone already */ }
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
