import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const MOCK_RECIPE_HTML = `<!doctype html>
<html>
<head>
  <title>Mock Tomato Soup</title>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Recipe",
    "name": "Mock Tomato Soup",
    "recipeIngredient": ["2 cups tomatoes", "1 onion", "3 cups stock"],
    "recipeInstructions": [
      { "@type": "HowToStep", "text": "Saute the onion" },
      { "@type": "HowToStep", "text": "Add tomatoes and stock" },
      { "@type": "HowToStep", "text": "Simmer 20 minutes" }
    ],
    "recipeYield": "4",
    "prepTime": "PT5M",
    "cookTime": "PT25M"
  }
  </script>
</head>
<body><h1>Mock Tomato Soup</h1></body>
</html>`;

const MOCK_GENERATED_RECIPES = [
  {
    title: 'Mock Salt Bowl',
    description: 'A bowl of salt.',
    instructions: '1. Pour salt into bowl.\n2. Serve.',
    servings: 1,
    prepTime: 1,
    cookTime: 0,
    tags: ['salty'],
    requiredCookware: [],
    ingredients: [{ ingredientName: 'Salt', quantity: 1, unit: 'tbsp' }],
  },
  {
    title: 'Mock Pepper Bowl',
    description: 'A bowl of pepper.',
    instructions: '1. Pour pepper into bowl.\n2. Serve.',
    servings: 1,
    prepTime: 1,
    cookTime: 0,
    tags: ['spicy'],
    requiredCookware: [],
    ingredients: [{ ingredientName: 'Pepper', quantity: 1, unit: 'tbsp' }],
  },
  {
    title: 'Mock Mixed Bowl',
    description: 'A mix of both.',
    instructions: '1. Combine salt and pepper.\n2. Serve.',
    servings: 1,
    prepTime: 1,
    cookTime: 0,
    tags: ['balanced'],
    requiredCookware: [],
    ingredients: [
      { ingredientName: 'Salt', quantity: 1, unit: 'tsp' },
      { ingredientName: 'Pepper', quantity: 1, unit: 'tsp' },
    ],
  },
];

export interface MockServer {
  url: string;
  stop(): Promise<void>;
}

// ── Open Food Facts (mocked) ──
// Single happy-path product (Nutella-shaped) for /api/lookup-barcode. Real
// OFF responses are huge; we ship the smallest possible shape that exercises
// the allowlistProductMeta() + unit-conversion code paths.
const MOCK_OFF_PRODUCT = {
  status: 1,
  product: {
    code: '3017624010701',
    product_name: 'Mock Nutella',
    brands: 'MockFerrero,SecondaryBrand',
    categories_tags: ['en:breakfasts', 'en:spreads', 'en:cocoa-and-hazelnuts-spreads'],
    quantity: '400 g',
    product_quantity: 400,
    product_quantity_unit: 'g',
    nutriments: {
      'energy-kcal_100g': 539,
      'fat_100g': 30.9,
      'sugars_100g': 56.3,
      // Non-100g/-serving keys are dropped by allowlistProductMeta:
      'energy-kcal_unit': 'kcal',
    },
    ingredients_text: 'sugar, palm oil, hazelnuts (13%), cocoa (7.4%), milk',
    allergens_tags: ['en:milk', 'en:nuts', 'en:soybeans'],
    nutriscore_grade: 'e',
    nova_group: 4,
    ecoscore_grade: 'd',
    serving_size: '15 g',
    serving_quantity: 15,
    labels_tags: [],
    main_category: 'en:cocoa-and-hazelnuts-spreads',
    pnns_groups_1: 'Sugary snacks',
    pnns_groups_2: 'Sweets',
  },
};

// ── Hugging Face datasets-server (mocked) ──
// 3-row dataset is enough to exercise pagination (batch size = 100; we
// return total=3 so only one request is made) and the normalizer.
const MOCK_WIKIBOOKS_RAW = [
  {
    row: {
      filename: 'a.json',
      recipe_data: {
        title: 'Mock Mac and Cheese',
        url: 'https://en.wikibooks.org/wiki/Cookbook:Mock_Mac_and_Cheese',
        infobox: {
          category: '/wiki/Category:Pasta_recipes',
          difficulty: 2,
          servings: '4',
          time: '30 minutes',
        },
        text_lines: [
          { line_type: 'list', section: 'Ingredients', text: '200 g macaroni' },
          { line_type: 'list', section: 'Ingredients', text: '150 g cheddar' },
          { line_type: 'paragraph', section: 'Procedure', text: 'Boil macaroni' },
          { line_type: 'paragraph', section: 'Procedure', text: 'Stir in cheese' },
        ],
      },
    },
  },
  {
    row: {
      filename: 'b.json',
      recipe_data: {
        title: 'Mock Pancakes',
        url: 'https://en.wikibooks.org/wiki/Cookbook:Mock_Pancakes',
        infobox: {
          category: '/wiki/Category:Breakfast_recipes',
          difficulty: 1,
        },
        text_lines: [
          { line_type: 'list', section: 'Ingredients', text: '1 cup flour' },
          { line_type: 'list', section: 'Ingredients', text: '1 egg' },
          { line_type: 'paragraph', section: 'Procedure', text: 'Mix and fry' },
        ],
      },
    },
  },
  {
    row: {
      filename: 'c.json',
      recipe_data: {
        title: 'Mock Smoothie',
        url: 'https://en.wikibooks.org/wiki/Cookbook:Mock_Smoothie',
        infobox: { difficulty: 1, servings: '2' },
        text_lines: [
          { line_type: 'list', section: 'Ingredients', text: '1 banana' },
          { line_type: 'list', section: 'Ingredients', text: '1 cup milk' },
          { line_type: 'paragraph', section: 'Procedure', text: 'Blend everything' },
        ],
      },
    },
  },
];

export async function startMockServer(): Promise<MockServer> {
  const server: Server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/recipe.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(MOCK_RECIPE_HTML);
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/messages') {
      const payload = {
        id: 'msg_mock',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6-mock',
        content: [
          { type: 'text', text: JSON.stringify(MOCK_GENERATED_RECIPES) },
        ],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    // Open Food Facts: GET /api/v2/product/{code}.json
    if (req.method === 'GET' && req.url?.startsWith('/api/v2/product/')) {
      const codeFromUrl = req.url.slice('/api/v2/product/'.length).split('.')[0];
      if (codeFromUrl === MOCK_OFF_PRODUCT.product.code) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(MOCK_OFF_PRODUCT));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 0 }));
      }
      return;
    }
    // Hugging Face datasets-server: GET /rows?dataset=…&offset=…&length=…
    if (req.method === 'GET' && req.url?.startsWith('/rows')) {
      const params = new URLSearchParams(req.url.split('?')[1] ?? '');
      const offset = parseInt(params.get('offset') ?? '0') || 0;
      const length = parseInt(params.get('length') ?? '100') || 100;
      const slice = MOCK_WIKIBOOKS_RAW.slice(offset, offset + length);
      const payload = { rows: slice, num_rows_total: MOCK_WIKIBOOKS_RAW.length };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('mock: not found');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    stop: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
