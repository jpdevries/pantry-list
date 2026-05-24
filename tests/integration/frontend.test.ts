import { describe, it, before } from 'node:test';
import { strict as assert } from 'node:assert';
import { harness } from './helpers/harness.ts';
import { gql } from './helpers/gql.ts';
import { resetDb } from './helpers/reset.ts';

interface CreatedRecipe { createRecipe: { slug: string } }
interface CreatedMenu { createMenu: { slug: string } }

async function getHtml(path: string): Promise<{ status: number; html: string; redirect: string | null }> {
  const { url } = harness();
  const r = await fetch(`${url}${path}`, { redirect: 'manual' });
  return {
    status: r.status,
    html: await r.text(),
    redirect: r.headers.get('location'),
  };
}

describe('GET /kitchens/home/* → / 308 redirect', () => {
  it('bare /kitchens/home redirects to /', async () => {
    const { status, redirect } = await getHtml('/kitchens/home');
    assert.equal(status, 308);
    assert.equal(redirect, '/');
  });

  it('trailing-slash /kitchens/home/ redirects to /', async () => {
    const { status, redirect } = await getHtml('/kitchens/home/');
    assert.equal(status, 308);
    assert.equal(redirect, '/');
  });

  it('/kitchens/home/recipes → /recipes (nested paths preserved)', async () => {
    const { status, redirect } = await getHtml('/kitchens/home/recipes');
    assert.equal(status, 308);
    assert.equal(redirect, '/recipes');
  });

  it('/kitchens/home/at/did:plc:foo/exchange.recipe.recipe/abc → /at/...', async () => {
    const { status, redirect } = await getHtml(
      '/kitchens/home/at/did:plc:foo/exchange.recipe.recipe/abc',
    );
    assert.equal(status, 308);
    assert.equal(redirect, '/at/did:plc:foo/exchange.recipe.recipe/abc');
  });

  it('preserves the query string (which the Rex middleware lost)', async () => {
    const { url } = harness();
    const r = await fetch(`${url}/kitchens/home/recipes?favorites=1`, { redirect: 'manual' });
    assert.equal(r.status, 308);
    assert.equal(r.headers.get('location'), '/recipes?favorites=1');
  });

  it('non-home kitchens are NOT redirected — /kitchens/bar/recipes renders normally', async () => {
    const { status, redirect, html } = await getHtml('/kitchens/bar/recipes');
    assert.equal(status, 200);
    assert.equal(redirect, null);
    assert.ok(html.includes('<div id="__rex"></div>'), 'served the SPA shell');
  });
});

describe('SPA shell injects OG metadata for detail pages', () => {
  let recipeSlug = '';
  let menuSlug = '';

  before(async () => {
    await resetDb();
    const r = await gql<CreatedRecipe>(
      `mutation Create(
        $title: String!,
        $description: String,
        $instructions: String!,
        $tags: [String!],
        $photoUrl: String,
        $ingredients: [RecipeIngredientInput!]!,
      ) {
        createRecipe(
          title: $title,
          description: $description,
          instructions: $instructions,
          tags: $tags,
          photoUrl: $photoUrl,
          ingredients: $ingredients,
        ) { slug }
      }`,
      {
        title: 'OG Test Casserole',
        description: 'A casserole used in integration tests',
        instructions: '1. Mix\n2. Bake',
        tags: ['dinner'],
        photoUrl: '/uploads/og-test.jpg',
        ingredients: [{ ingredientName: 'cheese', quantity: 1, unit: 'cup' }],
      },
    );
    recipeSlug = r.createRecipe.slug;

    const m = await gql<CreatedMenu>(
      `mutation CreateMenu($title: String!, $description: String, $recipes: [String!]!) {
        createMenu(title: $title, description: $description, recipes: $recipes) { slug }
      }`,
      {
        title: 'OG Test Menu',
        description: 'Menu used in integration tests',
        recipes: [],
      },
    );
    menuSlug = m.createMenu.slug;
  });

  it('/recipes/:slug emits title + og:* + twitter:card from the DB row', async () => {
    const { status, html } = await getHtml(`/recipes/${recipeSlug}`);
    assert.equal(status, 200);
    assert.ok(html.includes('<title>OG Test Casserole — Pantry Host</title>'));
    assert.ok(html.includes('<meta property="og:title" content="OG Test Casserole — Pantry Host">'));
    assert.ok(html.includes('<meta property="og:type" content="article">'));
    assert.ok(html.includes(
      '<meta property="og:description" content="A casserole used in integration tests">',
    ));
    assert.ok(html.includes('<meta name="description" content="A casserole used in integration tests">'));
    // Photo URL is /uploads/… and should be absolutized via the request's host.
    assert.match(
      html,
      /<meta property="og:image" content="http:\/\/127\.0\.0\.1:\d+\/uploads\/og-test\.jpg">/,
    );
    assert.ok(html.includes('<meta name="twitter:card" content="summary_large_image">'));
  });

  it('/menus/:slug emits og:type=website (vs article for recipes)', async () => {
    const { status, html } = await getHtml(`/menus/${menuSlug}`);
    assert.equal(status, 200);
    assert.ok(html.includes('<title>OG Test Menu — Pantry Host</title>'));
    assert.ok(html.includes('<meta property="og:type" content="website">'));
    assert.ok(html.includes(
      '<meta property="og:description" content="Menu used in integration tests">',
    ));
    // No photoUrl on this menu — twitter:card falls back to `summary`.
    assert.ok(html.includes('<meta name="twitter:card" content="summary">'));
    assert.ok(!html.includes('<meta property="og:image"'), 'no og:image without a photo');
  });

  it('/kitchens/home/recipes/<slug> redirects to /recipes/<slug>, not OG-injected at the old URL', async () => {
    const { status, redirect } = await getHtml(`/kitchens/home/recipes/${recipeSlug}`);
    assert.equal(status, 308);
    assert.equal(redirect, `/recipes/${recipeSlug}`);
  });

  it('/kitchens/<other>/recipes/:slug injects OG meta', async () => {
    // Create a non-home kitchen + a recipe in it, then verify the
    // kitchen-scoped URL also gets OG meta.
    await gql<{ createKitchen: { slug: string } }>(
      `mutation($s: String!, $n: String!) { createKitchen(slug: $s, name: $n) { slug } }`,
      { s: 'og-test-kitchen', n: 'OG Test Kitchen' },
    );
    const r = await gql<CreatedRecipe>(
      `mutation Create(
        $title: String!,
        $description: String,
        $instructions: String!,
        $kitchenSlug: String,
        $ingredients: [RecipeIngredientInput!]!,
      ) {
        createRecipe(
          title: $title,
          description: $description,
          instructions: $instructions,
          kitchenSlug: $kitchenSlug,
          ingredients: $ingredients,
        ) { slug }
      }`,
      {
        title: 'Kitchen-Scoped Salad',
        description: 'Lives in og-test-kitchen',
        instructions: 'Toss',
        kitchenSlug: 'og-test-kitchen',
        ingredients: [{ ingredientName: 'lettuce', quantity: 1, unit: 'head' }],
      },
    );
    const { status, html } = await getHtml(
      `/kitchens/og-test-kitchen/recipes/${r.createRecipe.slug}`,
    );
    assert.equal(status, 200);
    assert.ok(html.includes('<title>Kitchen-Scoped Salad — Pantry Host</title>'));
    assert.ok(html.includes('<meta property="og:type" content="article">'));
  });

  it('reserved page bundles (/recipes/new, /recipes/import, …) skip the DB lookup', async () => {
    const { status, html } = await getHtml('/recipes/new');
    assert.equal(status, 200);
    // Generic title, no og:title — these are not detail pages, so the
    // reserved-segment guard short-circuits the lookup. The page bundle
    // (recipes-new-*.js) is what actually picks the right component.
    assert.ok(html.includes('<title>Pantry Host</title>'));
    assert.ok(!html.includes('<meta property="og:title"'));
  });

  it('unknown slug yields the shell with the og:type set but no title/description', async () => {
    const { status, html } = await getHtml('/recipes/this-slug-does-not-exist');
    assert.equal(status, 200);
    // og_type is set ("article") but title/description/image are all
    // null, so render_og returns just the generic title with the
    // og:type tag absent — render_og only emits OG metas when at least
    // one of title/description/image is present.
    assert.ok(html.includes('<title>Pantry Host</title>'));
    assert.ok(!html.includes('<meta property="og:title"'));
  });
});
