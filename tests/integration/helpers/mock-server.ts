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
