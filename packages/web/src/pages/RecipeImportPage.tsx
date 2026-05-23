import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { gql } from '@/lib/gql';
import {
  searchFederationRecipes,
  getFederationRecipe,
  cooklangToRecipe,
  type FederationSearchResult,
  type FederationPagination,
} from '@pantry-host/shared/cooklang';
import {
  searchMealDB,
  filterByCategory,
  getMealDBRecipe,
  getMealDBCategories,
  mealToRecipe,
  type MealDBMeal,
  type MealDBSearchResult,
  type MealDBCategory,
} from '@pantry-host/shared/mealdb';
import {
  searchPublicDomainRecipes,
  fetchPublicDomainRecipe,
  getPublicDomainImageUrl,
  type PDREntry,
} from '@pantry-host/shared/publicdomainrecipes';
import { MagnifyingGlass, CookingPot, DownloadSimple } from '@phosphor-icons/react';
import { searchWikibooks, parseIngredientLine, type WikibooksEntry } from '@pantry-host/shared/wikibooks';
import {
  searchCocktailDB,
  filterCocktailsByCategory,
  getCocktailDBRecipe,
  getCocktailDBCategories,
  drinkToRecipe,
  type CocktailDBDrink,
  type CocktailDBSearchResult,
  type CocktailDBCategory,
} from '@pantry-host/shared/cocktaildb';
import { isWikibooksDownloaded, loadWikibooksData, downloadWikibooksDataset } from '@/lib/wikibooks-store';
import {
  searchRecipeAPI,
  getRecipeAPIRecipe,
  RecipeAPIError,
  getRecipeAPICategories,
  recipeApiToParsed,
  type RecipeAPIListItem,
  type RecipeAPICategoryCount,
} from '@pantry-host/shared/recipe-api';
import {
  parseAtUri,
  isRecipeUri,
  isCollectionUri,
  fetchBlueskyRecipe,
  fetchBlueskyCollection,
  listBlueskyRecipes,
  type ParsedRecipe as BlueskyParsedRecipe,
} from '@pantry-host/shared/bluesky';
import CommunityDatasources from '@pantry-host/shared/components/CommunityDatasources';
import { parseImport } from '@/lib/parse-worker-client';
import ImportGrid, { captureActiveElement, restoreFocus } from '@pantry-host/shared/components/ImportGrid';

const CREATE_MUTATION = `mutation(
  $title: String!, $description: String, $instructions: String!,
  $servings: Int, $prepTime: Int, $cookTime: Int,
  $tags: [String!], $photoUrl: String, $sourceUrl: String,
  $ingredients: [RecipeIngredientInput!]!
) {
  createRecipe(
    title: $title, description: $description, instructions: $instructions,
    servings: $servings, prepTime: $prepTime, cookTime: $cookTime,
    tags: $tags, photoUrl: $photoUrl, sourceUrl: $sourceUrl, ingredients: $ingredients
  ) { id slug }
}`;

type Tab = 'url' | 'mealdb' | 'cocktaildb' | 'publicdomain' | 'cooklang' | 'wikibooks' | 'recipe-api';

const RECIPE_API_KEY_STORAGE = 'recipe-api-key';

// ── Cooklang detail cache + throttled fetcher ──────────────────────────────
//
// The federation /api/search response has no image_url, so to render a
// thumbnail we have to call /api/recipes/:id for each card. The federation
// has a ~60 req/min rate limit and rate-limits burst windows aggressively.
// To avoid "search chicken → add recipe → 429", we:
//   1. Cache the FULL FederationRecipe object (not just the image_url) so
//      handleImport can reuse what the image-probe queue already fetched
//      instead of hitting the API a second time.
//   2. Throttle the probe queue at 1500ms between calls (40/min, headroom
//      for one import fetch per recipe without blowing the ceiling).
//   3. Fall through to the existing `getFederationRecipe` call in
//      handleImport only for recipes not yet in the cache — and rely on
//      the SW's 24h pantryhost-cooklang-v1 bucket to make those free on
//      any repeat.

const clRecipeCache = new Map<number, FederationRecipe | null>();
let clImageQueue: number[] = [];
let clImageProcessing = false;
let clImageListeners = new Set<() => void>();
let clImageStopped = false;

async function processClImageQueue() {
  if (clImageProcessing) return;
  clImageProcessing = true;
  while (clImageQueue.length > 0 && !clImageStopped) {
    const id = clImageQueue.shift()!;
    if (clRecipeCache.has(id)) continue;
    try {
      const detail = await getFederationRecipe(id);
      clRecipeCache.set(id, detail);
    } catch {
      clRecipeCache.set(id, null);
      clImageStopped = true; // rate limited — stop fetching
    }
    clImageListeners.forEach((fn) => fn());
    if (clImageQueue.length > 0 && !clImageStopped) {
      await new Promise((r) => setTimeout(r, 1500)); // ~40 req/min — under the 60/min ceiling
    }
  }
  clImageProcessing = false;
}

function useClImage(id: number): string | null | undefined {
  const [, forceUpdate] = useState(0);
  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    clImageListeners.add(listener);
    if (!clRecipeCache.has(id) && !clImageQueue.includes(id)) {
      clImageQueue.push(id);
      clImageStopped = false;
      processClImageQueue();
    }
    return () => { clImageListeners.delete(listener); };
  }, [id]);
  if (!clRecipeCache.has(id)) return undefined; // loading
  const cached = clRecipeCache.get(id);
  return cached ? (cached.image_url ?? null) : null;
}

function CooklangCard({ result: r, selected, onToggle, selectedCount, onImport }: { result: FederationSearchResult; selected: boolean; onToggle: () => void; selectedCount: number; onImport: () => void }) {
  const imageUrl = useClImage(r.id);
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = imageUrl && !imgFailed;
  const showPlaceholder = imageUrl === null || imgFailed;
  return (
    <label className={`group card overflow-hidden cursor-pointer transition-colors ${selected ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]' : ''}`}>
      {showImage && (
        <div className="aspect-[16/9] overflow-hidden bg-[var(--color-bg-card)]">
          <img src={imageUrl} alt={r.title} className="w-full h-full object-cover" loading="lazy" onError={() => setImgFailed(true)} />
        </div>
      )}
      {showPlaceholder && (
        <div className="aspect-[16/9] flex items-center justify-center bg-[var(--color-bg-card)] text-[var(--color-text-secondary)] opacity-30">
          <CookingPot size={48} weight="light" aria-hidden />
        </div>
      )}
      {imageUrl === undefined && (
        <div className="h-2 bg-[var(--color-accent-subtle)] animate-pulse" />
      )}
      <div className="p-3 flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1 w-4 h-4 shrink-0" />
        <div className="min-w-0">
          <p className="font-semibold text-sm leading-snug">{r.title}</p>
          {r.tags.length > 0 && <div className="flex flex-wrap gap-1 mt-2">{r.tags.slice(0, 4).map((t) => <span key={t} className="tag">{t}</span>)}</div>}
        </div>
      </div>
      {selected && selectedCount > 0 && (
        <button type="button" onClick={(e) => { e.preventDefault(); onImport(); }} className="hidden group-focus-within:block btn-primary text-xs mx-3 mb-3 w-[calc(100%-1.5rem)]">
          Import {selectedCount} selected
        </button>
      )}
    </label>
  );
}

// ── Cooklang Tab ────────────────────────────────────────────────────────────

function CooklangTab({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FederationSearchResult[]>([]);
  const [pagination, setPagination] = useState<FederationPagination | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const [mode, setMode] = useState<'bulk' | 'browse'>(() => (typeof window === 'undefined' ? 'bulk' : (localStorage.getItem('import-mode-cooklang') as 'bulk' | 'browse') || 'bulk'));
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('import-mode-cooklang', mode); }, [mode]);

  const search = useCallback(async (q: string, page = 1, append = false) => {
    if (!q.trim()) { setResults([]); setPagination(null); return; }
    if (page === 1) setSearching(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const data = await searchFederationRecipes(q.trim(), page, 8);
      setResults((prev) => append ? [...prev, ...data.results] : data.results);
      setPagination(data.pagination);
    } catch (err) {
      setError(`Search failed: ${(err as Error).message}`);
    } finally { setSearching(false); setLoadingMore(false); }
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q) { setResults([]); setPagination(null); return; }
    if (q.length < 3) return; // don't hammer the federation for 1-2 char queries
    debounceRef.current = setTimeout(() => search(query), 600);
    return () => clearTimeout(debounceRef.current);
  }, [query, search]);

  async function handleImport() {
    if (selected.size === 0) return;
    const prevFocus = captureActiveElement();
    setImporting(true);
    setImportProgress({ done: 0, total: selected.size });
    setError(null);
    const ids = Array.from(selected);
    let done = 0, failed = 0;
    for (const id of ids) {
      try {
        // Reuse the object the image-probe queue already fetched if present,
        // so importing a recipe the user can see in the grid is a zero-request
        // operation (other than the GraphQL create mutation below).
        const full = clRecipeCache.get(id) ?? await getFederationRecipe(id);
        if (!clRecipeCache.has(id)) clRecipeCache.set(id, full);
        const recipe = cooklangToRecipe(full);
        await gql(CREATE_MUTATION, {
          title: recipe.title, description: recipe.description || null, instructions: recipe.instructions,
          servings: recipe.servings ?? null, prepTime: recipe.prepTime ?? null, cookTime: recipe.cookTime ?? null,
          tags: recipe.tags ?? [], photoUrl: recipe.photoUrl ?? null, sourceUrl: recipe.sourceUrl ?? null,
          ingredients: recipe.ingredients,
        });
      } catch (err) { console.error(`Failed to import recipe ${id}:`, err); failed++; }
      done++;
      setImportProgress({ done, total: ids.length });
      if (done < ids.length) await new Promise((r) => setTimeout(r, 1200));
    }
    setImporting(false); setImportProgress(null);
    if (failed > 0 && failed === ids.length) { setError('All imports failed. Try again in a minute.'); restoreFocus(prevFocus); }
    else if (failed > 0) { setError(`${done - failed} of ${ids.length} imported. ${failed} failed.`); restoreFocus(prevFocus); }
    else navigate('/recipes#stage');
  }

  return (
    <>
      <fieldset className="mb-4 card p-3 text-sm">
        <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
        <div className="flex flex-wrap gap-4 px-2">
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="cl-mode" value="browse" checked={mode === 'browse'} onChange={() => setMode('browse')} className="accent-accent" /><span>Browse &amp; Import</span></label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="cl-mode" value="bulk" checked={mode === 'bulk'} onChange={() => setMode('bulk')} className="accent-accent" /><span>Bulk Import</span></label>
        </div>
      </fieldset>
      <div className="relative mb-6">
        <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="banana bread" className="field-input w-full pl-9" autoFocus />
      </div>
      {error && <p role="alert" className="text-sm text-red-400 mb-4">{error}</p>}
      {searching && results.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{[1,2,3,4,5,6].map((i) => <div key={i} className="h-28 rounded-xl bg-[var(--color-bg-card)] animate-pulse" />)}</div>
      )}
      {results.length > 0 && (
        <>
          <ImportGrid
            importing={importing}
            importingLabel={importProgress ? `Importing ${importProgress.done}/${importProgress.total}…` : undefined}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selected.size > 0) { e.preventDefault(); handleImport(); } }}
            ariaKeyshortcuts="Meta+Enter"
          >
            {results.map((r) => (
              mode === 'browse'
                ? <Link key={r.id} to={`/import/cooklang/${r.id}#stage`} className="group card rounded-xl overflow-hidden p-4 transition-colors hover:border-[var(--color-accent)]">
                    <p className="font-semibold text-sm leading-snug">{r.title}</p>
                  </Link>
                : <CooklangCard key={r.id} result={r} selected={selected.has(r.id)} selectedCount={selected.size} onImport={handleImport} onToggle={() => { setSelected((p) => { const n = new Set(p); n.has(r.id) ? n.delete(r.id) : n.add(r.id); return n; }); }} />
            ))}
          </ImportGrid>
          {pagination && pagination.page < pagination.total_pages && (
            <div className="text-center mb-6">
              <button type="button" onClick={() => search(query, pagination.page + 1, true)} disabled={loadingMore} className="btn-secondary">
                {loadingMore ? 'Loading\u2026' : `Load More (${results.length} of ${pagination.total})`}
              </button>
            </div>
          )}
          {mode === 'bulk' && selected.size > 0 && (
            <div className="sticky bottom-4 z-10 flex justify-center">
              <button type="button" onClick={handleImport} disabled={importing} className="btn-primary shadow-lg">
                {importing && importProgress ? `Importing ${importProgress.done}/${importProgress.total}\u2026` : `Import Selected (${selected.size})`}
              </button>
            </div>
          )}
        </>
      )}
      {!searching && query.trim() && results.length === 0 && <p className="text-[var(--color-text-secondary)] text-sm text-center py-12">No recipes found for "{query}".</p>}
      {!query.trim() && <p className="text-[var(--color-text-secondary)] text-sm text-center py-12">Search the Cooklang Federation's {'\u2248'}3,500 community recipes.</p>}
    </>
  );
}

// ── TheMealDB Tab ───────────────────────────────────────────────────────────

function MealDBTab({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<MealDBCategory[]>([]);
  const [results, setResults] = useState<(MealDBMeal | MealDBSearchResult)[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  // User Flow toggle — browse routes to per-recipe preview pages, bulk
  // keeps the historical checkbox-grid + batch-import behavior.
  const [mode, setMode] = useState<'bulk' | 'browse'>(() => {
    if (typeof window === 'undefined') return 'bulk';
    return (localStorage.getItem('import-mode-mealdb') as 'bulk' | 'browse') || 'bulk';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') localStorage.setItem('import-mode-mealdb', mode);
  }, [mode]);

  useEffect(() => {
    getMealDBCategories().then(setCategories).catch(() => {});
  }, []);

  const searchByName = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true); setError(null); setCategory('');
    try {
      const meals = await searchMealDB(q.trim());
      setResults(meals);
    } catch (err) { setError(`Search failed: ${(err as Error).message}`); }
    finally { setSearching(false); }
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) { if (!category) setResults([]); return; }
    debounceRef.current = setTimeout(() => searchByName(query), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, searchByName]);

  async function handleCategoryFilter(cat: string) {
    setCategory(cat); setQuery(''); setSearching(true); setError(null);
    try {
      const meals = await filterByCategory(cat);
      setResults(meals);
    } catch (err) { setError(`Filter failed: ${(err as Error).message}`); }
    finally { setSearching(false); }
  }

  async function handleImport() {
    if (selected.size === 0) return;
    const prevFocus = captureActiveElement();
    setImporting(true);
    setImportProgress({ done: 0, total: selected.size });
    setError(null);
    const ids = Array.from(selected);
    let done = 0, failed = 0;
    for (const id of ids) {
      try {
        // Search results have full data; filter results need lookup
        let meal = results.find((r) => r.idMeal === id) as MealDBMeal | undefined;
        if (!meal || !('strInstructions' in meal)) {
          meal = await getMealDBRecipe(id) ?? undefined;
        }
        if (!meal) throw new Error('Meal not found');
        const recipe = mealToRecipe(meal);
        await gql(CREATE_MUTATION, {
          title: recipe.title, description: null, instructions: recipe.instructions,
          servings: null, prepTime: null, cookTime: null,
          tags: recipe.tags, photoUrl: recipe.photoUrl, sourceUrl: recipe.sourceUrl,
          ingredients: recipe.ingredients,
        });
      } catch (err) { console.error(`Failed to import meal ${id}:`, err); failed++; }
      done++;
      setImportProgress({ done, total: ids.length });
    }
    setImporting(false); setImportProgress(null);
    if (failed > 0) restoreFocus(prevFocus);
    if (failed > 0 && failed === ids.length) setError('All imports failed.');
    else if (failed > 0) setError(`${done - failed} of ${ids.length} imported. ${failed} failed.`);
    else navigate('/recipes#stage');
  }

  return (
    <>
      {/* User Flow toggle — mirrors the bluesky feed page's pattern. */}
      <fieldset className="mb-4 card p-3 text-sm">
        <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
        <div className="flex flex-wrap gap-4 px-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="mealdb-mode" value="browse" checked={mode === 'browse'} onChange={() => setMode('browse')} className="accent-accent" />
            <span>Browse &amp; Import</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" name="mealdb-mode" value="bulk" checked={mode === 'bulk'} onChange={() => setMode('bulk')} className="accent-accent" />
            <span>Bulk Import</span>
          </label>
        </div>
      </fieldset>
      <div className="flex flex-col sm:flex-row gap-3 mb-6 sm:items-end">
        <div className="flex-1">
          <label htmlFor="mealdb-search" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Search</label>
          <div className="relative">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
            <input id="mealdb-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="vegetable curry" className="field-input w-full pl-9" />
          </div>
        </div>
        <div>
          <label htmlFor="mealdb-category" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Category</label>
          <select id="mealdb-category" value={category} onChange={(e) => { if (e.target.value) handleCategoryFilter(e.target.value); }} className="field-select w-full sm:w-auto">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c.idCategory} value={c.strCategory}>{c.strCategory}</option>)}
          </select>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-400 mb-4">{error}</p>}

      {searching && results.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{[1,2,3,4,5,6].map((i) => <div key={i} className="h-40 rounded-xl bg-[var(--color-bg-card)] animate-pulse" />)}</div>
      )}

      {results.length > 0 && (
        <>
          <ImportGrid
            importing={importing}
            importingLabel={importProgress ? `Importing ${importProgress.done}/${importProgress.total}…` : undefined}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selected.size > 0) { e.preventDefault(); handleImport(); } }}
            ariaKeyshortcuts="Meta+Enter"
          >
            {results.map((r) => {
              const isSel = selected.has(r.idMeal);
              const thumb = r.strMealThumb;
              const cat = 'strCategory' in r ? (r as MealDBMeal).strCategory : null;
              const area = 'strArea' in r ? (r as MealDBMeal).strArea : null;
              const thumbBlock = thumb && (
                <div className="aspect-[16/9] overflow-hidden bg-[var(--color-bg-card)]">
                  <picture>
                    <source media="(prefers-reduced-data: reduce)" srcSet={`${thumb}/preview`} />
                    <source media="(monochrome)" srcSet={`${thumb}/preview`} />
                    <img src={`${thumb}/preview`} srcSet={`${thumb} 2x`} alt={r.strMeal} className="w-full h-full object-cover" loading="lazy" />
                  </picture>
                </div>
              );
              const meta = (
                <div className="min-w-0">
                  <p className="font-semibold text-sm leading-snug">{r.strMeal}</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {cat && <span className="tag">{cat}</span>}
                    {area && <span className="tag">{area}</span>}
                  </div>
                </div>
              );
              if (mode === 'browse') {
                return (
                  <Link key={r.idMeal} to={`/import/mealdb/${r.idMeal}#stage`} className="group card rounded-xl overflow-hidden transition-colors hover:border-[var(--color-accent)]">
                    {thumbBlock}
                    <div className="p-3 flex items-start gap-3">{meta}</div>
                  </Link>
                );
              }
              return (
                <label key={r.idMeal} className={`group card rounded-xl overflow-hidden cursor-pointer transition-colors ${isSel ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]' : ''}`}>
                  {thumbBlock}
                  <div className="p-3 flex items-start gap-3">
                    <input type="checkbox" checked={isSel} onChange={() => { setSelected((p) => { const n = new Set(p); n.has(r.idMeal) ? n.delete(r.idMeal) : n.add(r.idMeal); return n; }); }} className="mt-1 w-4 h-4 shrink-0" />
                    {meta}
                  </div>
                  {isSel && selected.size > 0 && (
                    <button type="button" onClick={(e) => { e.preventDefault(); handleImport(); }} className="hidden group-focus-within:block btn-primary text-xs mx-3 mb-3 w-[calc(100%-1.5rem)]">
                      Import {selected.size} selected
                    </button>
                  )}
                </label>
              );
            })}
          </ImportGrid>

          {mode === 'bulk' && selected.size > 0 && (
            <div className="sticky bottom-4 z-10 flex justify-center">
              <button type="button" onClick={handleImport} disabled={importing} className="btn-primary shadow-lg">
                {importing && importProgress ? `Importing ${importProgress.done}/${importProgress.total}\u2026` : `Import Selected (${selected.size})`}
              </button>
            </div>
          )}
        </>
      )}

      {!searching && !query.trim() && !category && (
        <p className="text-[var(--color-text-secondary)] text-sm text-center py-12">Search or pick a category to browse TheMealDB recipes.</p>
      )}
      {!searching && (query.trim() || category) && results.length === 0 && (
        <p className="text-[var(--color-text-secondary)] text-sm text-center py-12">No results found.</p>
      )}
    </>
  );
}

// ── Public Domain Tab ───────────────────────────────────────────────────────

// ── CocktailDB Tab ───────────────────────────────────────────────────────────

function CocktailDBTab({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const [ageVerified, setAgeVerified] = useState(() =>
    typeof window !== 'undefined' && localStorage.getItem('age-verified') === 'true'
  );
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<CocktailDBCategory[]>([]);
  const [results, setResults] = useState<(CocktailDBDrink | CocktailDBSearchResult)[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const [mode, setMode] = useState<'bulk' | 'browse'>(() => (typeof window === 'undefined' ? 'bulk' : (localStorage.getItem('import-mode-cocktaildb') as 'bulk' | 'browse') || 'bulk'));
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('import-mode-cocktaildb', mode); }, [mode]);

  useEffect(() => { if (ageVerified) getCocktailDBCategories().then(setCategories).catch(() => {}); }, [ageVerified]);

  const searchByName = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true); setError(null); setCategory('');
    try { setResults(await searchCocktailDB(q.trim())); }
    catch (err) { setError(`Search failed: ${(err as Error).message}`); }
    finally { setSearching(false); }
  }, []);

  useEffect(() => {
    clearTimeout(debounceRef.current);
    if (!query.trim()) { if (!category) setResults([]); return; }
    debounceRef.current = setTimeout(() => searchByName(query), 300);
    return () => clearTimeout(debounceRef.current);
  }, [query, searchByName]);

  if (!ageVerified) {
    return (
      <div className="text-center py-12">
        <p className="text-[var(--color-text-secondary)] mb-2">
          TheCocktailDB contains alcoholic drink recipes.
        </p>
        <p className="text-[var(--color-text-secondary)] text-sm mb-6">
          You must be 21 or older to browse this content.
        </p>
        <button
          onClick={() => { localStorage.setItem('age-verified', 'true'); setAgeVerified(true); }}
          className="btn-primary"
        >
          I am 21 or older
        </button>
      </div>
    );
  }

  async function handleCategoryFilter(cat: string) {
    setCategory(cat); setQuery(''); setSearching(true); setError(null);
    try { setResults(await filterCocktailsByCategory(cat)); }
    catch (err) { setError(`Filter failed: ${(err as Error).message}`); }
    finally { setSearching(false); }
  }

  function toggleSelect(id: string) {
    setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  }

  async function handleImport() {
    if (selected.size === 0) return;
    const prevFocus = captureActiveElement();
    setImporting(true);
    setImportProgress({ done: 0, total: selected.size });
    const ids = Array.from(selected);
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        let drink = results.find((r) => ('idDrink' in r ? r.idDrink : '') === ids[i]) as CocktailDBDrink | undefined;
        if (!drink || !('strInstructions' in drink)) drink = await getCocktailDBRecipe(ids[i]) ?? undefined;
        if (!drink) throw new Error('Drink not found');
        const recipe = drinkToRecipe(drink);
        await gql(CREATE_MUTATION, {
          title: recipe.title, description: null, instructions: recipe.instructions,
          servings: null, prepTime: null, cookTime: null,
          tags: recipe.tags, photoUrl: recipe.photoUrl, sourceUrl: recipe.sourceUrl,
          ingredients: recipe.ingredients,
        });
      } catch { failed++; }
      setImportProgress({ done: i + 1, total: ids.length });
      if (i < ids.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
    setImporting(false);
    setSelected(new Set()); setImportProgress(null);
    if (failed > 0) restoreFocus(prevFocus);
    else navigate('/recipes#stage');
  }

  return (
    <>
      <fieldset className="mb-4 card p-3 text-sm">
        <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
        <div className="flex flex-wrap gap-4 px-2">
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="cd-mode" value="browse" checked={mode === 'browse'} onChange={() => setMode('browse')} className="accent-accent" /><span>Browse &amp; Import</span></label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="cd-mode" value="bulk" checked={mode === 'bulk'} onChange={() => setMode('bulk')} className="accent-accent" /><span>Bulk Import</span></label>
        </div>
      </fieldset>
      <div className="flex flex-col sm:flex-row gap-2 mb-4 sm:items-end">
        <div className="flex-1">
          <label htmlFor="cocktaildb-search" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Search</label>
          <div className="relative">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
          <input
            id="cocktaildb-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="margarita"
            className="field-input w-full pl-9"
          />
          </div>
        </div>
        {categories.length > 0 && (
          <div>
            <label htmlFor="cocktaildb-category" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Category</label>
            <select
              id="cocktaildb-category"
              value={category}
              onChange={(e) => { if (e.target.value) handleCategoryFilter(e.target.value); }}
              className="field-select w-full sm:w-auto"
            >
              <option value="">All categories</option>
              {categories.map((c) => <option key={c.strCategory} value={c.strCategory}>{c.strCategory}</option>)}
            </select>
          </div>
        )}
      </div>

      {error && <p className="text-sm text-red-500 mb-4">{error}</p>}

      {searching && <div className="h-40 rounded-xl bg-[var(--color-bg-card)] animate-pulse" />}

      {importProgress && (
        <div className="mb-4 p-3 card text-sm text-center">
          Importing {importProgress.done} of {importProgress.total}…
        </div>
      )}

      <ImportGrid
        importing={importing}
        importingLabel={importProgress ? `Importing ${importProgress.done}/${importProgress.total}…` : undefined}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selected.size > 0) { e.preventDefault(); handleImport(); } }}
        ariaKeyshortcuts="Meta+Enter"
      >
        {results.map((r) => {
          const id = 'idDrink' in r ? r.idDrink : '';
          const name = 'strDrink' in r ? r.strDrink : '';
          const thumb = 'strDrinkThumb' in r ? r.strDrinkThumb : null;
          const thumbEl = thumb && (
            <picture>
              <source media="(prefers-reduced-data: reduce)" srcSet={`${thumb}/preview`} />
              <img src={thumb} srcSet={`${thumb}/preview 1x, ${thumb} 2x`} alt={name} className="w-full aspect-[4/3] object-cover" loading="lazy" />
            </picture>
          );
          const meta = (
            <div>
              <p className="font-semibold text-sm">{name}</p>
              {('strCategory' in r && r.strCategory) && <span className="tag text-xs mr-1">{r.strCategory}</span>}
              {('strAlcoholic' in r && r.strAlcoholic) && <span className="tag text-xs">{r.strAlcoholic}</span>}
            </div>
          );
          if (mode === 'browse') {
            return (
              <Link key={id} to={`/import/cocktaildb/${id}#stage`} className="group card overflow-hidden transition-colors hover:border-[var(--color-accent)]">
                {thumbEl}
                <div className="p-3 flex items-start gap-2">{meta}</div>
              </Link>
            );
          }
          return (
            <label key={id} className={`group card overflow-hidden cursor-pointer transition-colors ${selected.has(id) ? 'ring-2 ring-[var(--color-accent)]' : ''}`}>
              {thumbEl}
              <div className="p-3 flex items-start gap-2">
                <input type="checkbox" checked={selected.has(id)} onChange={() => toggleSelect(id)} className="mt-1 accent-[var(--color-accent)]" />
                {meta}
              </div>
              {selected.has(id) && selected.size > 0 && (
                <button type="button" onClick={(e) => { e.preventDefault(); handleImport(); }} className="hidden group-focus-within:block btn-primary text-xs mx-3 mb-3 w-[calc(100%-1.5rem)]">
                  Import {selected.size} selected
                </button>
              )}
            </label>
          );
        })}
      </ImportGrid>

      {mode === 'bulk' && selected.size > 0 && (
        <div className="sticky bottom-4 mt-6 flex justify-center">
          <button onClick={handleImport} disabled={importing} className="btn-primary shadow-lg">
            Import {selected.size} selected
          </button>
        </div>
      )}
    </>
  );
}

// ── Public Domain Tab ────────────────────────────────────────────────────────

function PublicDomainTab({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PDREntry[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'bulk' | 'browse'>(() => (typeof window === 'undefined' ? 'bulk' : (localStorage.getItem('import-mode-publicdomain') as 'bulk' | 'browse') || 'bulk'));
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('import-mode-publicdomain', mode); }, [mode]);

  useEffect(() => {
    setResults(searchPublicDomainRecipes(query).slice(0, 24));
  }, [query]);

  async function handleImport() {
    if (selected.size === 0) return;
    const prevFocus = captureActiveElement();
    setImporting(true);
    setImportProgress({ done: 0, total: selected.size });
    setError(null);
    const slugs = Array.from(selected);
    let done = 0, failed = 0;
    for (const slug of slugs) {
      try {
        const recipe = await fetchPublicDomainRecipe(slug);
        await gql(CREATE_MUTATION, {
          title: recipe.title, description: null, instructions: recipe.instructions,
          servings: null, prepTime: null, cookTime: null,
          tags: recipe.tags, photoUrl: recipe.imageUrl, sourceUrl: recipe.sourceUrl,
          ingredients: recipe.ingredients,
        });
      } catch (err) { console.error(`Failed to import ${slug}:`, err); failed++; }
      done++;
      setImportProgress({ done, total: slugs.length });
    }
    setImporting(false); setImportProgress(null);
    if (failed > 0 && failed === slugs.length) { setError('All imports failed.'); restoreFocus(prevFocus); }
    else if (failed > 0) { setError(`${done - failed} of ${slugs.length} imported. ${failed} failed.`); restoreFocus(prevFocus); }
    else navigate('/recipes#stage');
  }

  return (
    <>
      <fieldset className="mb-4 card p-3 text-sm">
        <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
        <div className="flex flex-wrap gap-4 px-2">
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="pdr-mode" value="browse" checked={mode === 'browse'} onChange={() => setMode('browse')} className="accent-accent" /><span>Browse &amp; Import</span></label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="pdr-mode" value="bulk" checked={mode === 'bulk'} onChange={() => setMode('bulk')} className="accent-accent" /><span>Bulk Import</span></label>
        </div>
      </fieldset>
      <div className="relative mb-6">
        <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
        <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search 408 public domain recipes..." className="field-input w-full pl-9" />
      </div>

      {error && <p role="alert" className="text-sm text-red-400 mb-4">{error}</p>}

      {results.length > 0 && (
        <>
          <ImportGrid
            importing={importing}
            importingLabel={importProgress ? `Importing ${importProgress.done}/${importProgress.total}…` : undefined}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-6"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selected.size > 0) { e.preventDefault(); handleImport(); } }}
            ariaKeyshortcuts="Meta+Enter"
          >
            {results.map((r) => {
              const isSel = selected.has(r.slug);
              const thumbBlock = r.hasImage ? (
                <div className="aspect-[16/9] overflow-hidden bg-[var(--color-bg-card)]">
                  <img src={getPublicDomainImageUrl(r.slug)} alt={r.title} className="w-full h-full object-cover" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).parentElement!.style.display = 'none'; }} />
                </div>
              ) : (
                <div className="aspect-[16/9] flex items-center justify-center bg-[var(--color-bg-card)] text-[var(--color-text-secondary)] opacity-30">
                  <CookingPot size={48} weight="light" aria-hidden />
                </div>
              );
              const meta = (
                <div className="min-w-0">
                  <p className="font-semibold text-sm leading-snug">{r.title}</p>
                  {r.tags.length > 0 && <div className="flex flex-wrap gap-1 mt-2">{r.tags.slice(0, 4).map((t) => <span key={t} className="tag">{t}</span>)}</div>}
                </div>
              );
              if (mode === 'browse') {
                return (
                  <Link key={r.slug} to={`/import/publicdomain/${r.slug}#stage`} className="group card overflow-hidden transition-colors hover:border-[var(--color-accent)]">
                    {thumbBlock}
                    <div className="p-3 flex items-start gap-3">{meta}</div>
                  </Link>
                );
              }
              return (
                <label key={r.slug} className={`group card overflow-hidden cursor-pointer transition-colors ${isSel ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]' : ''}`}>
                  {thumbBlock}
                  <div className="p-3 flex items-start gap-3">
                    <input type="checkbox" checked={isSel} onChange={() => { setSelected((p) => { const n = new Set(p); n.has(r.slug) ? n.delete(r.slug) : n.add(r.slug); return n; }); }} className="mt-1 w-4 h-4 shrink-0" />
                    {meta}
                  </div>
                  {isSel && selected.size > 0 && (
                    <button type="button" onClick={(e) => { e.preventDefault(); handleImport(); }} className="hidden group-focus-within:block btn-primary text-xs mx-3 mb-3 w-[calc(100%-1.5rem)]">
                      Import {selected.size} selected
                    </button>
                  )}
                </label>
              );
            })}
          </ImportGrid>

          {mode === 'bulk' && selected.size > 0 && (
            <div className="sticky bottom-4 z-10 flex justify-center">
              <button type="button" onClick={handleImport} disabled={importing} className="btn-primary shadow-lg">
                {importing && importProgress ? `Importing ${importProgress.done}/${importProgress.total}\u2026` : `Import Selected (${selected.size})`}
              </button>
            </div>
          )}
        </>
      )}

      {query.trim() && results.length === 0 && (
        <p className="text-[var(--color-text-secondary)] text-sm text-center py-12">No recipes found for "{query}".</p>
      )}
    </>
  );
}

// Bluesky import moved to /recipes/feeds/bluesky

function __REMOVED() {
  const [bsInput, setBsInput] = useState('');
  const [bsResults, setBsResults] = useState<{ atUri: string; recipe: BlueskyParsedRecipe }[]>([]);
  const [bsCollection, setBsCollection] = useState<{ name: string; description: string | null } | null>(null);
  const [bsSelected, setBsSelected] = useState<Set<number>>(new Set());
  const [bsSearching, setBsSearching] = useState(false);
  const [bsImporting, setBsImporting] = useState(false);
  const [bsImportProgress, setBsImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [bsError, setBsError] = useState<string | null>(null);

  async function handleBsFetch() {
    const input = bsInput.trim();
    if (!input) return;
    setBsError(null);
    setBsResults([]);
    setBsCollection(null);
    setBsSelected(new Set());
    setBsSearching(true);
    try {
      const parsed = parseAtUri(input);
      if (parsed && isRecipeUri(parsed)) {
        // Single recipe AT URI
        const recipe = await fetchBlueskyRecipe(input);
        setBsResults([{ atUri: input, recipe }]);
      } else if (parsed && isCollectionUri(parsed)) {
        // Collection (menu) AT URI — fetch metadata + each recipe
        const col = await fetchBlueskyCollection(input);
        setBsCollection({ name: col.name, description: col.description });
        const recipes: { atUri: string; recipe: BlueskyParsedRecipe }[] = [];
        for (const uri of col.recipeUris) {
          try {
            const recipe = await fetchBlueskyRecipe(uri);
            recipes.push({ atUri: uri, recipe });
          } catch { /* skip failed recipe fetches */ }
        }
        setBsResults(recipes);
      } else {
        // Treat as handle — list all their recipes
        const handle = input.replace(/^@/, '');
        const { recipes } = await listBlueskyRecipes(handle);
        setBsResults(recipes);
      }
    } catch (err) {
      setBsError((err as Error).message);
    }
    setBsSearching(false);
  }

  async function handleBsImport() {
    if (bsSelected.size === 0) return;
    const prevFocus = captureActiveElement();
    setBsImporting(true);
    setBsImportProgress({ done: 0, total: bsSelected.size });
    let done = 0;
    let failed = 0;
    const importedIds: string[] = [];
    for (const idx of bsSelected) {
      const item = bsResults[idx];
      if (!item) { done++; continue; }
      try {
        const result = await gql<{ createRecipe: { id: string } }>(CREATE_MUTATION, {
          title: item.recipe.title,
          description: item.recipe.description ?? null,
          instructions: item.recipe.instructions,
          servings: item.recipe.servings ?? null,
          prepTime: item.recipe.prepTime ?? null,
          cookTime: item.recipe.cookTime ?? null,
          tags: item.recipe.tags ?? [],
          photoUrl: item.recipe.photoUrl ?? null,
          sourceUrl: item.recipe.sourceUrl,
          ingredients: item.recipe.ingredients,
        });
        importedIds.push(result.createRecipe.id);
      } catch {
        failed++;
      }
      done++;
      setBsImportProgress({ done, total: bsSelected.size });
      if (done < bsSelected.size) await new Promise((r) => setTimeout(r, 300));
    }
    // If this was a collection import, create a menu
    if (bsCollection && importedIds.length > 0) {
      try {
        await gql(`mutation($title:String!,$description:String,$recipes:[MenuRecipeInput!]!){createMenu(title:$title,description:$description,recipes:$recipes){id}}`, {
          title: bsCollection.name,
          description: bsCollection.description,
          recipes: importedIds.map((id) => ({ recipeId: id })),
        });
      } catch { /* menu creation is best-effort */ }
    }
    setBsImporting(false);
    setBsImportProgress(null);
    if (failed > 0 && failed === bsSelected.size) { setBsError('All imports failed.'); restoreFocus(prevFocus); }
    else if (failed > 0) { setBsError(`${done - failed} of ${bsSelected.size} imported. ${failed} failed.`); restoreFocus(prevFocus); }
    else navigate('/recipes#stage');
  }

  return (
    <>
      <div className="mb-4">
        <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1.5">AT URI or Bluesky handle</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={bsInput}
            onChange={(e) => setBsInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleBsFetch(); }}
            placeholder="at://did:plc:.../exchange.recipe.recipe/... or @handle"
            className="flex-1 px-3 py-2 text-sm border border-[var(--color-border-card)] bg-[var(--color-bg-card)] rounded"
          />
          <button
            type="button"
            onClick={handleBsFetch}
            disabled={bsSearching || !bsInput.trim()}
            className="btn-primary text-sm disabled:opacity-50"
          >
            {bsSearching ? 'Fetching\u2026' : 'Fetch'}
          </button>
        </div>
      </div>

      {bsError && <p role="alert" className="text-sm text-[var(--color-danger)] mb-4">{bsError}</p>}

      {bsCollection && (
        <p className="text-sm text-[var(--color-text-secondary)] mb-4">
          Collection: <strong>{bsCollection.name}</strong>
          {bsCollection.description && <> &mdash; {bsCollection.description}</>}
        </p>
      )}

      {bsResults.length > 0 && (
        <>
          <ImportGrid
            importing={bsImporting}
            importingLabel={bsImportProgress ? `Importing ${bsImportProgress.done}/${bsImportProgress.total}\u2026` : undefined}
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4"
          >
            {bsResults.map((r, i) => {
              const selected = bsSelected.has(i);
              return (
                <label key={i} className={`card p-4 cursor-pointer flex flex-col gap-2 transition-colors ${selected ? 'border-accent' : ''}`}>
                  <div className="flex items-start gap-3">
                    <input type="checkbox" checked={selected} onChange={() => setBsSelected((prev) => { const next = new Set(prev); next.has(i) ? next.delete(i) : next.add(i); return next; })} className="mt-1 w-4 h-4 accent-accent shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm leading-snug">{r.recipe.title}</p>
                      {r.recipe.description && <p className="text-xs text-[var(--color-text-secondary)] mt-1 line-clamp-2">{r.recipe.description}</p>}
                    </div>
                  </div>
                  {r.recipe.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {r.recipe.tags.slice(0, 5).map((t) => <span key={t} className="tag text-[10px]">{t}</span>)}
                    </div>
                  )}
                </label>
              );
            })}
          </ImportGrid>
          {bsSelected.size > 0 && (
            <div className="text-center">
              <button type="button" onClick={handleBsImport} disabled={bsImporting} className="btn-primary">
                {bsCollection ? `Import ${bsSelected.size} as Menu` : `Import ${bsSelected.size} selected`}
              </button>
            </div>
          )}
        </>
      )}

      <p className="text-xs text-[var(--color-text-secondary)] mt-8 text-center pretty">
        Powered by the <a href="https://atproto.com" target="_blank" rel="noopener noreferrer" className="underline">AT Protocol</a>.
        Recipes use the <a href="https://recipe.exchange/lexicons/" target="_blank" rel="noopener noreferrer" className="underline">exchange.recipe</a> lexicon.
      </p>
    </>
  );
}

// ── Main Import Page ────────────────────────────────────────────────────────

const ALL_TAB_ORDER: Tab[] = ['url', 'mealdb', 'publicdomain', 'recipe-api', 'cooklang', 'wikibooks', 'cocktaildb'];
const TAB_LABELS: Record<Tab, string> = {
  url: 'URL',
  mealdb: 'TheMealDB',
  publicdomain: 'Public Domain',
  cooklang: 'Cooklang',
  wikibooks: 'Wikibooks',
  cocktaildb: 'TheCocktailDB',
  'recipe-api': 'Recipe API',
};

export default function RecipeImportPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Honor the Settings-page toggle for TheCocktailDB.
  const [showCocktailDB, setShowCocktailDB] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('show-cocktaildb') !== 'false';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.key === 'show-cocktaildb') {
        setShowCocktailDB(e.newValue !== 'false');
      }
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  const TAB_ORDER: Tab[] = ALL_TAB_ORDER.filter((k) => k !== 'cocktaildb' || showCocktailDB);
  const urlTab = searchParams.get('tab');
  const [tab, setTab] = useState<Tab>(() => {
    if (urlTab && ALL_TAB_ORDER.includes(urlTab as Tab)) return urlTab as Tab;
    return 'url';
  });

  // When the user uploads a file, its contents are pushed into the URL tab's
  // textarea and the tab switches. Uploaded content changes the key so URLTab
  // re-syncs its internal state via the initialText prop. Also seeded from
  // `?url=` query param so /https/*'s error-fallback CTA pre-fills manual import.
  const [uploadedContent, setUploadedContent] = useState<string | undefined>(() => {
    const u = searchParams.get('url');
    return u ? u : undefined;
  });

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setUploadedContent(reader.result);
        setTab('url');
      }
    };
    reader.readAsText(file);
  }

  const handleTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const idx = TAB_ORDER.indexOf(tab);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % TAB_ORDER.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TAB_ORDER.length - 1;
    else return;
    e.preventDefault();
    const nextTab = TAB_ORDER[next];
    setTab(nextTab);
    requestAnimationFrame(() => {
      const el = document.getElementById(`tab-${nextTab}`);
      el?.focus();
      el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  };

  return (
    <div>
      <Link to="/recipes#stage" className="text-sm text-[var(--color-text-secondary)] hover:underline mb-4 inline-block">
        &larr; Back to recipes
      </Link>

      <Link to="/recipes/feeds/bluesky" className="mb-6 flex items-center gap-4 card p-4 rounded-xl hover:border-[var(--color-accent)] transition-colors">
        <svg fill="currentColor" viewBox="0 0 600 530" width={32} height={28} aria-hidden="true" className="shrink-0 opacity-60" xmlns="http://www.w3.org/2000/svg">
          <path d="M135.72 44.03C202.216 93.951 273.74 195.17 299.91 249.49c26.17-54.32 97.694-155.539 164.19-205.46C512.18 8.005 590 -19.728 590 69.04c0 17.726-10.155 148.928-16.111 170.208-20.703 73.984-96.144 92.854-163.25 81.433 117.262 19.96 147.131 86.084 82.654 152.208-122.385 125.621-175.86-31.511-189.563-71.807-2.512-7.387-3.687-10.832-3.69-7.905-.003-2.927-1.179.518-3.69 7.905-13.704 40.296-67.18 197.428-189.563 71.807-64.477-66.124-34.61-132.251 82.65-152.208-67.105 11.421-142.548-7.45-163.25-81.433C20.232 217.968 10.077 86.766 10.077 69.04c0-88.768 77.82-61.035 125.9-25.01z" />
        </svg>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm">Browse recipes from Bluesky</p>
          <p className="text-xs text-[var(--color-text-secondary)]">Discover recipes shared on AT Protocol by the community</p>
        </div>
      </Link>

      <h1 className="text-3xl font-bold mb-2">Import Recipes</h1>
      <p className="text-sm text-[var(--color-text-secondary)] mb-6 legible pretty">
        Search community recipe datasources and import into your local pantry.
      </p>

      {/* Upload a file — mirrors the self-hosted app's layout */}
      <div className="p-6 mb-6 border border-[var(--color-border-card)] bg-[var(--color-bg-card)] rounded-xl">
        <h2 className="text-lg font-bold mb-1">Upload a file</h2>
        <p className="text-sm text-[var(--color-text-secondary)] mb-4 legible pretty">
          Choose a recipe <span className="font-mono text-xs">.html</span> or provide bookmarks in <span className="font-mono text-xs">.html</span>,
          <span className="font-mono text-xs"> .csv</span>, or a plain URL list as <span className="font-mono text-xs">.txt</span>
        </p>
        <label className="block">
          <span className="sr-only">Choose file</span>
          <input
            type="file"
            accept=".html,.csv,.txt"
            onChange={handleFileUpload}
            className="block w-full text-sm text-[var(--color-text-secondary)]
              file:mr-4 file:py-2 file:px-4 file:border-0
              file:text-sm file:font-medium
              file:bg-[var(--color-accent-subtle)]
              file:text-[var(--color-text-primary)]
              hover:file:bg-[var(--color-border-card)]
              cursor-pointer"
          />
        </label>
      </div>

      {/* Tab toggle */}
      <div className="flex gap-1 mb-6 border-b border-[var(--color-border-card)] overflow-x-auto" role="tablist" aria-label="Recipe sources">
        {TAB_ORDER.map((key) => {
          const active = tab === key;
          return (
            <button
              key={key}
              id={`tab-${key}`}
              role="tab"
              aria-selected={active}
              aria-controls={`tabpanel-${key}`}
              tabIndex={active ? 0 : -1}
              onKeyDown={handleTabKeyDown}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors ${active ? 'border-[var(--color-accent)] text-[var(--color-accent)]' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
            >
              {TAB_LABELS[key]}
            </button>
          );
        })}
      </div>

      {tab === 'url' && <div role="tabpanel" id="tabpanel-url" aria-labelledby="tab-url"><URLTab navigate={navigate} initialText={uploadedContent} /></div>}
      {tab === 'mealdb' && <div role="tabpanel" id="tabpanel-mealdb" aria-labelledby="tab-mealdb"><MealDBTab navigate={navigate} /></div>}
      {tab === 'publicdomain' && <div role="tabpanel" id="tabpanel-publicdomain" aria-labelledby="tab-publicdomain"><PublicDomainTab navigate={navigate} /></div>}
      {tab === 'cooklang' && <div role="tabpanel" id="tabpanel-cooklang" aria-labelledby="tab-cooklang"><CooklangTab navigate={navigate} /></div>}
      {tab === 'wikibooks' && <div role="tabpanel" id="tabpanel-wikibooks" aria-labelledby="tab-wikibooks"><WikibooksTab navigate={navigate} /></div>}
      {tab === 'cocktaildb' && <div role="tabpanel" id="tabpanel-cocktaildb" aria-labelledby="tab-cocktaildb"><CocktailDBTab navigate={navigate} /></div>}
      {tab === 'recipe-api' && <div role="tabpanel" id="tabpanel-recipe-api" aria-labelledby="tab-recipe-api"><RecipeAPITab navigate={navigate} /></div>}

      <CommunityDatasources />
    </div>
  );
}

// ── Wikibooks Tab ────────────────────────────────────────────────────────────

function WikibooksTab({ navigate }: { navigate: (path: string) => void }) {
  const [downloaded, setDownloaded] = useState<boolean | null>(null);
  const [data, setData] = useState<WikibooksEntry[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [mode, setMode] = useState<'bulk' | 'browse'>(() => (typeof window === 'undefined' ? 'bulk' : (localStorage.getItem('import-mode-wikibooks') as 'bulk' | 'browse') || 'bulk'));
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('import-mode-wikibooks', mode); }, [mode]);

  // Check if already downloaded on mount
  useEffect(() => {
    isWikibooksDownloaded().then(async (yes) => {
      setDownloaded(yes);
      if (yes) {
        const loaded = await loadWikibooksData();
        if (loaded) setData(loaded);
      }
    });
  }, []);

  async function handleDownload() {
    setDownloading(true);
    setDownloadError(null);
    try {
      const entries = await downloadWikibooksDataset((done, total) => {
        setProgress({ done, total });
      });
      setData(entries);
      setDownloaded(true);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  }

  function toggleSelect(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug); else next.add(slug);
      return next;
    });
  }

  async function handleImport() {
    const toImport = data.filter((r) => selected.has(r.slug));
    if (toImport.length === 0) return;
    const prevFocus = captureActiveElement();
    setImporting(true);
    setImportProgress({ done: 0, total: toImport.length });
    let failed = 0;

    for (let i = 0; i < toImport.length; i++) {
      const r = toImport[i];
      try {
        await gql(CREATE_MUTATION, {
          title: r.title,
          description: null,
          instructions: r.instructions,
          servings: r.servings,
          prepTime: null,
          cookTime: null,
          tags: r.tags,
          photoUrl: null,
          sourceUrl: r.sourceUrl,
          ingredients: r.ingredients.map(parseIngredientLine),
        });
      } catch { failed++; }
      setImportProgress({ done: i + 1, total: toImport.length });
      if (i < toImport.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }

    setImporting(false);
    setSelected(new Set());
    setImportProgress(null);
    if (failed > 0) restoreFocus(prevFocus);
    else navigate('/recipes#stage');
  }

  const results = query ? searchWikibooks(query, data).slice(0, 48) : data.slice(0, 48);

  // Pre-download state
  if (downloaded === null) return <div className="h-40 rounded-xl bg-[var(--color-bg-card)] animate-pulse" />;

  if (!downloaded && !downloading) {
    return (
      <div className="text-center py-12">
        <p className="text-[var(--color-text-secondary)] mb-2">
          Browse 3,900 public domain recipes offline.
        </p>
        <p className="text-[var(--color-text-secondary)] text-sm mb-6">
          Download once and store locally in your browser.
        </p>
        <button onClick={handleDownload} className="btn-primary inline-flex items-center gap-2">
          <DownloadSimple size={18} aria-hidden />
          Download Wikibooks Cookbook (~30MB)
        </button>
        {downloadError && <p className="text-sm text-red-500 mt-4">{downloadError}</p>}
      </div>
    );
  }

  if (downloading) {
    return (
      <div className="text-center py-12">
        <p className="text-[var(--color-text-secondary)] mb-4">Downloading Wikibooks Cookbook…</p>
        {progress && (
          <>
            <div className="w-full max-w-md mx-auto h-2 rounded-full bg-[var(--color-bg-card)] overflow-hidden mb-2">
              <div
                className="h-full bg-[var(--color-accent)] transition-all"
                style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
              />
            </div>
            <p className="text-xs text-[var(--color-text-secondary)]">
              {progress.done} of {progress.total} batches
            </p>
          </>
        )}
        {downloadError && <p className="text-sm text-red-500 mt-4">{downloadError}</p>}
      </div>
    );
  }

  // Post-download: search + browse
  return (
    <>
      <fieldset className="mb-4 card p-3 text-sm">
        <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
        <div className="flex flex-wrap gap-4 px-2">
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="wb-mode" value="browse" checked={mode === 'browse'} onChange={() => setMode('browse')} className="accent-accent" /><span>Browse &amp; Import</span></label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="wb-mode" value="bulk" checked={mode === 'bulk'} onChange={() => setMode('bulk')} className="accent-accent" /><span>Bulk Import</span></label>
        </div>
      </fieldset>
      <div className="mb-4">
        <div className="relative">
          <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search recipes…"
            className="field-input w-full pl-9"
          />
        </div>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1">
          {data.length.toLocaleString()} recipes available · Showing {results.length}
        </p>
      </div>

      {importProgress && (
        <div className="mb-4 p-3 card text-sm text-center">
          Importing {importProgress.done} of {importProgress.total}…
        </div>
      )}

      <ImportGrid
        importing={importing}
        importingLabel={importProgress ? `Importing ${importProgress.done}/${importProgress.total}…` : undefined}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
        onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selected.size > 0) { e.preventDefault(); handleImport(); } }}
        ariaKeyshortcuts="Meta+Enter"
      >
        {results.map((r) => {
          const meta = (
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">{r.title}</p>
              <div className="flex flex-wrap gap-1 mt-1">
                {r.tags.filter((t) => t !== 'wikibooks').slice(0, 3).map((t) => (
                  <span key={t} className="tag text-xs">{t}</span>
                ))}
                {r.difficulty != null && (
                  <span className="text-xs text-[var(--color-text-secondary)]">
                    {'★'.repeat(r.difficulty)}{'☆'.repeat(5 - r.difficulty)}
                  </span>
                )}
              </div>
              {(r.servings || r.time) && (
                <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                  {[r.servings && `${r.servings} servings`, r.time].filter(Boolean).join(' · ')}
                </p>
              )}
            </div>
          );
          if (mode === 'browse') {
            return (
              <Link key={r.slug} to={`/import/wikibooks/${r.slug}#stage`} className="group card p-4 transition-colors hover:border-[var(--color-accent)]">
                <div className="flex items-start gap-3">{meta}</div>
              </Link>
            );
          }
          return (
            <label
              key={r.slug}
              className={`group card p-4 cursor-pointer transition-colors ${selected.has(r.slug) ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  checked={selected.has(r.slug)}
                  onChange={() => toggleSelect(r.slug)}
                  className="mt-1 accent-[var(--color-accent)]"
                />
                {meta}
              </div>
              {selected.has(r.slug) && selected.size > 0 && (
                <button type="button" onClick={(e) => { e.preventDefault(); handleImport(); }} className="hidden group-focus-within:block btn-primary text-xs mt-2 w-full">
                  Import {selected.size} selected
                </button>
              )}
            </label>
          );
        })}
      </ImportGrid>

      {mode === 'bulk' && selected.size > 0 && (
        <div className="sticky bottom-4 mt-6 flex justify-center">
          <button onClick={handleImport} disabled={importing} className="btn-primary shadow-lg">
            Import {selected.size} selected
          </button>
        </div>
      )}

      <p className="text-xs text-[var(--color-text-secondary)] mt-6 text-center">
        Recipes from <a href="https://en.wikibooks.org/wiki/Cookbook" className="underline" rel="noopener noreferrer">Wikibooks Cookbook</a> · CC-BY-SA-4.0
      </p>
    </>
  );
}

// ── Recipe API Tab ──────────────────────────────────────────────────────────
//
// recipe-api.com is a paid JSON API requiring an X-API-Key header (free tier
// exists — 100 req/day, 10 req/min). Users bring their own key: we store it
// in localStorage under 'recipe-api-key'. When no key is present we render a
// small input form; once saved we flip to the search UI.
//
// The list/search response does NOT include image URLs, so cards are
// text-only (name, category, cuisine, difficulty, calorie summary). That
// means zero per-card probe requests — we only fetch a full recipe when the
// user actually imports it.

function RecipeAPITab({ navigate }: { navigate: ReturnType<typeof useNavigate> }) {
  const [apiKey, setApiKey] = useState<string>(() =>
    typeof window !== 'undefined' ? (localStorage.getItem(RECIPE_API_KEY_STORAGE) ?? '') : ''
  );
  const [keyInput, setKeyInput] = useState('');
  // Re-read if Settings page saves a new key (dispatches a synthetic storage event).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: StorageEvent) => {
      if (e.key === RECIPE_API_KEY_STORAGE) setApiKey(e.newValue ?? '');
    };
    window.addEventListener('storage', handler);
    return () => window.removeEventListener('storage', handler);
  }, []);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [categories, setCategories] = useState<RecipeAPICategoryCount[]>([]);
  const [results, setResults] = useState<RecipeAPIListItem[]>([]);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  const [mode, setMode] = useState<'bulk' | 'browse'>(() => (typeof window === 'undefined' ? 'bulk' : (localStorage.getItem('import-mode-recipe-api') as 'bulk' | 'browse') || 'bulk'));
  useEffect(() => { if (typeof window !== 'undefined') localStorage.setItem('import-mode-recipe-api', mode); }, [mode]);

  useEffect(() => {
    if (!apiKey) return;
    getRecipeAPICategories(apiKey).then(setCategories).catch(() => {});
  }, [apiKey]);

  const runSearch = useCallback(
    async (q: string, cat: string) => {
      if (!apiKey) return;
      setSearching(true);
      setError(null);
      try {
        const res = await searchRecipeAPI({ q: q || undefined, category: cat || undefined, per_page: 12 }, apiKey);
        setResults(res.data);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('429')) setError('Rate limit reached. Try again in a moment.');
        else if (msg.includes('401') || msg.includes('403')) setError('API key rejected. Check your key and try again.');
        else setError(`Search failed: ${msg}`);
        setResults([]);
      } finally {
        setSearching(false);
      }
    },
    [apiKey],
  );

  useEffect(() => {
    clearTimeout(debounceRef.current);
    const q = query.trim();
    if (!q && !category) { setResults([]); return; }
    if (q && q.length < 3) return; // min query length — don't hammer the API
    debounceRef.current = setTimeout(() => runSearch(q, category), 600);
    return () => clearTimeout(debounceRef.current);
  }, [query, category, runSearch]);

  async function handleImport() {
    if (!apiKey || selected.size === 0) return;
    const prevFocus = captureActiveElement();
    setImporting(true);
    setImportProgress({ done: 0, total: selected.size });
    setError(null);
    const ids = Array.from(selected);
    let done = 0;
    let failed = 0;
    let quotaHit: RecipeAPIError | null = null;
    for (const id of ids) {
      try {
        const full = await getRecipeAPIRecipe(id, apiKey);
        const recipe = recipeApiToParsed(full);
        await gql(CREATE_MUTATION, {
          title: recipe.title,
          description: recipe.description ?? null,
          instructions: recipe.instructions,
          servings: recipe.servings ?? null,
          prepTime: recipe.prepTime ?? null,
          cookTime: recipe.cookTime ?? null,
          tags: recipe.tags ?? [],
          photoUrl: recipe.photoUrl ?? null,
          sourceUrl: recipe.sourceUrl ?? null,
          ingredients: recipe.ingredients,
        });
      } catch (err) {
        console.error(`Failed to import recipe ${id}:`, err);
        failed++;
        if (err instanceof RecipeAPIError && err.code === 'UNIQUE_RECIPE_LIMIT_EXCEEDED') {
          quotaHit = err;
          done++;
          setImportProgress({ done, total: ids.length });
          break;
        }
      }
      done++;
      setImportProgress({ done, total: ids.length });
      if (done < ids.length) await new Promise((r) => setTimeout(r, 1200));
    }
    setImporting(false);
    setImportProgress(null);
    if (quotaHit) {
      const imported = done - failed;
      const prefix = imported > 0 ? `Imported ${imported} before hitting the limit. ` : '';
      setError(`${prefix}Monthly quota reached — recipe-api.com's free tier allows 25 unique recipes per billing period. Resets on the 1st, or upgrade at recipe-api.com/pricing.`);
      restoreFocus(prevFocus);
    }
    else if (failed > 0 && failed === ids.length) { setError('All imports failed. Try again in a minute.'); restoreFocus(prevFocus); }
    else if (failed > 0) { setError(`${done - failed} of ${ids.length} imported. ${failed} failed.`); restoreFocus(prevFocus); }
    else navigate('/recipes#stage');
  }

  if (!apiKey) {
    return (
      <div className="max-w-md mx-auto text-center py-8">
        <h2 className="text-xl font-bold mb-2">Recipe API</h2>
        <p className="text-sm text-[var(--color-text-secondary)] mb-4 legible pretty">
          <a href="https://recipe-api.com" target="_blank" rel="noopener noreferrer" className="underline">recipe-api.com</a>
          {' '}is a JSON API with structured ingredients, USDA nutrition data, and
          dietary flags. A free tier is available (100 requests/day) — grab a key
          from{' '}
          <a href="https://recipe-api.com/pricing" target="_blank" rel="noopener noreferrer" className="underline">recipe-api.com/pricing</a>
          {' '}and paste it below. The key stays in your browser; it is never sent
          to a Pantry&nbsp;Host server.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const k = keyInput.trim();
            if (!k) return;
            localStorage.setItem(RECIPE_API_KEY_STORAGE, k);
            setApiKey(k);
            setKeyInput('');
            // Mirror the Settings page's synthetic storage event so other
            // listeners (this same tab's other components) can react.
            try {
              window.dispatchEvent(
                new StorageEvent('storage', {
                  key: RECIPE_API_KEY_STORAGE,
                  newValue: k,
                  storageArea: localStorage,
                }),
              );
            } catch { /* legacy webview without StorageEvent constructor */ }
          }}
          className="flex flex-col gap-3"
        >
          <label htmlFor="recipe-api-key-input" className="sr-only">API key</label>
          <input
            id="recipe-api-key-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="rapi_..."
            className="field-input w-full"
          />
          <button type="submit" disabled={!keyInput.trim()} className="btn-primary">
            Save key
          </button>
        </form>
        <p className="mt-4 text-xs text-[var(--color-text-secondary)]">
          Or manage all your keys on the{' '}
          <Link to="/settings#stage" className="underline">Settings page</Link>.
        </p>
      </div>
    );
  }

  return (
    <>
      <fieldset className="mb-4 card p-3 text-sm">
        <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
        <div className="flex flex-wrap gap-4 px-2">
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="ra-mode" value="browse" checked={mode === 'browse'} onChange={() => setMode('browse')} className="accent-accent" /><span>Browse &amp; Import</span></label>
          <label className="flex items-center gap-2 cursor-pointer"><input type="radio" name="ra-mode" value="bulk" checked={mode === 'bulk'} onChange={() => setMode('bulk')} className="accent-accent" /><span>Bulk Import</span></label>
        </div>
      </fieldset>
      <div className="flex flex-col sm:flex-row gap-3 mb-6 sm:items-end">
        <div className="flex-1">
          <label htmlFor="recipe-api-search" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Search</label>
          <div className="relative">
            <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
            <input
              id="recipe-api-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="lentil soup"
              className="field-input w-full pl-9"
            />
          </div>
        </div>
        <div>
          <label htmlFor="recipe-api-category" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Category</label>
          <select
            id="recipe-api-category"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="field-select w-full sm:w-auto"
          >
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.slug} value={c.slug}>
                {c.name} ({c.count})
              </option>
            ))}
          </select>
        </div>
      </div>

      {error && <p role="alert" className="text-sm text-red-400 mb-4">{error}</p>}

      {searching && results.length === 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="h-32 rounded-xl bg-[var(--color-bg-card)] animate-pulse" />)}
        </div>
      )}

      {importProgress && (
        <p className="text-sm text-[var(--color-text-secondary)] mb-4">
          Importing {importProgress.done} of {importProgress.total}…
        </p>
      )}

      {results.length > 0 && (
        <ImportGrid
          importing={importing}
          importingLabel={importProgress ? `Importing ${importProgress.done}/${importProgress.total}…` : undefined}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && selected.size > 0) {
              e.preventDefault();
              handleImport();
            }
          }}
          ariaKeyshortcuts="Meta+Enter"
        >
          {results.map((r) => {
            const isSelected = selected.has(r.id);
            const meta = (
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-sm leading-snug">{r.name}</p>
                <div className="flex flex-wrap gap-1 mt-2">
                  {r.category && <span className="tag">{r.category}</span>}
                  {r.cuisine && <span className="tag">{r.cuisine}</span>}
                  {r.difficulty && <span className="tag">{r.difficulty}</span>}
                  {r.dietary?.flags?.slice(0, 2).map((f) => <span key={f} className="tag">{f}</span>)}
                </div>
                {r.nutrition_summary?.calories != null && (
                  <p className="text-xs text-[var(--color-text-secondary)] mt-2">
                    {Math.round(r.nutrition_summary.calories)} kcal · {Math.round(r.nutrition_summary.protein_g ?? 0)}g protein
                  </p>
                )}
              </div>
            );
            if (mode === 'browse') {
              return (
                <Link key={r.id} to={`/import/recipe-api/${r.id}#stage`} className="group card p-4 transition-colors hover:border-[var(--color-accent)]">
                  <div className="flex items-start gap-3">{meta}</div>
                </Link>
              );
            }
            return (
              <label
                key={r.id}
                className={`group card p-4 cursor-pointer transition-colors ${isSelected ? 'border-[var(--color-accent)] bg-[var(--color-accent-subtle)]' : ''}`}
              >
                <div className="flex items-start gap-3">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => {
                      setSelected((p) => {
                        const n = new Set(p);
                        if (n.has(r.id)) n.delete(r.id);
                        else n.add(r.id);
                        return n;
                      });
                    }}
                    className="mt-1 w-4 h-4 shrink-0"
                  />
                  {meta}
                </div>
                {isSelected && selected.size > 0 && (
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); handleImport(); }}
                    className="hidden group-focus-within:block btn-primary text-xs mt-3 w-full"
                  >
                    Import {selected.size} selected
                  </button>
                )}
              </label>
            );
          })}
        </ImportGrid>
      )}

      {mode === 'bulk' && selected.size > 0 && !importProgress && (
        <div className="sticky bottom-4 flex justify-end">
          <button type="button" onClick={handleImport} disabled={importing} className="btn-primary shadow-lg">
            Import {selected.size} selected
          </button>
        </div>
      )}

      {!searching && query.trim().length >= 3 && results.length === 0 && !error && (
        <p className="text-[var(--color-text-secondary)] text-sm text-center py-8">
          No recipes found for &ldquo;{query}&rdquo;.
        </p>
      )}

      <p className="text-xs text-[var(--color-text-secondary)] mt-8 text-center">
        Powered by <a href="https://recipe-api.com" target="_blank" rel="noopener noreferrer" className="underline">recipe-api.com</a>.
        {' '}
        <Link to="/settings#stage" className="underline">Manage key in Settings</Link>
      </p>
    </>
  );
}

// ── URL Import Tab ──────────────────────────────────────────────────────────

const FEED_FETCH_URL = 'https://feed.pantryhost.app/api/fetch-recipe';

interface URLImportItem {
  url: string;
  status: 'pending' | 'fetching' | 'done' | 'failed';
  recipe?: { title: string; description?: string; instructions?: string; servings?: number; prepTime?: number; cookTime?: number; tags?: string[]; photoUrl?: string; sourceUrl?: string; ingredients: { ingredientName: string; quantity: number | null; unit: string | null }[] };
  error?: string;
  skip?: boolean;
}

function URLTab({ navigate, initialText }: { navigate: (path: string) => void; initialText?: string }) {
  const [pasteText, setPasteText] = useState(initialText ?? '');
  const [items, setItems] = useState<URLImportItem[]>([]);
  const [step, setStep] = useState<'paste' | 'parsing' | 'fetching' | 'review' | 'saving' | 'done'>('paste');
  const [saveProgress, setSaveProgress] = useState(0);

  // When parent pushes file contents, overwrite the textarea.
  useEffect(() => {
    if (initialText) {
      setPasteText(initialText);
      setStep('paste');
      setItems([]);
    }
  }, [initialText]);

  async function handleParse() {
    // Offload parsing to a web worker — large Pantry Host exports or
    // multi-MB bookmarks files would otherwise block the main thread.
    setStep('parsing');
    const { exported, urls } = await parseImport(pasteText);

    if (exported) {
      setItems(exported.map((r) => ({
        url: r.sourceUrl ?? r.title,
        status: 'done' as const,
        recipe: { ...r, instructions: r.instructions ?? '', ingredients: r.ingredients ?? [] },
      })));
      setStep('review');
      return;
    }

    if (urls.length === 0) {
      setStep('paste');
      return;
    }
    const initial: URLImportItem[] = urls.map((url) => ({ url, status: 'pending' }));
    setItems(initial);
    setStep('fetching');
    fetchAll(initial);
  }

  async function fetchAll(initialItems: URLImportItem[]) {
    const BATCH = 3;
    const updated = [...initialItems];

    for (let i = 0; i < updated.length; i += BATCH) {
      const batch = updated.slice(i, i + BATCH);
      await Promise.allSettled(
        batch.map(async (item, batchIdx) => {
          const idx = i + batchIdx;
          updated[idx] = { ...updated[idx], status: 'fetching' };
          setItems([...updated]);

          try {
            let data: URLImportItem['recipe'];
            if (item.url.startsWith('at://')) {
              // AT URIs fetched client-side (bsky.social has open CORS)
              const bsky = await fetchBlueskyRecipe(item.url);
              data = { ...bsky, instructions: bsky.instructions ?? '', ingredients: bsky.ingredients ?? [] };
            } else {
              const res = await fetch(FEED_FETCH_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: item.url }),
              });
              const json = await res.json();
              if (!res.ok || json.error) throw new Error(json.error ?? `HTTP ${res.status}`);
              if (!json.title) throw new Error('No recipe data found on this page');
              data = { ...json, sourceUrl: item.url, ingredients: json.ingredients ?? [] };
            }
            updated[idx] = { ...updated[idx], status: 'done', recipe: data };
          } catch (err) {
            updated[idx] = { ...updated[idx], status: 'failed', error: (err as Error).message };
          }
          setItems([...updated]);
        }),
      );
    }
    setStep('review');
  }

  async function handleSave() {
    setStep('saving');
    const toSave = items.filter((i) => i.status === 'done' && !i.skip && i.recipe);
    let saved = 0;
    for (const item of toSave) {
      const r = item.recipe!;
      try {
        await gql(CREATE_MUTATION, {
          title: r.title,
          description: r.description ?? null,
          instructions: r.instructions || 'See source for instructions.',
          servings: r.servings ?? null,
          prepTime: r.prepTime ?? null,
          cookTime: r.cookTime ?? null,
          tags: r.tags ?? [],
          photoUrl: r.photoUrl ?? null,
          sourceUrl: r.sourceUrl ?? null,
          ingredients: r.ingredients.map((i) => ({
            ingredientName: i.ingredientName,
            quantity: i.quantity ?? null,
            unit: i.unit ?? null,
          })),
        });
        saved++;
        setSaveProgress(saved);
      } catch (err) {
        console.error('Save failed for', r.title, err);
      }
      // Throttle
      if (saved < toSave.length) await new Promise((r) => setTimeout(r, 300));
    }
    setStep('done');
  }


  if (step === 'done') {
    const saved = items.filter((i) => i.status === 'done' && !i.skip).length;
    return (
      <div className="text-center py-8">
        <p className="text-lg font-semibold mb-2">Imported {saved} recipe{saved !== 1 ? 's' : ''}</p>
        <Link to="/recipes#stage" className="text-accent hover:underline">View recipes →</Link>
        <button onClick={() => { setStep('paste'); setPasteText(''); setItems([]); }} className="block mx-auto mt-4 text-sm text-[var(--color-text-secondary)] hover:underline">
          Import more
        </button>
      </div>
    );
  }

  if (step === 'parsing') {
    return (
      <div className="text-center py-8">
        <p className="text-sm text-[var(--color-text-secondary)] animate-pulse">Parsing…</p>
      </div>
    );
  }

  if (step === 'saving') {
    const total = items.filter((i) => i.status === 'done' && !i.skip).length;
    return (
      <div className="text-center py-8">
        <p className="text-sm text-[var(--color-text-secondary)]">Saving {saveProgress} of {total}…</p>
      </div>
    );
  }

  if (step === 'review' || step === 'fetching') {
    const doneCount = items.filter((i) => i.status === 'done').length;
    const failedCount = items.filter((i) => i.status === 'failed').length;
    const saveable = items.filter((i) => i.status === 'done' && !i.skip).length;

    return (
      <div>
        <p className="text-sm text-[var(--color-text-secondary)] mb-4">
          {step === 'fetching' ? 'Fetching recipes…' : `${doneCount} found, ${failedCount} failed`}
        </p>

        <div className="space-y-3 mb-6">
          {items.map((item, idx) => (
            <div key={idx} className={`card p-4 ${item.skip ? 'opacity-50' : ''}`}>
              <div className="flex items-start gap-3">
                {item.status === 'done' && (
                  <input
                    type="checkbox"
                    checked={!item.skip}
                    onChange={() => setItems((prev) => prev.map((it, i) => i === idx ? { ...it, skip: !it.skip } : it))}
                    className="mt-1 w-4 h-4 accent-accent shrink-0"
                  />
                )}
                <div className="flex-1 min-w-0">
                  {item.status === 'fetching' && <p className="text-sm animate-pulse">Fetching…</p>}
                  {item.status === 'pending' && <p className="text-sm text-[var(--color-text-secondary)]">Waiting…</p>}
                  {item.status === 'done' && item.recipe && (
                    <>
                      <p className="font-semibold text-sm">{item.recipe.title}</p>
                      {item.recipe.description && (
                        <p className="text-xs text-[var(--color-text-secondary)] mt-1 line-clamp-2">{item.recipe.description}</p>
                      )}
                      <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                        {item.recipe.ingredients.length} ingredients
                      </p>
                    </>
                  )}
                  {item.status === 'failed' && (
                    <p className="text-sm text-red-400">{item.error}</p>
                  )}
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1 truncate">{item.url}</p>
                </div>
              </div>
            </div>
          ))}
        </div>

        {step === 'review' && saveable > 0 && (
          <button onClick={handleSave} className="btn-primary">
            Import {saveable} recipe{saveable !== 1 ? 's' : ''}
          </button>
        )}

        <button onClick={() => { setStep('paste'); setItems([]); }} className="btn-secondary ml-3">
          Start over
        </button>
      </div>
    );
  }

  return (
    <>
      <p className="text-sm text-[var(--color-text-secondary)] mb-3 legible pretty">
        Paste recipe URLs (one per line) or AT Protocol URIs (<code className="text-xs">at://</code>). You can also upload a bookmarks file (.html) or CSV.
      </p>
      <textarea
        value={pasteText}
        onChange={(e) => setPasteText(e.target.value)}
        rows={6}
        placeholder={"https://www.allrecipes.com/recipe/...\nat://did:plc:.../exchange.recipe.recipe/...\nhttps://www.seriouseats.com/..."}
        className="field-input w-full mb-3 font-mono text-sm"
      />
      <button
        onClick={handleParse}
        disabled={!pasteText.trim()}
        className="btn-primary text-sm"
      >
        Parse URLs →
      </button>
    </>
  );
}
