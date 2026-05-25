/**
 * Head-to-head bench: Rust (packages/server release binary) vs
 * Node + tsx (packages/app/graphql-server.ts).
 *
 * Measures, for each:
 *  - startup latency (spawn → first 200 OK on /graphql)
 *  - resident set size at idle (after seeding + 1s settle)
 *  - throughput: N concurrent workers × T seconds of a small GraphQL query
 *  - RSS sampled during load (peak across 4 samples)
 *  - mean / p50 / p95 / p99 latencies
 *
 * Same SQLite file is reused across both runs so I/O work is identical.
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
const APP_DIR = join(REPO_ROOT, 'packages', 'app');
const RUST_BIN = join(SERVER_DIR, 'target', 'release', 'pantry-server');

const SEEDS = {
  ingredients: 200,
  recipes: 50,
  ingredientsPerRecipe: 8,
};
const LOAD_DURATION_MS = 5_000;
const CONCURRENCY = 32;
const WARMUP_REQUESTS = 100;

const QUERIES = {
  simple: `query { recipes { id title } }`,
  // Exercises nested resolvers + sub-recipe expansion (the N+1-prone path).
  nested: `query {
    recipes {
      id title tags
      ingredients { ingredientName quantity unit }
      requiredCookware { id name }
    }
  }`,
};

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

function seedDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN');
    const insertIng = db.prepare(
      `INSERT INTO ingredients (id, name, tags, kitchen_id)
       VALUES (?, ?, ?, (SELECT id FROM kitchens WHERE slug='home'))`,
    );
    const ingIds: string[] = [];
    for (let i = 0; i < SEEDS.ingredients; i++) {
      const id = crypto.randomUUID();
      ingIds.push(id);
      const tags = JSON.stringify(i % 3 === 0 ? ['pantry'] : ['fridge']);
      insertIng.run(id, `Ingredient ${i}`, tags);
    }

    const insertRec = db.prepare(
      `INSERT INTO recipes (id, title, slug, instructions, source, kitchen_id, tags)
       VALUES (?, ?, ?, ?, 'manual',
               (SELECT id FROM kitchens WHERE slug='home'),
               '["bench"]')`,
    );
    const insertRecIng = db.prepare(
      `INSERT INTO recipe_ingredients (id, recipe_id, ingredient_name, quantity, unit, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < SEEDS.recipes; i++) {
      const id = crypto.randomUUID();
      const slug = `bench-recipe-${i}`;
      insertRec.run(id, `Bench Recipe ${i}`, slug, `1. Step.\n2. Done.`);
      for (let j = 0; j < SEEDS.ingredientsPerRecipe; j++) {
        insertRecIng.run(
          crypto.randomUUID(),
          id,
          `Ingredient ${(i * 7 + j) % SEEDS.ingredients}`,
          1.0,
          'cup',
          j,
        );
      }
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

async function waitForReady(url: string, deadlineMs = 10_000): Promise<number> {
  const start = performance.now();
  while (performance.now() - start < deadlineMs) {
    try {
      const r = await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: '{ __typename }' }),
      });
      if (r.ok) {
        await r.text();
        return performance.now() - start;
      }
    } catch { /* not up yet */ }
    await sleep(25);
  }
  throw new Error(`Server did not become ready at ${url}`);
}

function rssKb(pid: number): number {
  const r = spawnSync('ps', ['-o', 'rss=', '-p', String(pid)]);
  const out = r.stdout?.toString().trim();
  return out ? parseInt(out, 10) : 0;
}

interface LoadResult {
  total: number;
  ok: number;
  durationMs: number;
  rps: number;
  latencyMean: number;
  latencyP50: number;
  latencyP95: number;
  latencyP99: number;
}

async function loadWorker(
  url: string,
  query: string,
  deadline: number,
  out: { ok: number; bad: number; latencies: number[] },
): Promise<void> {
  while (performance.now() < deadline) {
    const t0 = performance.now();
    try {
      const r = await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query }),
      });
      if (r.ok) {
        await r.text();
        out.ok++;
      } else {
        await r.text();
        out.bad++;
      }
    } catch {
      out.bad++;
    }
    out.latencies.push(performance.now() - t0);
  }
}

async function runLoadNoWarmup(url: string, query: string): Promise<LoadResult> {
  const out = { ok: 0, bad: 0, latencies: [] as number[] };
  const start = performance.now();
  const deadline = start + LOAD_DURATION_MS;
  const workers = Array.from({ length: CONCURRENCY }, () =>
    loadWorker(url, query, deadline, out),
  );
  await Promise.all(workers);
  const elapsed = performance.now() - start;
  const lat = out.latencies.slice().sort((a, b) => a - b);
  const pct = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] ?? 0;
  const total = out.ok + out.bad;
  return {
    total,
    ok: out.ok,
    durationMs: elapsed,
    rps: (out.ok / elapsed) * 1000,
    latencyMean: lat.reduce((a, b) => a + b, 0) / Math.max(1, lat.length),
    latencyP50: pct(0.5),
    latencyP95: pct(0.95),
    latencyP99: pct(0.99),
  };
}

interface RunReport {
  label: string;
  binarySizeKb: number;
  startupMs: number;
  postReadyRssKb: number;
  postWarmupRssKb: number;
  peakRssKb: number;
  postLoadRssKb: number;
  loads: Record<string, LoadResult>;
}

async function bench(
  label: string,
  binarySizeKb: number,
  spawnServer: (env: Record<string, string>) => ChildProcess,
  port: number,
  dbPath: string,
): Promise<RunReport> {
  const url = `http://127.0.0.1:${port}`;
  const child = spawnServer({
    SQLITE_DB_PATH: dbPath,
    GRAPHQL_PORT: String(port),
    ENABLE_IMAGE_PROCESSING: 'false',
    RUST_LOG: 'warn',
    NODE_ENV: 'production',
  });
  child.on('exit', (code) => {
    if (code != null && code !== 0 && code !== 143) {
      console.error(`[${label}] server exited unexpectedly: ${code}`);
    }
  });
  // Pipe stderr so unexpected errors surface, but don't drown the report.
  child.stderr?.on('data', (b: Buffer) => process.stderr.write(`[${label}] ${b}`));

  let startupMs = 0;
  try {
    startupMs = await waitForReady(url);
    // Sample immediately after ready, BEFORE any traffic.
    await sleep(500);
    const postReadyRssKb = rssKb(child.pid!);

    // Warmup explicitly outside runLoad so we can isolate its memory effect.
    for (let i = 0; i < WARMUP_REQUESTS; i++) {
      await fetch(`${url}/graphql`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ query: QUERIES.simple }),
      }).then((r) => r.text());
    }
    await sleep(200);
    const postWarmupRssKb = rssKb(child.pid!);

    let peakRssKb = postWarmupRssKb;
    const samplerInterval = setInterval(() => {
      const cur = rssKb(child.pid!);
      if (cur > peakRssKb) peakRssKb = cur;
    }, 50);

    const loads: Record<string, LoadResult> = {};
    for (const [name, query] of Object.entries(QUERIES)) {
      loads[name] = await runLoadNoWarmup(url, query);
    }
    clearInterval(samplerInterval);
    await sleep(500);
    const postLoadRssKb = rssKb(child.pid!);

    return {
      label,
      binarySizeKb,
      startupMs,
      postReadyRssKb,
      postWarmupRssKb,
      peakRssKb,
      postLoadRssKb,
      loads,
    };
  } finally {
    child.kill('SIGTERM');
    await sleep(300);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

function fmtKb(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MiB`;
  return `${kb} KiB`;
}
function fmtMs(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

function statSizeKb(path: string): number {
  const r = spawnSync('stat', ['-f', '%z', path]);
  return Math.round(parseInt(r.stdout.toString().trim(), 10) / 1024);
}

async function main(): Promise<void> {
  if (!existsSync(RUST_BIN)) {
    console.error(`Missing release binary: ${RUST_BIN}\nRun: cargo build --release`);
    process.exit(2);
  }

  const dbDir = mkdtempSync(join(tmpdir(), 'pantry-bench-'));
  const dbPath = join(dbDir, 'pantry.db');
  console.log(`[bench] DB: ${dbPath}`);

  // Boot the Rust server once briefly to let it apply the schema.
  {
    const port = await getFreePort();
    const child = spawn(RUST_BIN, [], {
      cwd: SERVER_DIR,
      env: {
        ...process.env,
        SQLITE_DB_PATH: dbPath,
        GRAPHQL_PORT: String(port),
        RUST_LOG: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    await waitForReady(`http://127.0.0.1:${port}`).catch(() => {});
    child.kill('SIGTERM');
    await sleep(300);
  }

  console.log(`[bench] Seeding ${SEEDS.recipes} recipes × ${SEEDS.ingredientsPerRecipe} ings…`);
  seedDb(dbPath);

  try {
    const reports: RunReport[] = [];

    // ─── Rust ────────────────────────────────────────────────────────────
    {
      const port = await getFreePort();
      const sz = statSizeKb(RUST_BIN);
      const r = await bench(
        'rust',
        sz,
        (env) =>
          spawn(RUST_BIN, [], {
            cwd: SERVER_DIR,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        port,
        dbPath,
      );
      reports.push(r);
    }

    // ─── Node ────────────────────────────────────────────────────────────
    {
      const port = await getFreePort();
      // Node binary size is not the deployment artifact; report the
      // graphql-server.ts source LOC closure roughly via du of immediate
      // runtime deps. We'll just report the entry-script size for now.
      const sz = statSizeKb(join(APP_DIR, 'graphql-server.ts'));
      const r = await bench(
        'node',
        sz,
        (env) =>
          spawn('npx', ['tsx', 'graphql-server.ts'], {
            cwd: APP_DIR,
            env: { ...process.env, ...env },
            stdio: ['ignore', 'pipe', 'pipe'],
          }),
        port,
        dbPath,
      );
      reports.push(r);
    }

    const [r, n] = reports;
    const sep = '┼────────────────────────┼──────────────────┼──────────────────┼──────────────';
    const top = '┌────────────────────────┬──────────────────┬──────────────────┬──────────────┐';
    const bot = '└────────────────────────┴──────────────────┴──────────────────┴──────────────┘';
    const row = (label: string, a: string, b: string, ratio = '') =>
      console.log(
        `│ ${label.padEnd(22)} │ ${a.padEnd(16)} │ ${b.padEnd(16)} │ ${ratio.padEnd(12)} │`,
      );
    const speedup = (rv: number, nv: number) =>
      rv > 0 && nv > 0 ? `${(rv / nv).toFixed(2)}× ${rv > nv ? 'better' : 'worse'}` : '';

    console.log('\nFootprint & startup');
    console.log(top);
    row('Metric', 'Rust', 'Node', 'Rust:Node');
    console.log(sep.replace(/┼/g, '├').replace(/┼([^┼]*)$/, '┤$1').replace(/^├/, '├'));
    row('binary / entry size', fmtKb(r.binarySizeKb), fmtKb(n.binarySizeKb) + ' (src)', '');
    row('startup (ready)', fmtMs(r.startupMs), fmtMs(n.startupMs), speedup(n.startupMs, r.startupMs));
    row('RSS @ ready', fmtKb(r.postReadyRssKb), fmtKb(n.postReadyRssKb), speedup(n.postReadyRssKb, r.postReadyRssKb));
    row('RSS @ post-warmup', fmtKb(r.postWarmupRssKb), fmtKb(n.postWarmupRssKb), speedup(n.postWarmupRssKb, r.postWarmupRssKb));
    row('RSS @ peak (load)', fmtKb(r.peakRssKb), fmtKb(n.peakRssKb), speedup(n.peakRssKb, r.peakRssKb));
    row('RSS @ post-load', fmtKb(r.postLoadRssKb), fmtKb(n.postLoadRssKb), speedup(n.postLoadRssKb, r.postLoadRssKb));
    console.log(bot);

    for (const name of Object.keys(QUERIES)) {
      const rl = r.loads[name];
      const nl = n.loads[name];
      console.log(`\nLoad: ${name} (${CONCURRENCY} workers × ${LOAD_DURATION_MS / 1000}s)`);
      console.log(top);
      row('Metric', 'Rust', 'Node', 'Rust:Node');
      console.log(sep.replace(/┼/g, '├').replace(/┼([^┼]*)$/, '┤$1').replace(/^├/, '├'));
      row('requests OK', String(rl.ok), String(nl.ok), speedup(rl.ok, nl.ok));
      row('throughput req/s', rl.rps.toFixed(0), nl.rps.toFixed(0), speedup(rl.rps, nl.rps));
      row('latency mean', fmtMs(rl.latencyMean), fmtMs(nl.latencyMean), speedup(nl.latencyMean, rl.latencyMean));
      row('latency p50', fmtMs(rl.latencyP50), fmtMs(nl.latencyP50), speedup(nl.latencyP50, rl.latencyP50));
      row('latency p95', fmtMs(rl.latencyP95), fmtMs(nl.latencyP95), speedup(nl.latencyP95, rl.latencyP95));
      row('latency p99', fmtMs(rl.latencyP99), fmtMs(nl.latencyP99), speedup(nl.latencyP99, rl.latencyP99));
      console.log(bot);
    }
    console.log(`\nDataset: ${SEEDS.recipes} recipes, ${SEEDS.ingredients} ingredients`);
    console.log(`Queries:`);
    for (const [k, v] of Object.entries(QUERIES)) {
      console.log(`  ${k}: ${v.replace(/\s+/g, ' ').trim()}`);
    }
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
