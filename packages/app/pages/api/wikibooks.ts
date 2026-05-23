import type { NextApiRequest, NextApiResponse } from 'next';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { fetchWikibooksDataset, searchWikibooks, type WikibooksEntry } from '@pantry-host/shared/wikibooks';

const CACHE_DIR = join(process.cwd(), '.cache');
const CACHE_FILE = join(CACHE_DIR, 'wikibooks-cookbook.json');

let memoryCache: WikibooksEntry[] | null = null;

async function getData(): Promise<WikibooksEntry[]> {
  // 1. Memory cache (instant)
  if (memoryCache) return memoryCache;

  // 2. Filesystem cache
  if (existsSync(CACHE_FILE)) {
    try {
      const raw = readFileSync(CACHE_FILE, 'utf-8');
      memoryCache = JSON.parse(raw) as WikibooksEntry[];
      return memoryCache;
    } catch { /* corrupted cache — re-fetch */ }
  }

  // 3. Fetch from Hugging Face + cache
  const entries = await fetchWikibooksDataset();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(entries));
  memoryCache = entries;
  return entries;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const slug = (req.query.slug as string) || '';
    const q = (req.query.q as string) || '';
    const offset = parseInt(req.query.offset as string) || 0;
    const limit = Math.min(parseInt(req.query.limit as string) || 48, 100);

    const data = await getData();

    // Single-entry lookup by slug (used by /import/wikibooks/{slug} preview).
    if (slug) {
      const entry = data.find((e) => e.slug === slug);
      if (!entry) return res.status(404).json({ error: `No Wikibooks entry with slug "${slug}"` });
      res.setHeader('Cache-Control', 'public, max-age=3600');
      return res.status(200).json({ entry });
    }

    const filtered = q ? searchWikibooks(q, data) : data;
    const page = filtered.slice(offset, offset + limit);

    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.status(200).json({
      total: filtered.length,
      offset,
      limit,
      results: page,
    });
  } catch (err) {
    return res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
  }
}
