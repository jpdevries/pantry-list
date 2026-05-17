import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { harness } from './helpers/harness.ts';

describe('POST /fetch-recipe', () => {
  // URL passed in the request body is fetched and parsed; the mock server's
  // /recipe.html serves LD-JSON for the happy path.
  it('parses LD-JSON Recipe data from a mock page', async () => {
    const { url, mockUrl } = harness();
    const r = await fetch(`${url}/fetch-recipe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: `${mockUrl}/recipe.html` }),
    });
    assert.ok(r.ok);

    const data = (await r.json()) as {
      title: string;
      ingredients: { ingredientName: string }[];
      instructions: string;
      servings?: number;
      prepTime?: number;
      cookTime?: number;
    };
    assert.equal(data.title, 'Mock Tomato Soup');
    assert.equal(data.ingredients.length, 3);
    assert.ok(
      data.ingredients.some((i) =>
        i.ingredientName.toLowerCase().includes('tomato'),
      ),
    );
    assert.equal(data.servings, 4);
    assert.equal(data.prepTime, 5);
    assert.equal(data.cookTime, 25);
    assert.match(data.instructions, /Saute the onion/);
  });

  it('returns 502 when the target URL is unreachable', async () => {
    const { url } = harness();
    const r = await fetch(`${url}/fetch-recipe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:1/nope' }),
    });
    assert.equal(r.status, 502);
  });

  it('returns 400 when the request omits the url field', async () => {
    const { url } = harness();
    const r = await fetch(`${url}/fetch-recipe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(r.status, 400);
  });
});
