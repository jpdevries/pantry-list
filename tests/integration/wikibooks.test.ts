import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { harness } from './helpers/harness.ts';

interface WikibooksEntry {
  slug: string;
  title: string;
  tags: string[];
  servings: number | null;
  time: string | null;
  difficulty: number | null;
  sourceUrl: string;
  ingredients: string[];
  instructions: string;
}

interface WikibooksResponse {
  total: number;
  offset: number;
  limit: number;
  results: WikibooksEntry[];
}

async function get(path: string): Promise<{ status: number; body: WikibooksResponse }> {
  const { url } = harness();
  const r = await fetch(`${url}${path}`);
  return { status: r.status, body: (await r.json()) as WikibooksResponse };
}

describe('GET /api/wikibooks (HF dataset proxy)', () => {
  it('first request downloads from mock HF and normalizes rows', async () => {
    const { status, body } = await get('/api/wikibooks?limit=10');
    assert.equal(status, 200);
    assert.equal(body.total, 3, 'mock dataset has 3 entries');
    assert.equal(body.results.length, 3);
    // Slug + tags normalization, derived from infobox.category.
    const macAndCheese = body.results.find((r) => r.title === 'Mock Mac and Cheese');
    assert.ok(macAndCheese, 'mac and cheese entry present');
    assert.equal(macAndCheese.slug, 'mock-mac-and-cheese');
    assert.ok(macAndCheese.tags.includes('wikibooks'), 'every entry tagged wikibooks');
    assert.ok(macAndCheese.tags.includes('pasta'), 'category tag stripped of "_recipes"');
    assert.equal(macAndCheese.servings, 4, 'parseInt on infobox.servings');
    // Numbered instructions stitched together with a newline + index prefix.
    assert.equal(
      macAndCheese.instructions,
      '1. Boil macaroni\n2. Stir in cheese',
    );
    assert.deepEqual(macAndCheese.ingredients, ['200 g macaroni', '150 g cheddar']);
  });

  it('?q= filters across title, tags, and ingredients', async () => {
    // Cached from the previous test; no second HF fetch.
    const { body: pancakeHits } = await get('/api/wikibooks?q=pancake');
    assert.equal(pancakeHits.total, 1);
    assert.equal(pancakeHits.results[0].title, 'Mock Pancakes');

    // Ingredient match — "banana" only appears in the smoothie's ingredients list.
    const { body: bananaHits } = await get('/api/wikibooks?q=banana');
    assert.equal(bananaHits.total, 1);
    assert.equal(bananaHits.results[0].title, 'Mock Smoothie');

    // Tag match — "breakfast" comes from extractTags() on the Pancakes infobox.
    const { body: breakfastHits } = await get('/api/wikibooks?q=breakfast');
    assert.equal(breakfastHits.total, 1);
    assert.equal(breakfastHits.results[0].title, 'Mock Pancakes');
  });

  it('offset + limit paginate within the filtered set', async () => {
    const { body } = await get('/api/wikibooks?offset=1&limit=1');
    assert.equal(body.total, 3);
    assert.equal(body.offset, 1);
    assert.equal(body.limit, 1);
    assert.equal(body.results.length, 1);
  });

  it('limit is clamped to 100 to keep the SW cache reasonable', async () => {
    const { body } = await get('/api/wikibooks?limit=9999');
    assert.equal(body.limit, 100);
  });

  it('long-cache header allows the SW to keep results around for an hour', async () => {
    const { url } = harness();
    const r = await fetch(`${url}/api/wikibooks?limit=1`);
    assert.match(String(r.headers.get('cache-control') ?? ''), /max-age=3600/);
  });
});
