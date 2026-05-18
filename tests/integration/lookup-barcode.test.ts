import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { harness } from './helpers/harness.ts';

interface ProductMeta {
  code?: string;
  brands?: string;
  categories_tags?: string[];
  ingredients_text?: string;
  allergens_tags?: string[];
  nutriments?: Record<string, number>;
  nutriscore_grade?: string;
  nova_group?: number;
  main_category?: string;
  pnns_groups_1?: string;
  pnns_groups_2?: string;
  serving_size?: string;
  serving_quantity?: number;
}

interface BarcodeResult {
  name: string;
  brand?: string;
  category: string;
  quantity?: number;
  unit: string;
  itemSize?: number;
  itemSizeUnit?: string;
  barcode: string;
  meta?: ProductMeta;
}

async function lookup(code: string): Promise<{ status: number; body: BarcodeResult | { error: string } }> {
  const { url } = harness();
  const r = await fetch(
    `${url}/api/lookup-barcode?code=${encodeURIComponent(code)}`,
  );
  return { status: r.status, body: (await r.json()) as BarcodeResult | { error: string } };
}

describe('GET /api/lookup-barcode (Open Food Facts proxy)', () => {
  it('returns Pantry-Host shape for a known mocked product', async () => {
    const { status, body } = await lookup('3017624010701');
    assert.equal(status, 200);
    const ok = body as BarcodeResult;
    assert.equal(ok.name, 'Mock Nutella');
    assert.equal(ok.brand, 'MockFerrero', 'first brand only — comma-list collapsed');
    assert.equal(ok.barcode, '3017624010701');
    // 400 g → metric→imperial converts to ~14 oz, then promoted to per-item-size.
    assert.equal(ok.quantity, 1);
    assert.equal(ok.unit, 'whole');
    assert.equal(ok.itemSize, 14, 'should round to nearest 0.5 oz');
    assert.equal(ok.itemSizeUnit, 'oz');
  });

  it('maps OFF categories to a Pantry-Host category', async () => {
    const { body } = await lookup('3017624010701');
    const ok = body as BarcodeResult;
    // categories include "cocoa-and-hazelnuts-spreads" — the mapper picks
    // "nuts & seeds" first (it matches "nut" before any other tier).
    assert.equal(ok.category, 'nuts & seeds');
  });

  it('returns 404 when OFF reports status:0 (product not found)', async () => {
    const { status, body } = await lookup('0000000000000');
    assert.equal(status, 404);
    assert.match((body as { error: string }).error, /not found/i);
  });

  it('allowlists ProductMeta — drops non-100g/-serving nutriments and unknown OFF fields', async () => {
    const { body } = await lookup('3017624010701');
    const meta = (body as BarcodeResult).meta!;
    assert.ok(meta, 'meta should be present');
    // Allowlisted keys present:
    assert.equal(meta.code, '3017624010701');
    assert.equal(meta.brands, 'MockFerrero');
    assert.equal(meta.nutriscore_grade, 'e');
    assert.equal(meta.nova_group, 4);
    assert.equal(meta.serving_size, '15 g');
    assert.equal(meta.serving_quantity, 15);
    assert.deepEqual(meta.allergens_tags, ['en:milk', 'en:nuts', 'en:soybeans']);
    assert.ok(meta.nutriments, 'nutriments object survives');
    assert.equal(meta.nutriments!['energy-kcal_100g'], 539);
    assert.equal(meta.nutriments!['fat_100g'], 30.9);
    // Non-suffixed nutriment keys are stripped by trim_nutriments:
    assert.equal(
      meta.nutriments!['energy-kcal_unit'],
      undefined,
      'plain unit string should not survive the nutriment allowlist',
    );
  });

  it('400 when ?code is missing', async () => {
    const { url } = harness();
    const r = await fetch(`${url}/api/lookup-barcode`);
    assert.equal(r.status, 400);
    const body = (await r.json()) as { error: string };
    assert.match(body.error, /code is required/);
  });
});
