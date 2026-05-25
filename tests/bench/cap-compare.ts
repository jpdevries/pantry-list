/**
 * Compare Rust server with and without MAX_BLOCKING_THREADS=4 (= pool.max_size).
 * Same load shape as run.ts so the numbers are directly comparable.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const REPO_ROOT = join(import.meta.dirname, '..', '..');
const SERVER_DIR = join(REPO_ROOT, 'packages', 'server');
const RUST_BIN = join(SERVER_DIR, 'target', 'release', 'pantry-server');

const LOAD_DURATION_MS = 5_000;
const CONCURRENCY = 32;
const WARMUP_REQUESTS = 100;

const QUERIES = {
  simple: `query { recipes { id title } }`,
  nested: `query {
    recipes {
      id title tags
      ingredients { ingredientName quantity unit }
      requiredCookware { id name }
    }
  }`,
};

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
async function waitForReady(url: string): Promise<number> {
  const start = performance.now();
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${url}/graphql`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (r.ok) { await r.text(); return performance.now() - start; }
    } catch {}
    await sleep(25);
  }
  throw new Error('server never ready');
}
function rssKb(pid: number): number {
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)]);
  return parseInt(r.stdout?.toString().trim() ?? '0', 10) || 0;
}
function seedDb(dbPath: string): void {
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
    for (let i = 0; i < 50; i++) {
      const id = crypto.randomUUID();
      insertRec.run(id, `R ${i}`, `r-${i}`);
      for (let j = 0; j < 8; j++) insertRecIng.run(crypto.randomUUID(), id, `Ing ${j}`, j);
    }
    db.exec('COMMIT');
  } finally { db.close(); }
}

interface Result {
  rps: number;
  mean: number; p50: number; p95: number; p99: number;
}
async function runLoad(url: string, query: string): Promise<Result> {
  const lat: number[] = [];
  let ok = 0;
  const deadline = performance.now() + LOAD_DURATION_MS;
  const worker = async () => {
    while (performance.now() < deadline) {
      const t0 = performance.now();
      try {
        const r = await fetch(`${url}/graphql`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ query }),
        });
        if (r.ok) { await r.text(); ok++; }
      } catch {}
      lat.push(performance.now() - t0);
    }
  };
  const start = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = performance.now() - start;
  lat.sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
  return {
    rps: (ok / elapsed) * 1000,
    mean: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length),
    p50: pct(0.5), p95: pct(0.95), p99: pct(0.99),
  };
}

async function bench(label: string, env: Record<string, string>, dbPath: string) {
  const port = await getFreePort();
  const child = spawn(RUST_BIN, [], {
    cwd: SERVER_DIR,
    env: { ...process.env, SQLITE_DB_PATH: dbPath, GRAPHQL_PORT: String(port), RUST_LOG: 'warn', ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[${label}] ${b}`));
  try {
    const url = `http://127.0.0.1:${port}`;
    const startup = await waitForReady(url);
    await sleep(500);
    const idle = rssKb(child.pid!);
    // Warmup
    for (let i = 0; i < WARMUP_REQUESTS; i++) {
      await fetch(`${url}/graphql`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERIES.simple }),
      }).then((r) => r.text());
    }
    let peak = idle;
    const iv = setInterval(() => { const cur = rssKb(child.pid!); if (cur > peak) peak = cur; }, 50);
    const simple = await runLoad(url, QUERIES.simple);
    const nested = await runLoad(url, QUERIES.nested);
    clearInterval(iv);
    return { label, startup, idle, peak, simple, nested };
  } finally {
    child.kill('SIGTERM'); await sleep(300);
  }
}

async function main() {
  if (!existsSync(RUST_BIN)) { console.error('build release first'); process.exit(2); }
  const dbDir = mkdtempSync(join(tmpdir(), 'pantry-cap-'));
  const dbPath = join(dbDir, 'p.db');
  // schema bootstrap
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
  seedDb(dbPath);

  const a = await bench('uncapped', {}, dbPath);
  const b = await bench('cap=4', { MAX_BLOCKING_THREADS: '4' }, dbPath);

  const fmt = (k: number) => k >= 1024 ? `${(k/1024).toFixed(1)} MiB` : `${k} KiB`;
  const ms = (n: number) => `${n.toFixed(1)} ms`;
  const top = '┌──────────────────────┬────────────────┬────────────────┬──────────┐';
  const bot = '└──────────────────────┴────────────────┴────────────────┴──────────┘';
  const row = (l: string, x: string, y: string, ratio = '') =>
    console.log(`│ ${l.padEnd(20)} │ ${x.padEnd(14)} │ ${y.padEnd(14)} │ ${ratio.padEnd(8)} │`);
  const ratio = (av: number, bv: number) => av > 0 && bv > 0 ? `${(bv/av).toFixed(2)}×` : '';

  console.log('\nFootprint');
  console.log(top);
  row('Metric', 'uncapped', 'cap=4', 'cap÷unc');
  console.log('├──────────────────────┼────────────────┼────────────────┼──────────┤');
  row('startup', ms(a.startup), ms(b.startup), ratio(a.startup, b.startup));
  row('idle RSS', fmt(a.idle), fmt(b.idle), ratio(a.idle, b.idle));
  row('peak RSS under load', fmt(a.peak), fmt(b.peak), ratio(a.peak, b.peak));
  console.log(bot);

  for (const q of ['simple', 'nested'] as const) {
    console.log(`\nLoad: ${q} (${CONCURRENCY} workers × ${LOAD_DURATION_MS/1000}s)`);
    console.log(top);
    row('Metric', 'uncapped', 'cap=4', 'cap÷unc');
    console.log('├──────────────────────┼────────────────┼────────────────┼──────────┤');
    row('throughput req/s', a[q].rps.toFixed(0), b[q].rps.toFixed(0), ratio(a[q].rps, b[q].rps));
    row('mean latency', ms(a[q].mean), ms(b[q].mean), ratio(a[q].mean, b[q].mean));
    row('p50', ms(a[q].p50), ms(b[q].p50), ratio(a[q].p50, b[q].p50));
    row('p95', ms(a[q].p95), ms(b[q].p95), ratio(a[q].p95, b[q].p95));
    row('p99', ms(a[q].p99), ms(b[q].p99), ratio(a[q].p99, b[q].p99));
    console.log(bot);
  }
  rmSync(dbDir, { recursive: true, force: true });
}

main().catch((e) => { console.error(e); process.exit(1); });
