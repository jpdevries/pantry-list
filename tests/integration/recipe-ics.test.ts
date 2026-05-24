import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { harness } from './helpers/harness.ts';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

interface CreatedRecipe {
  createRecipe: { id: string; slug: string; title: string };
}

const CREATE_RECIPE = `
  mutation Create(
    $title: String!,
    $instructions: String!,
    $servings: Int,
    $prepTime: Int,
    $cookTime: Int,
    $tags: [String!],
    $ingredients: [RecipeIngredientInput!]!,
  ) {
    createRecipe(
      title: $title,
      instructions: $instructions,
      servings: $servings,
      prepTime: $prepTime,
      cookTime: $cookTime,
      tags: $tags,
      ingredients: $ingredients,
    ) { id slug title }
  }
`;

async function fetchIcs(slug: string): Promise<{ status: number; contentType: string; body: string }> {
  const { url } = harness();
  const r = await fetch(`${url}/api/recipe-ics?slug=${encodeURIComponent(slug)}`);
  return {
    status: r.status,
    contentType: r.headers.get('content-type') ?? '',
    body: await r.text(),
  };
}

describe('GET /api/recipe-ics', () => {
  before(resetDb);

  it('returns text/calendar with a well-formed VCALENDAR body', async () => {
    const data = await gql<CreatedRecipe>(CREATE_RECIPE, {
      title: 'ICS Test Pasta',
      instructions: '1. Boil water\n2. Add pasta\n3. Drain and serve',
      servings: 4,
      prepTime: 5,
      cookTime: 15,
      tags: ['dinner', 'italian'],
      ingredients: [
        { ingredientName: 'pasta', quantity: 500, unit: 'g' },
        { ingredientName: 'salt', quantity: 1, unit: 'tsp' },
      ],
    });
    const slug = data.createRecipe.slug;

    const res = await fetchIcs(slug);
    assert.equal(res.status, 200);
    assert.match(res.contentType, /text\/calendar/);
    // Structural envelope.
    assert.ok(res.body.startsWith('BEGIN:VCALENDAR'), 'starts with VCALENDAR');
    assert.ok(res.body.includes('END:VCALENDAR'), 'ends with VCALENDAR');
    assert.ok(res.body.includes('BEGIN:VEVENT'), 'has VEVENT block');
    assert.ok(res.body.includes('END:VEVENT'), 'closes VEVENT block');
    // Stable UID derived from slug.
    assert.ok(
      res.body.includes(`UID:recipe-${slug}@pantryhost.app`),
      'stable UID from slug',
    );
    // Duration = prep + cook = 20 minutes.
    assert.ok(res.body.includes('DURATION:PT20M'), 'PT20M from prep+cook');
    // X- extras carry the prep/cook/servings split.
    assert.ok(res.body.includes('X-RECIPE-PREP-TIME:5 min'));
    assert.ok(res.body.includes('X-RECIPE-COOK-TIME:15 min'));
    assert.ok(res.body.includes('X-RECIPE-SERVINGS:4'));
    // CATEGORIES from tags (comma-joined).
    assert.match(res.body, /CATEGORIES:.*dinner.*italian|italian.*dinner/);
  });

  it('embeds the instructions verbatim in the DESCRIPTION', async () => {
    const data = await gql<CreatedRecipe>(CREATE_RECIPE, {
      title: 'ICS Soup',
      instructions: '1. Simmer the broth\n2. Add noodles\n3. Garnish',
      servings: 2,
      prepTime: 0,
      cookTime: 30,
      tags: ['lunch'],
      ingredients: [{ ingredientName: 'broth', quantity: 1, unit: 'L' }],
    });
    const res = await fetchIcs(data.createRecipe.slug);
    // Description is folded into 75-byte lines, so just check the
    // un-numbered instruction text survives somewhere in the body.
    assert.ok(res.body.includes('Simmer'), 'instruction text present');
    assert.ok(res.body.includes('Add noodles'), 'instruction text present');
    assert.ok(res.body.includes('Garnish'), 'instruction text present');
  });

  it('honors the dinner default duration when prep/cook are both zero', async () => {
    const data = await gql<CreatedRecipe>(CREATE_RECIPE, {
      title: 'ICS Instant Snack',
      instructions: 'Just eat it',
      servings: 1,
      prepTime: 0,
      cookTime: 0,
      tags: [],
      ingredients: [{ ingredientName: 'chips', quantity: 1, unit: 'bag' }],
    });
    const res = await fetchIcs(data.createRecipe.slug);
    // total_minutes falls back to 30 when prep+cook == 0.
    assert.ok(res.body.includes('DURATION:PT30M'));
  });

  it('returns 404 for an unknown slug', async () => {
    const res = await fetchIcs('definitely-not-a-real-slug');
    assert.equal(res.status, 404);
    assert.match(res.body, /Recipe not found/);
  });

  it('returns 400 when slug is empty', async () => {
    const { url } = harness();
    const r = await fetch(`${url}/api/recipe-ics?slug=`);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /Missing slug/);
  });
});
