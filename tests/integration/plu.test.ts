import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { harness } from './helpers/harness.ts';

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const { url } = harness();
  const r = await fetch(`${url}${path}`);
  return { status: r.status, body: (await r.json()) as T };
}

interface PluCandidate {
  plu: string;
  category: string;
  commodity: string;
  variety?: string;
  size?: string;
  aka?: string;
  botanical?: string;
  organic: boolean;
  confidence: 'exact' | 'partial';
}

interface NameResults {
  results: Array<{ query: string; candidates: PluCandidate[] }>;
}

describe('GET /api/plu (IFPS lookup)', () => {
  it('?code=4011 returns the Banana record', async () => {
    const { status, body } = await getJson<{
      code: string;
      record: { commodity: string; category: string; plu: string };
      organic: boolean;
    }>('/api/plu?code=4011');
    assert.equal(status, 200);
    assert.equal(body.code, '4011');
    assert.equal(body.organic, false);
    assert.equal(body.record.commodity, 'Bananas');
    assert.equal(body.record.category, 'Fruits');
    assert.equal(body.record.plu, '4011');
  });

  it('?code=94011 (organic prefix) returns the same record with organic:true', async () => {
    const { status, body } = await getJson<{
      code: string;
      record: { commodity: string; plu: string };
      organic: boolean;
    }>('/api/plu?code=94011');
    assert.equal(status, 200);
    assert.equal(body.organic, true);
    assert.equal(body.record.commodity, 'Bananas');
    assert.equal(body.record.plu, '4011', 'record carries the 4-digit base, not the 9-prefixed form');
  });

  it('?code with non-PLU digits → 400', async () => {
    const { status, body } = await getJson<{ error: string }>('/api/plu?code=99');
    assert.equal(status, 400);
    assert.match(body.error, /4- or 5-digit/);
  });

  it('?code=49999 (out of range) → 400', async () => {
    const { status } = await getJson('/api/plu?code=49999');
    assert.equal(status, 400);
  });

  it('?name=banana returns Bananas (Cavendish) as top candidate', async () => {
    const { status, body } = await getJson<NameResults>('/api/plu?name=banana');
    assert.equal(status, 200);
    assert.equal(body.results.length, 1);
    assert.equal(body.results[0].query, 'banana');
    const candidates = body.results[0].candidates;
    assert.ok(candidates.length > 0, 'banana should yield at least one candidate');
    const top = candidates[0];
    assert.equal(top.plu, '4011');
    assert.equal(top.commodity, 'Bananas');
    assert.equal(top.organic, false);
    assert.equal(top.confidence, 'exact');
  });

  it('?name=organic+banana flips every candidate to organic with 9-prefixed PLU', async () => {
    const { status, body } = await getJson<NameResults>(
      '/api/plu?name=organic%20banana',
    );
    assert.equal(status, 200);
    const candidates = body.results[0].candidates;
    assert.ok(candidates.length > 0);
    assert.equal(candidates[0].organic, true);
    assert.equal(candidates[0].plu, '94011');
    for (const c of candidates) {
      assert.equal(c.organic, true);
      assert.match(c.plu, /^9\d{4}$/, `${c.plu} should be 9-prefixed`);
    }
  });

  it('comma-batch ?name=apple,kiwi returns one result entry per query', async () => {
    const { status, body } = await getJson<NameResults>(
      '/api/plu?name=apple,kiwi',
    );
    assert.equal(status, 200);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].query, 'apple');
    assert.equal(body.results[1].query, 'kiwi');
    assert.ok(body.results[0].candidates.length > 0, 'apple should yield candidates');
    assert.ok(body.results[1].candidates.length > 0, 'kiwi should yield candidates');
  });

  it('repeated ?name=a&name=b also returns one entry per query', async () => {
    const { status, body } = await getJson<NameResults>(
      '/api/plu?name=apple&name=kiwi',
    );
    assert.equal(status, 200);
    assert.equal(body.results.length, 2);
    assert.equal(body.results[0].query, 'apple');
    assert.equal(body.results[1].query, 'kiwi');
  });

  it('neither name nor code → 400', async () => {
    const { status, body } = await getJson<{ error: string }>('/api/plu');
    assert.equal(status, 400);
    assert.match(body.error, /name or code/i);
  });

  it('long-cache header lets the SW cache the static dataset', async () => {
    const { url } = harness();
    const r = await fetch(`${url}/api/plu?code=4011`);
    assert.match(String(r.headers.get('cache-control') ?? ''), /max-age=86400/);
  });
});
