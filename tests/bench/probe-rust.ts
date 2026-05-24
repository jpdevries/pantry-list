/**
 * Probe: where do the Rust server's ~40 MiB of "under load" RSS come from?
 * Vary concurrency, sample RSS at steady state, hold concurrency constant
 * while varying response size, etc.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SERVER_DIR = join(REPO_ROOT, 'packages', 'server');
const RUST_BIN = join(SERVER_DIR, 'target', 'release', 'pantry-server');

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref(); srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}
async function waitForReady(url: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (r.ok) { await r.text(); return; }
    } catch {}
    await sleep(25);
  }
  throw new Error('server never ready');
}
function rssKb(pid: number): number {
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)]);
  return parseInt(r.stdout?.toString().trim() ?? '0', 10) || 0;
}
function threadCount(pid: number): number {
  const r = spawnSync('ps', ['-M', '-p', String(pid)]);
  // -M lists one line per thread; subtract header.
  return Math.max(0, r.stdout.toString().split('\n').filter(Boolean).length - 1);
}

function seedDb(dbPath: string, recipes: number, ingPerRecipe: number): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN');
    const insertIng = db.prepare(
      `INSERT INTO ingredients (id, name, tags, kitchen_id)
       VALUES (?, ?, '["pantry"]', (SELECT id FROM kitchens WHERE slug='home'))`,
    );
    for (let i = 0; i < 200; i++) insertIng.run(crypto.randomUUID(), `Ing ${i}`);
    const insertRec = db.prepare(
      `INSERT INTO recipes (id, title, slug, instructions, source, kitchen_id, tags)
       VALUES (?, ?, ?, '1. Step', 'manual',
               (SELECT id FROM kitchens WHERE slug='home'), '[]')`,
    );
    const insertRecIng = db.prepare(
      `INSERT INTO recipe_ingredients (id, recipe_id, ingredient_name, quantity, unit, sort_order)
       VALUES (?, ?, ?, 1, 'cup', ?)`,
    );
    for (let i = 0; i < recipes; i++) {
      const id = crypto.randomUUID();
      insertRec.run(id, `R ${i}`, `r-${i}`);
      for (let j = 0; j < ingPerRecipe; j++) {
        insertRecIng.run(crypto.randomUUID(), id, `Ing ${j}`, j);
      }
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

const SIMPLE = `query { recipes { id title } }`;

async function loadAtConcurrency(url: string, c: number, durMs: number): Promise<void> {
  const deadline = performance.now() + durMs;
  const worker = async () => {
    while (performance.now() < deadline) {
      await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: SIMPLE }),
      }).then((r) => r.text()).catch(() => {});
    }
  };
  await Promise.all(Array.from({ length: c }, worker));
}

async function probe() {
  const dbDir = mkdtempSync(join(tmpdir(), 'pantry-probe-'));
  const dbPath = join(dbDir, 'p.db');
  // Boot once to apply schema.
  {
    const p = await getFreePort();
    const c = spawn(RUST_BIN, [], {
      cwd: SERVER_DIR,
      env: { ...process.env, SQLITE_DB_PATH: dbPath, GRAPHQL_PORT: String(p), RUST_LOG: 'warn' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    await waitForReady(`http://127.0.0.1:${p}`).catch(() => {});
    c.kill('SIGTERM'); await sleep(300);
  }
  seedDb(dbPath, 50, 8);

  const port = await getFreePort();
  const child = spawn(RUST_BIN, [], {
    cwd: SERVER_DIR,
    env: { ...process.env, SQLITE_DB_PATH: dbPath, GRAPHQL_PORT: String(port), RUST_LOG: 'warn' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[rust] ${b}`));
  try {
    const url = `http://127.0.0.1:${port}`;
    await waitForReady(url);
    await sleep(800);

    console.log('phase\t\tRSS(MiB)\tthreads');
    const sample = (phase: string) =>
      console.log(`${phase.padEnd(16)}${(rssKb(child.pid!) / 1024).toFixed(1)}\t\t${threadCount(child.pid!)}`);

    sample('ready');
    // Ramp through concurrencies; sample after each.
    for (const c of [1, 4, 8, 16, 32, 64, 128]) {
      await loadAtConcurrency(url, c, 3000);
      await sleep(300);
      sample(`after c=${c}`);
    }
    // Hold idle for a few seconds to see if anything releases.
    await sleep(3000);
    sample('idle 3s');
    await sleep(7000);
    sample('idle 10s');
  } finally {
    child.kill('SIGTERM'); await sleep(300);
    rmSync(dbDir, { recursive: true, force: true });
  }
}

probe().catch((e) => { console.error(e); process.exit(1); });
