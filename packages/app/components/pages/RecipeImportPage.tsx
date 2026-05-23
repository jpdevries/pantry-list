import Head from 'next/head';
import { useState, useRef, useEffect, useCallback } from 'react';
import { useRouter } from 'next/router';
import { gql } from '@/lib/gql';
import { isApiOnline, API_STATUS_EVENT } from '@/lib/apiStatus';
import { apiUrl } from '@/lib/apiUrl';
import { useKitchen } from '@/lib/kitchen-context';
import {
  searchFederationRecipes,
  getFederationRecipe,
  cooklangToRecipe,
  type FederationSearchResult,
  type FederationPagination,
  type FederationRecipe,
} from '@pantry-host/shared/cooklang';
import { isBrowser, isServer } from '@pantry-host/shared/env';
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
import { MagnifyingGlass, CookingPot } from '@phosphor-icons/react';
import { parseIngredientLine, type WikibooksEntry } from '@pantry-host/shared/wikibooks';
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
import {
  searchRecipeAPI,
  getRecipeAPIRecipe,
  getRecipeAPICategories,
  recipeApiToParsed,
  RecipeAPIError,
  type RecipeAPIListItem,
  type RecipeAPICategoryCount,
} from '@pantry-host/shared/recipe-api';
import CommunityDatasources from '@pantry-host/shared/components/CommunityDatasources';
import ImportGrid, { captureActiveElement, restoreFocus } from '@pantry-host/shared/components/ImportGrid';

// ── Cooklang detail cache + throttled fetcher ──────────────────────────────
//
// The federation /api/search response has no image_url, so to render a
// thumbnail we have to call /api/recipes/:id per card. The federation has a
// ~60 req/min rate limit with strict burst enforcement. Caching the full
// FederationRecipe (not just image_url) lets handleImport reuse what the
// image-probe queue already fetched, halving requests for the common
// "search → add" flow. Throttle is 1500ms (~40 req/min) to stay under the
// ceiling with headroom for import mutations.
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
      clImageStopped = true;
    }
    clImageListeners.forEach((fn) => fn());
    if (clImageQueue.length > 0 && !clImageStopped) {
      await new Promise((r) => setTimeout(r, 1500));
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
  if (!clRecipeCache.has(id)) return undefined;
  const cached = clRecipeCache.get(id);
  return cached ? (cached.image_url ?? null) : null;
}

function CooklangCard({ result: r, selected, onToggle, selectedCount, onImport }: { result: FederationSearchResult; selected: boolean; onToggle: () => void; selectedCount: number; onImport: () => void }) {
  const imageUrl = useClImage(r.id);
  const [imgFailed, setImgFailed] = useState(false);
  const showImage = imageUrl && !imgFailed;
  const showPlaceholder = imageUrl === null || imgFailed;
  return (
    <label className={`group card overflow-hidden cursor-pointer transition-colors ${selected ? 'border-accent bg-[var(--color-accent-subtle)]' : ''}`}>
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
        <input type="checkbox" checked={selected} onChange={onToggle} className="mt-1 w-4 h-4 shrink-0 accent-accent" />
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

interface ParsedRecipe {
  title?: string;
  description?: string;
  instructions?: string;
  servings?: number;
  prepTime?: number;
  cookTime?: number;
  tags?: string[];
  photoUrl?: string;
  ingredients?: { ingredientName: string; quantity: number | null; unit: string | null }[];
}

type ImportStatus = 'pending' | 'fetching' | 'done' | 'failed';

interface ImportItem {
  url: string;
  status: ImportStatus;
  error?: string;
  recipe?: ParsedRecipe;
  skip: boolean;
}

type Step = 'input' | 'fetching' | 'review' | 'saving';



// Shared import utilities — extractUrls now supports at:// URIs
import { extractUrls, tryParsePantryHostExport as tryParsePantryHostExportShared } from '@pantry-host/shared/import-utils';
import { fetchBlueskyRecipe } from '@pantry-host/shared/bluesky';

function tryParsePantryHostExport(text: string): ParsedRecipe[] | null {
  return tryParsePantryHostExportShared(text) as ParsedRecipe[] | null;
}

const CREATE_RECIPE = `
  mutation CreateRecipe(
    $title: String!, $description: String, $instructions: String!,
    $servings: Int, $prepTime: Int, $cookTime: Int,
    $tags: [String!], $photoUrl: String, $sourceUrl: String,
    $ingredients: [RecipeIngredientInput!]!, $kitchenSlug: String
  ) {
    createRecipe(
      title: $title, description: $description, instructions: $instructions,
      servings: $servings, prepTime: $prepTime, cookTime: $cookTime,
      tags: $tags, photoUrl: $photoUrl, sourceUrl: $sourceUrl,
      ingredients: $ingredients, kitchenSlug: $kitchenSlug
    ) { id }
  }
`;

export default function RecipeImportPage() {
  const kitchen = useKitchen();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const recipesBase = `/kitchens/${kitchen}/recipes`;

  const [step, setStep] = useState<Step>('input');
  // Pre-populate from ?url= query param so /https/*'s error-fallback CTA can
  // deep-link users here with the URL already in the textarea.
  const [pasteText, setPasteText] = useState(() => {
    if (isServer) return '';
    return new URLSearchParams(window.location.search).get('url') ?? '';
  });
  const [parseError, setParseError] = useState<string | null>(null);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [saveProgress, setSaveProgress] = useState(0);
  const [apiOnline, setApiOnline] = useState(true);

  // Cooklang federation state
  const [clQuery, setClQuery] = useState('');
  const [clResults, setClResults] = useState<FederationSearchResult[]>([]);
  const [clPagination, setClPagination] = useState<FederationPagination | null>(null);
  const [clSearching, setClSearching] = useState(false);
  const [clLoadingMore, setClLoadingMore] = useState(false);
  const [clSelected, setClSelected] = useState<Set<number>>(new Set());
  const [clImporting, setClImporting] = useState(false);
  const [clImportProgress, setClImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [clError, setClError] = useState<string | null>(null);
  const clDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Community tab state
  type CommunityTab = 'url' | 'cooklang' | 'mealdb' | 'cocktaildb' | 'publicdomain' | 'wikibooks' | 'recipe-api';
  const ALL_COMMUNITY_TABS: CommunityTab[] = ['url', 'cooklang', 'mealdb', 'cocktaildb', 'publicdomain', 'wikibooks', 'recipe-api'];
  const [communityTab, setCommunityTab] = useState<CommunityTab>(() => {
    if (isServer) return 'url';
    const urlTab = new URLSearchParams(window.location.search).get('tab');
    if (urlTab && ALL_COMMUNITY_TABS.includes(urlTab as CommunityTab)) return urlTab as CommunityTab;
    return 'url';
  });
  // Recipe API tab is shown only if the server exposes a RECIPE_API_KEY via
  // the owner-gated /api/recipe-api-key route. Guests on HTTP LAN IPs get
  // null and the tab stays hidden.
  const [recipeApiKey, setRecipeApiKey] = useState<string | null>(null);
  // TheCocktailDB tab visibility. Defaults to true; gets overridden by
  // /api/settings-read which merges process.env (sourced from .env.local
  // at server startup) with any /settings page overrides.
  const [showCocktailDB, setShowCocktailDB] = useState(true);
  useEffect(() => {
    fetch('/api/settings-read')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { values?: Record<string, string | null> } | null) => {
        if (j?.values?.SHOW_COCKTAILDB === 'false') setShowCocktailDB(false);
        else setShowCocktailDB(true);
      })
      .catch(() => {});
  }, []);
  // Cocktail age gate — backed by state so clicking "I am 21 or older" triggers
  // a re-render. Previously read localStorage directly at render time, which
  // meant a click only updated storage + called setCommunityTab (a no-op if
  // already on the cocktaildb tab), so the gate stayed until a tab-switch
  // forced a parent re-render.
  const [cdAgeVerified, setCdAgeVerified] = useState(() =>
    isBrowser && localStorage.getItem('age-verified') === 'true'
  );
  // Recipe API tab is ALWAYS present; the panel itself shows a keyless
  // empty-state with both an inline form and a Settings link when no key
  // is configured. This matches the web package's UX.
  const COMMUNITY_TAB_ORDER: CommunityTab[] = (
    ['url', 'cooklang', 'mealdb', 'recipe-api', 'publicdomain', 'wikibooks', 'cocktaildb'] as CommunityTab[]
  ).filter((k) => {
    if (k === 'cocktaildb' && !showCocktailDB) return false;
    return true;
  });
  const handleCommunityTabKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const idx = COMMUNITY_TAB_ORDER.indexOf(communityTab);
    let next = idx;
    if (e.key === 'ArrowRight') next = (idx + 1) % COMMUNITY_TAB_ORDER.length;
    else if (e.key === 'ArrowLeft') next = (idx - 1 + COMMUNITY_TAB_ORDER.length) % COMMUNITY_TAB_ORDER.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = COMMUNITY_TAB_ORDER.length - 1;
    else return;
    e.preventDefault();
    const nextTab = COMMUNITY_TAB_ORDER[next];
    if (nextTab === 'wikibooks' && !wbLoaded && !wbSearching) {
      setWbSearching(true);
      fetch('/api/wikibooks?limit=48').then((r) => r.json())
        .then((d) => { setWbResults(d.results); setWbTotal(d.total); setWbLoaded(true); })
        .catch(() => {}).finally(() => setWbSearching(false));
    }
    setCommunityTab(nextTab);
    requestAnimationFrame(() => {
      const el = document.getElementById(`tab-${nextTab}`);
      el?.focus();
      el?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    });
  };

  // Wikibooks state (server-side cached, no client download)
  const [wbResults, setWbResults] = useState<WikibooksEntry[]>([]);
  const [wbTotal, setWbTotal] = useState(0);
  const [wbQuery, setWbQuery] = useState('');
  const [wbSearching, setWbSearching] = useState(false);
  const [wbSelected, setWbSelected] = useState<Set<string>>(new Set());
  const [wbLoaded, setWbLoaded] = useState(false);
  const [wbImporting, setWbImporting] = useState(false);
  const [wbImportProgress, setWbImportProgress] = useState<{ done: number; total: number } | null>(null);

  async function handleWikibooksImport() {
    const toImport = wbResults.filter((r) => wbSelected.has(r.slug));
    if (toImport.length === 0) return;
    const prevFocus = captureActiveElement();
    setWbImporting(true);
    setWbImportProgress({ done: 0, total: toImport.length });
    let failed = 0;
    for (let i = 0; i < toImport.length; i++) {
      const r = toImport[i];
      try {
        await gql(CREATE_RECIPE, {
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
          kitchenSlug: kitchen,
        });
      } catch { failed++; }
      setWbImportProgress({ done: i + 1, total: toImport.length });
      if (i < toImport.length - 1) await new Promise((res) => setTimeout(res, 1200));
    }
    setWbImporting(false);
    setWbImportProgress(null);
    setWbSelected(new Set());
    if (failed > 0) restoreFocus(prevFocus);
    else router.push(`${recipesBase}#stage`);
  }

  // CocktailDB state
  const [cdQuery, setCdQuery] = useState('');
  const [cdCategory, setCdCategory] = useState('');
  const [cdCategories, setCdCategories] = useState<CocktailDBCategory[]>([]);
  const [cdResults, setCdResults] = useState<(CocktailDBDrink | CocktailDBSearchResult)[]>([]);
  const [cdSearching, setCdSearching] = useState(false);
  const [cdSelected, setCdSelected] = useState<Set<string>>(new Set());
  const [cdImporting, setCdImporting] = useState(false);
  const [cdImportProgress, setCdImportProgress] = useState<{ done: number; total: number } | null>(null);
  const cdDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => { getCocktailDBCategories().then(setCdCategories).catch(() => {}); }, []);

  async function handleCocktailDBImport() {
    if (cdSelected.size === 0) return;
    const prevFocus = captureActiveElement();
    setCdImporting(true);
    setCdImportProgress({ done: 0, total: cdSelected.size });
    const ids = Array.from(cdSelected);
    let failed = 0;
    for (let i = 0; i < ids.length; i++) {
      try {
        let drink = cdResults.find((r) => ('idDrink' in r ? r.idDrink : '') === ids[i]) as CocktailDBDrink | undefined;
        if (!drink || !('strInstructions' in drink)) drink = await getCocktailDBRecipe(ids[i]) ?? undefined;
        if (!drink) throw new Error('Drink not found');
        const recipe = drinkToRecipe(drink);
        await gql(CREATE_RECIPE, {
          title: recipe.title, description: null, instructions: recipe.instructions,
          servings: null, prepTime: null, cookTime: null,
          tags: recipe.tags, photoUrl: recipe.photoUrl, sourceUrl: recipe.sourceUrl,
          ingredients: recipe.ingredients, kitchenSlug: kitchen,
        });
      } catch { failed++; }
      setCdImportProgress({ done: i + 1, total: ids.length });
      if (i < ids.length - 1) await new Promise((res) => setTimeout(res, 1200));
    }
    setCdImporting(false);
    setCdImportProgress(null);
    setCdSelected(new Set());
    if (failed > 0) restoreFocus(prevFocus);
    else router.push(`${recipesBase}#stage`);
  }

  // TheMealDB state
  const [mdQuery, setMdQuery] = useState('');
  const [mdCategory, setMdCategory] = useState('');
  const [mdCategories, setMdCategories] = useState<MealDBCategory[]>([]);
  const [mdResults, setMdResults] = useState<(MealDBMeal | MealDBSearchResult)[]>([]);
  const [mdSearching, setMdSearching] = useState(false);
  const [mdSelected, setMdSelected] = useState<Set<string>>(new Set());
  const [mdImporting, setMdImporting] = useState(false);
  const [mdImportProgress, setMdImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [mdError, setMdError] = useState<string | null>(null);
  const mdDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  // User Flow toggles — browse routes to per-recipe preview pages, bulk
  // keeps the checkbox-grid batch-import behavior. One per source so
  // each tab can be configured independently.
  const [mdMode, setMdMode] = useState<'bulk' | 'browse'>(() => {
    if (isServer) return 'bulk';
    return (localStorage.getItem('import-mode-mealdb') as 'bulk' | 'browse') || 'bulk';
  });
  const [cdMode, setCdMode] = useState<'bulk' | 'browse'>(() => {
    if (isServer) return 'bulk';
    return (localStorage.getItem('import-mode-cocktaildb') as 'bulk' | 'browse') || 'bulk';
  });
  const [pdrMode, setPdrMode] = useState<'bulk' | 'browse'>(() => {
    if (isServer) return 'bulk';
    return (localStorage.getItem('import-mode-publicdomain') as 'bulk' | 'browse') || 'bulk';
  });
  const [raMode, setRaMode] = useState<'bulk' | 'browse'>(() => {
    if (isServer) return 'bulk';
    return (localStorage.getItem('import-mode-recipe-api') as 'bulk' | 'browse') || 'bulk';
  });
  const [clMode, setClMode] = useState<'bulk' | 'browse'>(() => {
    if (isServer) return 'bulk';
    return (localStorage.getItem('import-mode-cooklang') as 'bulk' | 'browse') || 'bulk';
  });
  const [wbMode, setWbMode] = useState<'bulk' | 'browse'>(() => {
    if (isServer) return 'bulk';
    return (localStorage.getItem('import-mode-wikibooks') as 'bulk' | 'browse') || 'bulk';
  });
  useEffect(() => { if (isBrowser) localStorage.setItem('import-mode-mealdb', mdMode); }, [mdMode]);
  useEffect(() => { if (isBrowser) localStorage.setItem('import-mode-cocktaildb', cdMode); }, [cdMode]);
  useEffect(() => { if (isBrowser) localStorage.setItem('import-mode-publicdomain', pdrMode); }, [pdrMode]);
  useEffect(() => { if (isBrowser) localStorage.setItem('import-mode-recipe-api', raMode); }, [raMode]);
  useEffect(() => { if (isBrowser) localStorage.setItem('import-mode-cooklang', clMode); }, [clMode]);
  useEffect(() => { if (isBrowser) localStorage.setItem('import-mode-wikibooks', wbMode); }, [wbMode]);

  useEffect(() => { getMealDBCategories().then(setMdCategories).catch(() => {}); }, []);

  // Recipe API (recipe-api.com) state
  const [raQuery, setRaQuery] = useState('');
  const [raCategory, setRaCategory] = useState('');
  const [raCategories, setRaCategories] = useState<RecipeAPICategoryCount[]>([]);
  const [raResults, setRaResults] = useState<RecipeAPIListItem[]>([]);
  const [raSearching, setRaSearching] = useState(false);
  const [raSelected, setRaSelected] = useState<Set<string>>(new Set());
  const [raImporting, setRaImporting] = useState(false);
  const [raImportProgress, setRaImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [raError, setRaError] = useState<string | null>(null);
  const [raKeyInput, setRaKeyInput] = useState('');
  const [raKeySaving, setRaKeySaving] = useState(false);
  const raDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  // Fetch the owner-only key from the Rex API route on mount. Returns null
  // for guest visitors, which hides the Recipe API tab entirely.
  useEffect(() => {
    fetch('/api/recipe-api-key')
      .then((r) => r.ok ? r.json() : { key: null })
      .then((d: { key: string | null }) => setRecipeApiKey(d.key))
      .catch(() => setRecipeApiKey(null));
  }, []);

  // Load categories once we have a key.
  useEffect(() => {
    if (!recipeApiKey) return;
    getRecipeAPICategories(recipeApiKey).then(setRaCategories).catch(() => {});
  }, [recipeApiKey]);

  const raRunSearch = useCallback(
    async (q: string, cat: string) => {
      if (!recipeApiKey) return;
      setRaSearching(true);
      setRaError(null);
      try {
        const res = await searchRecipeAPI({ q: q || undefined, category: cat || undefined, per_page: 12 }, recipeApiKey);
        setRaResults(res.data);
      } catch (err) {
        const msg = (err as Error).message;
        if (msg.includes('429')) setRaError('Rate limit reached. Try again in a moment.');
        else if (msg.includes('401') || msg.includes('403')) setRaError('API key rejected. Check RECIPE_API_KEY in .env.local.');
        else setRaError(`Search failed: ${msg}`);
        setRaResults([]);
      } finally {
        setRaSearching(false);
      }
    },
    [recipeApiKey],
  );

  useEffect(() => {
    clearTimeout(raDebounceRef.current);
    const q = raQuery.trim();
    if (!q && !raCategory) { setRaResults([]); return; }
    if (q && q.length < 3) return;
    raDebounceRef.current = setTimeout(() => raRunSearch(q, raCategory), 600);
    return () => clearTimeout(raDebounceRef.current);
  }, [raQuery, raCategory, raRunSearch]);

  function raToggleSelect(id: string) {
    setRaSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRecipeApiImport() {
    if (!recipeApiKey || raSelected.size === 0) return;
    const prevFocus = captureActiveElement();
    setRaImporting(true);
    setRaImportProgress({ done: 0, total: raSelected.size });
    setRaError(null);
    const ids = Array.from(raSelected);
    let done = 0;
    let failed = 0;
    let quotaHit: RecipeAPIError | null = null;
    for (const id of ids) {
      try {
        const full = await getRecipeAPIRecipe(id, recipeApiKey);
        const recipe = recipeApiToParsed(full);
        await gql(CREATE_RECIPE, {
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
          kitchenSlug: kitchen,
        });
      } catch (err) {
        console.error(`Failed to import recipe ${id}:`, err);
        failed++;
        // Quota hit means every remaining import will hit the same wall.
        // Break out of the loop so we don't burn 1.2s × N waiting for a
        // foregone failure, then surface a quota-specific message.
        if (err instanceof RecipeAPIError && err.code === 'UNIQUE_RECIPE_LIMIT_EXCEEDED') {
          quotaHit = err;
          done++;
          setRaImportProgress({ done, total: ids.length });
          break;
        }
      }
      done++;
      setRaImportProgress({ done, total: ids.length });
      if (done < ids.length) await new Promise((r) => setTimeout(r, 1200));
    }
    setRaImporting(false);
    setRaImportProgress(null);
    if (quotaHit) {
      const imported = done - failed;
      const prefix = imported > 0 ? `Imported ${imported} before hitting the limit. ` : '';
      setRaError(`${prefix}Monthly quota reached — recipe-api.com's free tier allows 25 unique recipes per billing period. Resets on the 1st, or upgrade at recipe-api.com/pricing.`);
      restoreFocus(prevFocus);
    }
    else if (failed > 0 && failed === ids.length) { setRaError('All imports failed. Try again in a minute.'); restoreFocus(prevFocus); }
    else if (failed > 0) { setRaError(`${done - failed} of ${ids.length} imported. ${failed} failed.`); restoreFocus(prevFocus); }
    else router.push(`${recipesBase}#stage`);
  }

  // Public Domain Recipes state
  const [pdrQuery, setPdrQuery] = useState('');
  const [pdrResults, setPdrResults] = useState<PDREntry[]>([]);
  const [pdrSelected, setPdrSelected] = useState<Set<string>>(new Set());
  const [pdrImporting, setPdrImporting] = useState(false);
  const [pdrImportProgress, setPdrImportProgress] = useState<{ done: number; total: number } | null>(null);
  const [pdrError, setPdrError] = useState<string | null>(null);

  useEffect(() => { setPdrResults(searchPublicDomainRecipes(pdrQuery).slice(0, 24)); }, [pdrQuery]);

  // Bluesky import moved to /recipes/feeds/bluesky

  function pdrToggleSelect(slug: string) {
    setPdrSelected((p) => { const n = new Set(p); n.has(slug) ? n.delete(slug) : n.add(slug); return n; });
  }

  async function handlePdrImport() {
    if (pdrSelected.size === 0) return;
    const prevFocus = captureActiveElement();
    setPdrImporting(true); setPdrImportProgress({ done: 0, total: pdrSelected.size }); setPdrError(null);
    const slugs = Array.from(pdrSelected);
    let done = 0, failed = 0;
    for (const slug of slugs) {
      try {
        const recipe = await fetchPublicDomainRecipe(slug);
        await gql(CREATE_RECIPE, {
          title: recipe.title, description: null, instructions: recipe.instructions,
          servings: null, prepTime: null, cookTime: null,
          tags: recipe.tags, photoUrl: recipe.imageUrl, sourceUrl: recipe.sourceUrl,
          ingredients: recipe.ingredients, kitchenSlug: kitchen,
        });
      } catch (err) { console.error(`Failed to import ${slug}:`, err); failed++; }
      done++; setPdrImportProgress({ done, total: slugs.length });
    }
    setPdrImporting(false); setPdrImportProgress(null);
    if (failed > 0 && failed === slugs.length) { setPdrError('All imports failed.'); restoreFocus(prevFocus); }
    else if (failed > 0) { setPdrError(`${done - failed} of ${slugs.length} imported. ${failed} failed.`); restoreFocus(prevFocus); }
    else router.push(`${recipesBase}#stage`);
  }

  const clSearch = useCallback(async (q: string, page = 1, append = false) => {
    if (!q.trim()) { setClResults([]); setClPagination(null); return; }
    if (page === 1) setClSearching(true);
    else setClLoadingMore(true);
    setClError(null);
    try {
      const data = await searchFederationRecipes(q.trim(), page, 8);
      setClResults((prev) => append ? [...prev, ...data.results] : data.results);
      setClPagination(data.pagination);
    } catch (err) {
      setClError(`Search failed: ${(err as Error).message}`);
    } finally {
      setClSearching(false);
      setClLoadingMore(false);
    }
  }, []);

  useEffect(() => {
    clearTimeout(clDebounceRef.current);
    const q = clQuery.trim();
    if (!q) { setClResults([]); setClPagination(null); return; }
    if (q.length < 3) return; // don't hammer the federation for 1-2 char queries
    clDebounceRef.current = setTimeout(() => clSearch(clQuery), 600);
    return () => clearTimeout(clDebounceRef.current);
  }, [clQuery, clSearch]);

  function clToggleSelect(id: number) {
    setClSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleCooklangImport() {
    if (clSelected.size === 0) return;
    const prevFocus = captureActiveElement();
    setClImporting(true);
    setClImportProgress({ done: 0, total: clSelected.size });
    setClError(null);
    const ids = Array.from(clSelected);
    let done = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        // Reuse whatever the image-probe queue already fetched so importing
        // a visible card is zero federation requests (SW's pantry-host-cooklang
        // bucket also makes any miss free on repeat).
        const full = clRecipeCache.get(id) ?? await getFederationRecipe(id);
        if (!clRecipeCache.has(id)) clRecipeCache.set(id, full);
        const recipe = cooklangToRecipe(full);
        await gql(CREATE_RECIPE, {
          title: recipe.title,
          description: recipe.description || null,
          instructions: recipe.instructions,
          servings: recipe.servings ?? null,
          prepTime: recipe.prepTime ?? null,
          cookTime: recipe.cookTime ?? null,
          tags: recipe.tags ?? [],
          photoUrl: recipe.photoUrl ?? null,
          sourceUrl: recipe.sourceUrl ?? null,
          ingredients: recipe.ingredients,
          kitchenSlug: kitchen,
        });
      } catch (err) {
        console.error(`Failed to import recipe ${id}:`, err);
        failed++;
      }
      done++;
      setClImportProgress({ done, total: ids.length });
      if (done < ids.length) await new Promise((r) => setTimeout(r, 1200));
    }
    setClImporting(false);
    setClImportProgress(null);
    if (failed > 0 && failed === ids.length) {
      setClError(`All ${failed} imports failed. The Cooklang Federation may be rate-limiting requests \u2014 try again in a minute.`);
      restoreFocus(prevFocus);
    } else if (failed > 0) {
      setClError(`${done - failed} of ${ids.length} recipes imported. ${failed} failed (rate limit). Try importing the rest in a minute.`);
      restoreFocus(prevFocus);
    } else {
      router.push(`${recipesBase}#stage`);
    }
  }

  // TheMealDB search
  const mdSearchByName = useCallback(async (q: string) => {
    if (!q.trim()) { setMdResults([]); return; }
    setMdSearching(true); setMdError(null); setMdCategory('');
    try { setMdResults(await searchMealDB(q.trim())); }
    catch (err) { setMdError(`Search failed: ${(err as Error).message}`); }
    finally { setMdSearching(false); }
  }, []);

  useEffect(() => {
    clearTimeout(mdDebounceRef.current);
    if (!mdQuery.trim()) { if (!mdCategory) setMdResults([]); return; }
    mdDebounceRef.current = setTimeout(() => mdSearchByName(mdQuery), 300);
    return () => clearTimeout(mdDebounceRef.current);
  }, [mdQuery, mdSearchByName]);

  async function handleMdCategoryFilter(cat: string) {
    setMdCategory(cat); setMdQuery(''); setMdSearching(true); setMdError(null);
    try { setMdResults(await filterByCategory(cat)); }
    catch (err) { setMdError(`Filter failed: ${(err as Error).message}`); }
    finally { setMdSearching(false); }
  }

  function mdToggleSelect(id: string) {
    setMdSelected((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function handleMealDBImport() {
    if (mdSelected.size === 0) return;
    const prevFocus = captureActiveElement();
    setMdImporting(true); setMdImportProgress({ done: 0, total: mdSelected.size }); setMdError(null);
    const ids = Array.from(mdSelected);
    let done = 0, failed = 0;
    for (const id of ids) {
      try {
        let meal = mdResults.find((r) => r.idMeal === id) as MealDBMeal | undefined;
        if (!meal || !('strInstructions' in meal)) meal = await getMealDBRecipe(id) ?? undefined;
        if (!meal) throw new Error('Meal not found');
        const recipe = mealToRecipe(meal);
        await gql(CREATE_RECIPE, {
          title: recipe.title, description: null, instructions: recipe.instructions,
          servings: null, prepTime: null, cookTime: null,
          tags: recipe.tags, photoUrl: recipe.photoUrl, sourceUrl: recipe.sourceUrl,
          ingredients: recipe.ingredients, kitchenSlug: kitchen,
        });
      } catch (err) { console.error(`Failed to import meal ${id}:`, err); failed++; }
      done++; setMdImportProgress({ done, total: ids.length });
    }
    setMdImporting(false); setMdImportProgress(null);
    if (failed > 0 && failed === ids.length) { setMdError('All imports failed.'); restoreFocus(prevFocus); }
    else if (failed > 0) { setMdError(`${done - failed} of ${ids.length} imported. ${failed} failed.`); restoreFocus(prevFocus); }
    else router.push(`${recipesBase}#stage`);
  }

  useEffect(() => {
    setApiOnline(isApiOnline());
    const handler = (e: Event) => setApiOnline((e as CustomEvent).detail.online);
    window.addEventListener(API_STATUS_EVENT, handler);
    return () => window.removeEventListener(API_STATUS_EVENT, handler);
  }, []);

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { setPasteText(reader.result as string); };
    reader.readAsText(file);
  }

  function handleParse() {
    setParseError(null);
    const filename = fileRef.current?.files?.[0]?.name;
    // Check for Pantry Host HTML export first
    const pantryExports = tryParsePantryHostExport(pasteText);
    if (pantryExports) {
      setItems(pantryExports.map((recipe, i) => ({
        url: recipe.title || `Pantry Host export ${i + 1}`,
        status: 'done' as ImportStatus,
        recipe,
        skip: false,
      })));
      setStep('review');
      return;
    }
    const urls = extractUrls(pasteText, filename);
    if (urls.length === 0) {
      setParseError('No URLs found. Paste recipe URLs (one per line), or upload a bookmarks .html, Pantry Host export .html, or .csv file.');
      return;
    }
    const newItems: ImportItem[] = urls.map((url) => ({ url, status: 'pending', skip: false }));
    setItems(newItems);
    setStep('fetching');
    fetchAll(newItems);
  }

  async function fetchAll(initialItems: ImportItem[]) {
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
            let data: ParsedRecipe;
            if (item.url.startsWith('at://')) {
              // AT URIs fetched client-side (bsky.social has open CORS)
              data = await fetchBlueskyRecipe(item.url) as unknown as ParsedRecipe;
            } else {
              const res = await fetch(apiUrl('/fetch-recipe'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url: item.url }),
              });
              data = await res.json() as ParsedRecipe & { error?: string };
              if (!res.ok || (data as { error?: string }).error) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
            }
            if (!data.title) throw new Error('No recipe data found on this page');
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

  function toggleSkip(idx: number) {
    setItems((prev) => prev.map((item, i) => i === idx ? { ...item, skip: !item.skip } : item));
  }

  async function handleSave() {
    setStep('saving');
    const toSave = items.filter((item) => item.status === 'done' && !item.skip);
    let saved = 0;

    for (const item of toSave) {
      const r = item.recipe!;
      try {
        await gql(CREATE_RECIPE, {
          title: r.title ?? 'Untitled',
          description: r.description ?? null,
          instructions: r.instructions ?? '',
          servings: r.servings ?? null,
          prepTime: r.prepTime ?? null,
          cookTime: r.cookTime ?? null,
          tags: r.tags ?? [],
          photoUrl: r.photoUrl ?? null,
          ingredients: (r.ingredients ?? []).map((i) => ({
            ingredientName: i.ingredientName,
            quantity: i.quantity ?? null,
            unit: i.unit ?? null,
          })),
          kitchenSlug: kitchen,
        });
      } catch {
        // Continue — don't block the rest
      }
      saved++;
      setSaveProgress(saved);
    }

    router.push(`${recipesBase}#stage`);
  }

  const fetchedCount = items.filter((i) => i.status === 'done' || i.status === 'failed').length;
  const successCount = items.filter((i) => i.status === 'done' && !i.skip).length;
  const failedCount = items.filter((i) => i.status === 'failed' && !i.skip).length;

  return (
    <>
      <Head><title>Import Recipes — Pantry Host</title></Head>

      <main id="stage" className="max-sm:min-h-screen px-4 py-10 md:px-8 max-w-3xl mx-auto">
        <div className="mb-8">
          <a href={`${recipesBase}#stage`} className="text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] mb-4 inline-block">← Recipes</a>

          <a href={`${recipesBase}/feeds/bluesky#stage`} className="mb-6 flex items-center gap-4 card p-4 rounded-xl hover:border-accent transition-colors">
            <svg fill="currentColor" viewBox="0 0 600 530" width={32} height={28} aria-hidden="true" className="shrink-0 opacity-60" xmlns="http://www.w3.org/2000/svg">
              <path d="M135.72 44.03C202.216 93.951 273.74 195.17 299.91 249.49c26.17-54.32 97.694-155.539 164.19-205.46C512.18 8.005 590 -19.728 590 69.04c0 17.726-10.155 148.928-16.111 170.208-20.703 73.984-96.144 92.854-163.25 81.433 117.262 19.96 147.131 86.084 82.654 152.208-122.385 125.621-175.86-31.511-189.563-71.807-2.512-7.387-3.687-10.832-3.69-7.905-.003-2.927-1.179.518-3.69 7.905-13.704 40.296-67.18 197.428-189.563 71.807-64.477-66.124-34.61-132.251 82.65-152.208-67.105 11.421-142.548-7.45-163.25-81.433C20.232 217.968 10.077 86.766 10.077 69.04c0-88.768 77.82-61.035 125.9-25.01z" />
            </svg>
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm">Browse recipes from Bluesky</p>
              <p className="text-xs text-[var(--color-text-secondary)]">Discover recipes shared on AT Protocol by the community</p>
            </div>
          </a>

          <h1 className="text-4xl font-bold">Import Recipes</h1>
        </div>

        {step === 'input' && (
          <div className="space-y-6">
            <div className="p-6 border border-[var(--color-border-card)] bg-[var(--color-bg-card)]">
              <h2 className="text-lg font-bold mb-1">Upload a file</h2>
              <p className="text-sm text-[var(--color-text-secondary)] mb-4">
                Choose a recipe <span className="font-mono text-xs">.html</span> or provide bookmarks in <span className="font-mono text-xs">.html</span>,
                <span className="font-mono text-xs">.csv</span>, or a plain URL list as <span className="font-mono text-xs">.txt</span>
              </p>
              <label className="block">
                <span className="sr-only">Choose file</span>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".html,.csv,.txt"
                  onChange={handleFile}
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

          {/* Import tabs — URL + Community Recipes */}
          <div>

            {/* Tab toggle */}
            <div className="flex gap-1 mb-6 border-b border-[var(--color-border-card)] overflow-x-auto" role="tablist" aria-label="Recipe sources">
              {COMMUNITY_TAB_ORDER.map((key) => {
                const label = key === 'url' ? 'URL' : key === 'cooklang' ? 'Cooklang' : key === 'mealdb' ? 'TheMealDB' : key === 'publicdomain' ? 'Public Domain' : key === 'wikibooks' ? 'Wikibooks' : key === 'cocktaildb' ? 'TheCocktailDB' : 'Recipe API';
                const active = communityTab === key;
                return (
                  <button
                    key={key}
                    id={`tab-${key}`}
                    role="tab"
                    aria-selected={active}
                    aria-controls={`tabpanel-${key}`}
                    tabIndex={active ? 0 : -1}
                    onKeyDown={handleCommunityTabKeyDown}
                    onClick={() => {
                      if (key === 'wikibooks' && !wbLoaded && !wbSearching) {
                        setWbSearching(true);
                        fetch('/api/wikibooks?limit=48').then((r) => r.json())
                          .then((d) => { setWbResults(d.results); setWbTotal(d.total); setWbLoaded(true); })
                          .catch(() => {}).finally(() => setWbSearching(false));
                      }
                      setCommunityTab(key);
                    }}
                    className={`px-4 py-2 text-sm font-medium whitespace-nowrap shrink-0 border-b-2 transition-colors ${active ? 'border-accent text-accent' : 'border-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]'}`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            {communityTab === 'url' && (<div role="tabpanel" id="tabpanel-url" aria-labelledby="tab-url">
              <div className={`${!apiOnline ? 'opacity-50' : ''}`} {...(!apiOnline ? { inert: '' } : {})}>
                {!apiOnline && (
                  <p className="text-sm text-accent mb-3">
                    URL import requires a connection to your Pantry&nbsp;Host server.
                  </p>
                )}
                <p className="text-sm text-[var(--color-text-secondary)] mb-3 legible pretty">
                  Paste recipe URLs (one per line) or AT Protocol URIs (<code className="text-xs">at://</code>). You can also paste bookmark HTML or CSV content.
                </p>
                <textarea
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  rows={6}
                  placeholder={"https://www.allrecipes.com/recipe/...\nat://did:plc:.../exchange.recipe.recipe/...\nhttps://www.seriouseats.com/..."}
                  aria-label="Recipe URLs or file content"
                  className="field-input w-full font-mono text-sm mb-3"
                />
                {parseError && (
                  <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-3">{parseError}</p>
                )}
                <button
                  type="button"
                  onClick={handleParse}
                  disabled={!pasteText.trim()}
                  className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Parse URLs →
                </button>
              </div>
            </div>)}

            {communityTab === 'cooklang' && (<div role="tabpanel" id="tabpanel-cooklang" aria-labelledby="tab-cooklang">

            <fieldset className="mb-4 card p-3 text-sm">
              <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
              <div className="flex flex-wrap gap-4 px-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="cl-mode" value="browse" checked={clMode === 'browse'} onChange={() => setClMode('browse')} className="accent-accent" />
                  <span>Browse &amp; Import</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="cl-mode" value="bulk" checked={clMode === 'bulk'} onChange={() => setClMode('bulk')} className="accent-accent" />
                  <span>Bulk Import</span>
                </label>
              </div>
            </fieldset>
            <div className="relative mb-4">
              <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
              <input
                type="search"
                value={clQuery}
                onChange={(e) => setClQuery(e.target.value)}
                placeholder="banana bread"
                className="field-input w-full pl-9"
              />
            </div>

            {clError && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">{clError}</p>}

            {clSearching && clResults.length === 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1, 2, 3, 4, 5, 6].map((i) => (
                  <div key={i} className="h-28 bg-[var(--color-bg-card)] animate-pulse" />
                ))}
              </div>
            )}

            {clResults.length > 0 && (
              <>
                <ImportGrid
                  importing={clImporting}
                  importingLabel={clImportProgress ? `Importing ${clImportProgress.done}/${clImportProgress.total}…` : undefined}
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4"
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && clSelected.size > 0) { e.preventDefault(); handleCooklangImport(); } }}
                  ariaKeyshortcuts="Meta+Enter"
                >
                  {clResults.map((r) => (
                    clMode === 'browse'
                      ? <a key={r.id} href={`/kitchens/${kitchen}/import/cooklang/${r.id}#stage`} className="group card overflow-hidden p-4 transition-colors hover:border-accent">
                          <p className="font-semibold text-sm leading-snug">{r.title}</p>
                        </a>
                      : <CooklangCard key={r.id} result={r} selected={clSelected.has(r.id)} selectedCount={clSelected.size} onImport={handleCooklangImport} onToggle={() => clToggleSelect(r.id)} />
                  ))}
                </ImportGrid>

                {clPagination && clPagination.page < clPagination.total_pages && (
                  <div className="text-center mb-4">
                    <button
                      type="button"
                      onClick={() => clSearch(clQuery, clPagination.page + 1, true)}
                      disabled={clLoadingMore}
                      className="btn-secondary"
                    >
                      {clLoadingMore ? 'Loading\u2026' : `Load More (${clResults.length} of ${clPagination.total})`}
                    </button>
                  </div>
                )}

                {clMode === 'bulk' && clSelected.size > 0 && (
                  <div className="text-center">
                    <button
                      type="button"
                      onClick={handleCooklangImport}
                      disabled={clImporting}
                      aria-busy={clImporting}
                      className="btn-primary"
                    >
                      {clImporting && clImportProgress
                        ? `Importing ${clImportProgress.done}/${clImportProgress.total}\u2026`
                        : `Import Selected (${clSelected.size})`}
                    </button>
                  </div>
                )}
              </>
            )}

            {!clSearching && clQuery.trim() && clResults.length === 0 && (
              <p className="text-[var(--color-text-secondary)] text-sm text-center py-8">
                No recipes found for &ldquo;{clQuery}&rdquo;. Try a different search term.
              </p>
            )}
            </div>)}

            {communityTab === 'mealdb' && (
            <div role="tabpanel" id="tabpanel-mealdb" aria-labelledby="tab-mealdb">
            {/* User Flow toggle — mirrors the bluesky feed page's pattern. */}
            <fieldset className="mb-4 card p-3 text-sm">
              <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
              <div className="flex flex-wrap gap-4 px-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="mealdb-mode" value="browse" checked={mdMode === 'browse'} onChange={() => setMdMode('browse')} className="accent-accent" />
                  <span>Browse &amp; Import</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="mealdb-mode" value="bulk" checked={mdMode === 'bulk'} onChange={() => setMdMode('bulk')} className="accent-accent" />
                  <span>Bulk Import</span>
                </label>
              </div>
            </fieldset>
            <div className="flex flex-col sm:flex-row gap-3 mb-4 sm:items-end">
              <div className="flex-1">
                <label htmlFor="mealdb-search" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Search</label>
                <div className="relative">
                  <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
                  <input id="mealdb-search" type="search" value={mdQuery} onChange={(e) => setMdQuery(e.target.value)} placeholder="vegetable curry" className="field-input w-full pl-9" />
                </div>
              </div>
              <div>
                <label htmlFor="mealdb-category" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Category</label>
                <select id="mealdb-category" value={mdCategory} onChange={(e) => { if (e.target.value) handleMdCategoryFilter(e.target.value); }} className="field-select w-full sm:w-auto">
                  <option value="">All categories</option>
                  {mdCategories.map((c) => <option key={c.idCategory} value={c.strCategory}>{c.strCategory}</option>)}
                </select>
              </div>
            </div>

            {mdError && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">{mdError}</p>}

            {mdSearching && mdResults.length === 0 && (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                {[1,2,3,4,5,6].map((i) => <div key={i} className="h-40 bg-[var(--color-bg-card)] animate-pulse" />)}
              </div>
            )}

            {mdResults.length > 0 && (
              <>
                <ImportGrid
                  importing={mdImporting}
                  importingLabel={mdImportProgress ? `Importing ${mdImportProgress.done}/${mdImportProgress.total}…` : undefined}
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4"
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && mdSelected.size > 0) { e.preventDefault(); handleMealDBImport(); } }}
                  ariaKeyshortcuts="Meta+Enter"
                >
                  {mdResults.map((r) => {
                    const isSel = mdSelected.has(r.idMeal);
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
                    if (mdMode === 'browse') {
                      return (
                        <a key={r.idMeal} href={`/kitchens/${kitchen}/import/mealdb/${r.idMeal}#stage`} className="group card overflow-hidden transition-colors hover:border-accent">
                          {thumbBlock}
                          <div className="p-3 flex items-start gap-3">
                            {meta}
                          </div>
                        </a>
                      );
                    }
                    return (
                      <label key={r.idMeal} className={`group card overflow-hidden cursor-pointer transition-colors ${isSel ? 'border-accent bg-[var(--color-accent-subtle)]' : ''}`}>
                        {thumbBlock}
                        <div className="p-3 flex items-start gap-3">
                          <input type="checkbox" checked={isSel} onChange={() => mdToggleSelect(r.idMeal)} className="mt-1 w-4 h-4 shrink-0 accent-accent" />
                          {meta}
                        </div>
                        {isSel && mdSelected.size > 0 && (
                          <button type="button" onClick={(e) => { e.preventDefault(); handleMealDBImport(); }} className="hidden group-focus-within:block btn-primary text-xs mx-3 mb-3 w-[calc(100%-1.5rem)]">
                            Import {mdSelected.size} selected
                          </button>
                        )}
                      </label>
                    );
                  })}
                </ImportGrid>

                {mdMode === 'bulk' && mdSelected.size > 0 && (
                  <div className="text-center">
                    <button type="button" onClick={handleMealDBImport} disabled={mdImporting} aria-busy={mdImporting} className="btn-primary">
                      {mdImporting && mdImportProgress ? `Importing ${mdImportProgress.done}/${mdImportProgress.total}\u2026` : `Import Selected (${mdSelected.size})`}
                    </button>
                  </div>
                )}
              </>
            )}

            {!mdSearching && !mdQuery.trim() && !mdCategory && (
              <p className="text-[var(--color-text-secondary)] text-sm text-center py-8">Search or pick a category to browse TheMealDB recipes.</p>
            )}
            {!mdSearching && (mdQuery.trim() || mdCategory) && mdResults.length === 0 && (
              <p className="text-[var(--color-text-secondary)] text-sm text-center py-8">No results found.</p>
            )}
            </div>)}

            {communityTab === 'publicdomain' && (<div role="tabpanel" id="tabpanel-publicdomain" aria-labelledby="tab-publicdomain">
            <fieldset className="mb-4 card p-3 text-sm">
              <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
              <div className="flex flex-wrap gap-4 px-2">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="pdr-mode" value="browse" checked={pdrMode === 'browse'} onChange={() => setPdrMode('browse')} className="accent-accent" />
                  <span>Browse &amp; Import</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="radio" name="pdr-mode" value="bulk" checked={pdrMode === 'bulk'} onChange={() => setPdrMode('bulk')} className="accent-accent" />
                  <span>Bulk Import</span>
                </label>
              </div>
            </fieldset>
            <div className="relative mb-4">
              <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
              <input type="search" value={pdrQuery} onChange={(e) => setPdrQuery(e.target.value)} placeholder="Search 408 public domain recipes..." className="field-input w-full pl-9" />
            </div>

            {pdrError && <p role="alert" className="text-sm text-red-600 dark:text-red-400 mb-4">{pdrError}</p>}

            {pdrResults.length > 0 && (
              <>
                <ImportGrid
                  importing={pdrImporting}
                  importingLabel={pdrImportProgress ? `Importing ${pdrImportProgress.done}/${pdrImportProgress.total}…` : undefined}
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4"
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && pdrSelected.size > 0) { e.preventDefault(); handlePdrImport(); } }}
                  ariaKeyshortcuts="Meta+Enter"
                >
                  {pdrResults.map((r) => {
                    const isSel = pdrSelected.has(r.slug);
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
                    if (pdrMode === 'browse') {
                      return (
                        <a key={r.slug} href={`/kitchens/${kitchen}/import/publicdomain/${r.slug}#stage`} className="group card overflow-hidden transition-colors hover:border-accent">
                          {thumbBlock}
                          <div className="p-3 flex items-start gap-3">{meta}</div>
                        </a>
                      );
                    }
                    return (
                      <label key={r.slug} className={`group card overflow-hidden cursor-pointer transition-colors ${isSel ? 'border-accent bg-[var(--color-accent-subtle)]' : ''}`}>
                        {thumbBlock}
                        <div className="p-3 flex items-start gap-3">
                          <input type="checkbox" checked={isSel} onChange={() => pdrToggleSelect(r.slug)} className="mt-1 w-4 h-4 shrink-0 accent-accent" />
                          {meta}
                        </div>
                        {isSel && pdrSelected.size > 0 && (
                          <button type="button" onClick={(e) => { e.preventDefault(); handlePdrImport(); }} className="hidden group-focus-within:block btn-primary text-xs mx-3 mb-3 w-[calc(100%-1.5rem)]">
                            Import {pdrSelected.size} selected
                          </button>
                        )}
                      </label>
                    );
                  })}
                </ImportGrid>

                {pdrMode === 'bulk' && pdrSelected.size > 0 && (
                  <div className="text-center">
                    <button type="button" onClick={handlePdrImport} disabled={pdrImporting} aria-busy={pdrImporting} className="btn-primary">
                      {pdrImporting && pdrImportProgress ? `Importing ${pdrImportProgress.done}/${pdrImportProgress.total}\u2026` : `Import Selected (${pdrSelected.size})`}
                    </button>
                  </div>
                )}
              </>
            )}

            {pdrQuery.trim() && pdrResults.length === 0 && (
              <p className="text-[var(--color-text-secondary)] text-sm text-center py-8">No recipes found for &ldquo;{pdrQuery}&rdquo;.</p>
            )}
            </div>)}

            {communityTab === 'wikibooks' && (<div role="tabpanel" id="tabpanel-wikibooks" aria-labelledby="tab-wikibooks">
              <fieldset className="mb-4 card p-3 text-sm">
                <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
                <div className="flex flex-wrap gap-4 px-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="wb-mode" value="browse" checked={wbMode === 'browse'} onChange={() => setWbMode('browse')} className="accent-accent" />
                    <span>Browse &amp; Import</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="wb-mode" value="bulk" checked={wbMode === 'bulk'} onChange={() => setWbMode('bulk')} className="accent-accent" />
                    <span>Bulk Import</span>
                  </label>
                </div>
              </fieldset>
              <div className="relative mb-4">
                <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
                <input
                  type="search"
                  value={wbQuery}
                  onChange={(e) => {
                    setWbQuery(e.target.value);
                    const q = e.target.value;
                    setWbSearching(true);
                    fetch(`/api/wikibooks?q=${encodeURIComponent(q)}&limit=48`)
                      .then((r) => r.json())
                      .then((d) => { setWbResults(d.results); setWbTotal(d.total); setWbLoaded(true); })
                      .catch(() => {})
                      .finally(() => setWbSearching(false));
                  }}
                  placeholder="Search 3,900 Wikibooks recipes…"
                  className="field-input w-full pl-9"
                />
                {wbLoaded && (
                  <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                    {wbTotal.toLocaleString()} results
                  </p>
                )}
              </div>

              {!wbLoaded && !wbSearching && (
                <p className="text-[var(--color-text-secondary)] text-sm text-center py-8">
                  Type to search, or press Enter with an empty query to browse all.
                </p>
              )}

              {wbSearching && (
                <div className="h-40 rounded-xl bg-[var(--color-bg-card)] animate-pulse" />
              )}

              {wbLoaded && wbResults.length === 0 && (
                <p className="text-[var(--color-text-secondary)] text-sm text-center py-8">No recipes found.</p>
              )}

              {wbResults.length > 0 && (
                <ImportGrid
                  importing={wbImporting}
                  importingLabel={wbImportProgress ? `Importing ${wbImportProgress.done}/${wbImportProgress.total}…` : undefined}
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && wbSelected.size > 0) { e.preventDefault(); handleWikibooksImport(); } }}
                  ariaKeyshortcuts="Meta+Enter"
                >
                  {wbResults.map((r) => {
                    const meta = (
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm">{r.title}</p>
                        <div className="flex flex-wrap gap-1 mt-1">
                          {r.tags.filter((t) => t !== 'wikibooks').slice(0, 3).map((t) => (
                            <span key={t} className="tag text-xs">{t}</span>
                          ))}
                          {r.difficulty != null && (
                            <span className="text-xs text-[var(--color-text-secondary)]">{'★'.repeat(r.difficulty)}{'☆'.repeat(5 - r.difficulty)}</span>
                          )}
                        </div>
                        {(r.servings || r.time) && (
                          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                            {[r.servings && `${r.servings} servings`, r.time].filter(Boolean).join(' · ')}
                          </p>
                        )}
                      </div>
                    );
                    if (wbMode === 'browse') {
                      return (
                        <a key={r.slug} href={`/kitchens/${kitchen}/import/wikibooks/${r.slug}#stage`} className="group card p-4 transition-colors hover:border-accent">
                          <div className="flex items-start gap-3">{meta}</div>
                        </a>
                      );
                    }
                    return (
                      <label key={r.slug} className={`group card p-4 cursor-pointer transition-colors ${wbSelected.has(r.slug) ? 'ring-2 ring-accent' : ''}`}>
                        <div className="flex items-start gap-3">
                          <input
                            type="checkbox"
                            checked={wbSelected.has(r.slug)}
                            onChange={() => setWbSelected((prev) => { const n = new Set(prev); if (n.has(r.slug)) n.delete(r.slug); else n.add(r.slug); return n; })}
                            className="mt-1 accent-accent"
                          />
                          {meta}
                        </div>
                        {wbSelected.has(r.slug) && wbSelected.size > 0 && (
                          <button type="button" onClick={(e) => { e.preventDefault(); handleWikibooksImport(); }} className="hidden group-focus-within:block btn-primary text-xs mt-2 w-full">
                            Import {wbSelected.size} selected
                          </button>
                        )}
                      </label>
                    );
                  })}
                </ImportGrid>
              )}

              {wbMode === 'bulk' && wbSelected.size > 0 && (
                <div className="sticky bottom-4 mt-6 flex justify-center">
                  <button
                    onClick={handleWikibooksImport}
                    disabled={wbImporting}
                    className="btn-primary shadow-lg"
                  >
                    Import {wbSelected.size} selected
                  </button>
                </div>
              )}

              <p className="text-xs text-[var(--color-text-secondary)] mt-6 text-center">
                Recipes from <a href="https://en.wikibooks.org/wiki/Cookbook" className="underline" rel="noopener noreferrer">Wikibooks Cookbook</a> · CC-BY-SA-4.0
              </p>
            </div>)}

            {communityTab === 'cocktaildb' && (<div role="tabpanel" id="tabpanel-cocktaildb" aria-labelledby="tab-cocktaildb">
              {!cdAgeVerified ? (
                <div className="text-center py-12">
                  <p className="text-[var(--color-text-secondary)] mb-2">TheCocktailDB contains alcoholic drink recipes.</p>
                  <p className="text-[var(--color-text-secondary)] text-sm mb-6">You must be 21 or older to browse this content.</p>
                  <button onClick={() => { localStorage.setItem('age-verified', 'true'); setCdAgeVerified(true); }} className="btn-primary">I am 21 or older</button>
                </div>
              ) : (<>
              <fieldset className="mb-4 card p-3 text-sm">
                <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
                <div className="flex flex-wrap gap-4 px-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="cd-mode" value="browse" checked={cdMode === 'browse'} onChange={() => setCdMode('browse')} className="accent-accent" />
                    <span>Browse &amp; Import</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="cd-mode" value="bulk" checked={cdMode === 'bulk'} onChange={() => setCdMode('bulk')} className="accent-accent" />
                    <span>Bulk Import</span>
                  </label>
                </div>
              </fieldset>
              <div className="flex flex-col sm:flex-row gap-2 mb-4 sm:items-end">
                <div className="flex-1">
                  <label htmlFor="cocktaildb-search" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Search</label>
                  <div className="relative">
                    <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
                    <input
                      id="cocktaildb-search"
                      type="search"
                      value={cdQuery}
                      onChange={(e) => {
                        setCdQuery(e.target.value);
                        clearTimeout(cdDebounceRef.current);
                        const q = e.target.value;
                        if (!q.trim()) { setCdResults([]); return; }
                        cdDebounceRef.current = setTimeout(async () => {
                          setCdSearching(true); setCdCategory('');
                          try { setCdResults(await searchCocktailDB(q.trim())); } catch { /* skip */ }
                          finally { setCdSearching(false); }
                        }, 300);
                      }}
                      placeholder="margarita"
                      className="field-input w-full pl-9"
                    />
                  </div>
                </div>
                {cdCategories.length > 0 && (<div>
                  <label htmlFor="cocktaildb-category" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Category</label>
                  <select
                    id="cocktaildb-category"
                    value={cdCategory}
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      setCdCategory(e.target.value); setCdQuery(''); setCdSearching(true);
                      try { setCdResults(await filterCocktailsByCategory(e.target.value)); } catch { /* skip */ }
                      finally { setCdSearching(false); }
                    }}
                    className="field-select w-full sm:w-auto"
                  >
                    <option value="">All categories</option>
                    {cdCategories.map((c) => <option key={c.strCategory} value={c.strCategory}>{c.strCategory}</option>)}
                  </select>
                </div>)}
              </div>

              {cdSearching && <div className="h-40 rounded-xl bg-[var(--color-bg-card)] animate-pulse" />}

              {cdResults.length > 0 && (
                <ImportGrid
                  importing={cdImporting}
                  importingLabel={cdImportProgress ? `Importing ${cdImportProgress.done}/${cdImportProgress.total}…` : undefined}
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && cdSelected.size > 0) { e.preventDefault(); handleCocktailDBImport(); } }}
                  ariaKeyshortcuts="Meta+Enter"
                >
                  {cdResults.map((r) => {
                    const id = 'idDrink' in r ? r.idDrink : '';
                    const name = 'strDrink' in r ? r.strDrink : '';
                    const thumb = 'strDrinkThumb' in r ? r.strDrinkThumb : null;
                    const thumbEl = thumb && <img src={thumb} alt={name} className="w-full aspect-[4/3] object-cover" loading="lazy" />;
                    const meta = (
                      <div>
                        <p className="font-semibold text-sm">{name}</p>
                        {('strCategory' in r && r.strCategory) && <span className="tag text-xs mr-1">{r.strCategory}</span>}
                        {('strAlcoholic' in r && r.strAlcoholic) && <span className="tag text-xs">{r.strAlcoholic}</span>}
                      </div>
                    );
                    if (cdMode === 'browse') {
                      return (
                        <a key={id} href={`/kitchens/${kitchen}/import/cocktaildb/${id}#stage`} className="group card overflow-hidden transition-colors hover:border-accent">
                          {thumbEl}
                          <div className="p-3 flex items-start gap-2">{meta}</div>
                        </a>
                      );
                    }
                    return (
                      <label key={id} className={`group card overflow-hidden cursor-pointer transition-colors ${cdSelected.has(id) ? 'ring-2 ring-accent' : ''}`}>
                        {thumbEl}
                        <div className="p-3 flex items-start gap-2">
                          <input type="checkbox" checked={cdSelected.has(id)} onChange={() => setCdSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; })} className="mt-1 accent-accent" />
                          {meta}
                        </div>
                        {cdSelected.has(id) && cdSelected.size > 0 && (
                          <button type="button" onClick={(e) => { e.preventDefault(); handleCocktailDBImport(); }} className="hidden group-focus-within:block btn-primary text-xs mx-3 mb-3 w-[calc(100%-1.5rem)]">
                            Import {cdSelected.size} selected
                          </button>
                        )}
                      </label>
                    );
                  })}
                </ImportGrid>
              )}

              {cdMode === 'bulk' && cdSelected.size > 0 && (
                <div className="sticky bottom-4 mt-6 flex justify-center">
                  <button
                    onClick={handleCocktailDBImport}
                    disabled={cdImporting}
                    className="btn-primary shadow-lg"
                  >
                    Import {cdSelected.size} selected
                  </button>
                </div>
              )}
            </>)}
            </div>)}

            {communityTab === 'recipe-api' && (<div role="tabpanel" id="tabpanel-recipe-api" aria-labelledby="tab-recipe-api">
              {!recipeApiKey && (
                <div className="max-w-md mx-auto text-center py-8">
                  <h2 className="text-xl font-bold mb-2">Recipe API</h2>
                  <p className="text-sm text-[var(--color-text-secondary)] mb-4 legible pretty">
                    <a href="https://recipe-api.com" target="_blank" rel="noopener noreferrer" className="underline">recipe-api.com</a>
                    {' '}is a JSON API with structured ingredients, USDA nutrition data, and
                    dietary flags. A free tier is available (100 requests/day) — grab a key
                    from{' '}
                    <a href="https://recipe-api.com/pricing" target="_blank" rel="noopener noreferrer" className="underline">recipe-api.com/pricing</a>
                    {' '}and paste it below. The key is stored on this machine in your
                    Settings overrides file and never leaves it.
                  </p>
                  <form
                    onSubmit={async (e) => {
                      e.preventDefault();
                      const k = raKeyInput.trim();
                      if (!k) return;
                      setRaKeySaving(true);
                      try {
                        const res = await fetch('/api/settings-write', {
                          method: 'POST',
                          headers: { 'content-type': 'application/json' },
                          body: JSON.stringify({ values: { RECIPE_API_KEY: k } }),
                        });
                        if (!res.ok) {
                          const body = await res.text().catch(() => '');
                          setRaError(`Couldn't save key: ${body || res.status}`);
                          return;
                        }
                        // Re-fetch the key from the owner-gated route so the rest
                        // of the page picks it up immediately, no reload needed.
                        const k2 = await fetch('/api/recipe-api-key').then((r) => r.json()).then((d: { key: string | null }) => d.key);
                        setRecipeApiKey(k2);
                        setRaKeyInput('');
                        setRaError(null);
                      } catch (err) {
                        setRaError(`Couldn't save key: ${(err as Error).message}`);
                      } finally {
                        setRaKeySaving(false);
                      }
                    }}
                    className="flex flex-col gap-3"
                  >
                    <label htmlFor="recipe-api-key-input" className="sr-only">API key</label>
                    <input
                      id="recipe-api-key-input"
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={raKeyInput}
                      onChange={(e) => setRaKeyInput(e.target.value)}
                      placeholder="rapi_..."
                      className="field-input w-full"
                    />
                    <button type="submit" disabled={!raKeyInput.trim() || raKeySaving} className="btn-primary">
                      {raKeySaving ? 'Saving…' : 'Save key'}
                    </button>
                  </form>
                  {raError && <p role="alert" className="text-sm text-red-400 mt-3">{raError}</p>}
                  <p className="mt-4 text-xs text-[var(--color-text-secondary)]">
                    Or manage all your settings on the{' '}
                    <a href="/settings#stage" className="underline">Settings page</a>.
                  </p>
                </div>
              )}

              {recipeApiKey && (<>
              <fieldset className="mb-4 card p-3 text-sm">
                <legend className="px-2 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">User Flow</legend>
                <div className="flex flex-wrap gap-4 px-2">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="ra-mode" value="browse" checked={raMode === 'browse'} onChange={() => setRaMode('browse')} className="accent-accent" />
                    <span>Browse &amp; Import</span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input type="radio" name="ra-mode" value="bulk" checked={raMode === 'bulk'} onChange={() => setRaMode('bulk')} className="accent-accent" />
                    <span>Bulk Import</span>
                  </label>
                </div>
              </fieldset>
              <div className="flex flex-col sm:flex-row gap-3 mb-6 sm:items-end">
                <div className="flex-1">
                  <label htmlFor="recipe-api-search" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Search</label>
                  <div className="relative">
                    <MagnifyingGlass size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--color-text-secondary)]" aria-hidden />
                    <input id="recipe-api-search" type="search" value={raQuery} onChange={(e) => setRaQuery(e.target.value)} placeholder="lentil soup" className="field-input w-full pl-9" />
                  </div>
                </div>
                <div>
                  <label htmlFor="recipe-api-category" className="text-xs font-bold uppercase tracking-wider text-[var(--color-text-secondary)] mb-1 block">Category</label>
                  <select id="recipe-api-category" value={raCategory} onChange={(e) => setRaCategory(e.target.value)} className="field-select w-full sm:w-auto">
                    <option value="">All categories</option>
                    {raCategories.map((c) => (
                      <option key={c.slug} value={c.slug}>{c.name} ({c.count})</option>
                    ))}
                  </select>
                </div>
              </div>

              {raError && <p role="alert" className="text-sm text-red-400 mb-4">{raError}</p>}

              {raSearching && raResults.length === 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
                  {[1,2,3,4,5,6].map((i) => <div key={i} className="h-32 rounded-xl bg-[var(--color-bg-card)] animate-pulse" />)}
                </div>
              )}

              {raImportProgress && (
                <p className="text-sm text-[var(--color-text-secondary)] mb-4">Importing {raImportProgress.done} of {raImportProgress.total}…</p>
              )}

              {raResults.length > 0 && (
                <ImportGrid
                  importing={raImporting}
                  importingLabel={raImportProgress ? `Importing ${raImportProgress.done}/${raImportProgress.total}…` : undefined}
                  className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-6"
                  onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && raSelected.size > 0) { e.preventDefault(); handleRecipeApiImport(); } }}
                  ariaKeyshortcuts="Meta+Enter"
                >
                  {raResults.map((r) => {
                    const isSelected = raSelected.has(r.id);
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
                    if (raMode === 'browse') {
                      return (
                        <a key={r.id} href={`/kitchens/${kitchen}/import/recipe-api/${r.id}#stage`} className="group card p-4 transition-colors hover:border-accent">
                          <div className="flex items-start gap-3">{meta}</div>
                        </a>
                      );
                    }
                    return (
                      <label key={r.id} className={`group card p-4 cursor-pointer transition-colors ${isSelected ? 'border-accent bg-[var(--color-accent-subtle)]' : ''}`}>
                        <div className="flex items-start gap-3">
                          <input type="checkbox" checked={isSelected} onChange={() => raToggleSelect(r.id)} className="mt-1 w-4 h-4 shrink-0" />
                          {meta}
                        </div>
                        {isSelected && raSelected.size > 0 && (
                          <button type="button" onClick={(e) => { e.preventDefault(); handleRecipeApiImport(); }} className="hidden group-focus-within:block btn-primary text-xs mt-3 w-full">
                            Import {raSelected.size} selected
                          </button>
                        )}
                      </label>
                    );
                  })}
                </ImportGrid>
              )}

              {raMode === 'bulk' && raSelected.size > 0 && !raImportProgress && (
                <div className="sticky bottom-4 flex justify-end">
                  <button type="button" onClick={handleRecipeApiImport} disabled={raImporting} className="btn-primary shadow-lg">
                    Import {raSelected.size} selected
                  </button>
                </div>
              )}

              {!raSearching && raQuery.trim().length >= 3 && raResults.length === 0 && !raError && (
                <p className="text-[var(--color-text-secondary)] text-sm text-center py-8">
                  No recipes found for &ldquo;{raQuery}&rdquo;.
                </p>
              )}

              <p className="text-xs text-[var(--color-text-secondary)] mt-8 text-center">
                Powered by <a href="https://recipe-api.com" target="_blank" rel="noopener noreferrer" className="underline">recipe-api.com</a>.
                {' '}
                <a href="/settings#stage" className="underline">Manage key in Settings</a>.
              </p>
              </>)}
            </div>)}

          </div>
          </div>
        )}

        {step === 'fetching' && (
          <div className="space-y-6">
            <div className="flex items-center gap-4">
              <div className="flex-1 h-2 bg-[var(--color-accent-subtle)] overflow-hidden">
                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${(fetchedCount / items.length) * 100}%` }} />
              </div>
              <span className="text-sm text-[var(--color-text-secondary)] shrink-0">{fetchedCount} / {items.length}</span>
            </div>
            <ul role="list" className="divide-y divide-[var(--color-border-card)]">
              {items.map((item, idx) => (
                <li key={idx} className="py-3 flex items-center gap-3">
                  <StatusIcon status={item.status} />
                  <span className="flex-1 min-w-0 text-sm truncate text-[var(--color-text-secondary)]">{item.url}</span>
                  {item.status === 'done' && item.recipe?.title && (
                    <span className="text-sm font-medium truncate max-w-[40%]">{item.recipe.title}</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {step === 'review' && (
          <div className="space-y-6">
            <p className="text-[var(--color-text-secondary)]">
              <strong className="text-[var(--color-text-primary)]">{successCount}</strong> recipes ready to save
              {failedCount > 0 && <>, <strong className="text-red-500">{failedCount}</strong> failed</>}.
              Remove any you don&apos;t want before saving.
            </p>
            <ul role="list" className="divide-y divide-[var(--color-border-card)]">
              {items.map((item, idx) => (
                !item.skip && (
                  <li key={idx} className={`py-4 flex items-start gap-4 ${item.status === 'failed' ? 'opacity-60' : ''}`}>
                    <StatusIcon status={item.status} />
                    <div className="flex-1 min-w-0">
                      {item.status === 'done' && item.recipe ? (
                        <>
                          <p className="font-semibold truncate">{item.recipe.title}</p>
                          {item.recipe.description && (
                            <p className="text-sm text-[var(--color-text-secondary)] line-clamp-1 mt-0.5">{item.recipe.description}</p>
                          )}
                          <p className="text-xs text-[var(--color-text-secondary)] mt-1">
                            {item.recipe.ingredients?.length ?? 0} ingredients
                            {item.recipe.cookTime ? ` · ${item.recipe.cookTime} min` : ''}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm truncate text-[var(--color-text-secondary)]">{item.url}</p>
                          {item.error && <p className="text-xs text-red-500 mt-0.5">{item.error}</p>}
                        </>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleSkip(idx)}
                      aria-label={`Remove ${item.recipe?.title ?? item.url}`}
                      className="shrink-0 text-[var(--color-text-secondary)] hover:text-red-500 transition-colors p-1"
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                  </li>
                )
              ))}
            </ul>
            <button
              type="button"
              onClick={handleSave}
              disabled={successCount === 0}
              className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save {successCount} Recipe{successCount !== 1 ? 's' : ''} →
            </button>
          </div>
        )}

        {step === 'saving' && (
          <div className="space-y-4">
            <div className="flex items-center gap-4">
              <div className="flex-1 h-2 bg-[var(--color-accent-subtle)] overflow-hidden">
                <div className="h-full bg-accent transition-all duration-300" style={{ width: `${(saveProgress / successCount) * 100}%` }} />
              </div>
              <span className="text-sm text-[var(--color-text-secondary)] shrink-0">
                Saving {saveProgress} / {successCount}…
              </span>
            </div>
          </div>
        )}

        <CommunityDatasources />
      </main>
    </>
  );
}

function StatusIcon({ status }: { status: ImportStatus }) {
  if (status === 'pending') return <span className="w-5 h-5 shrink-0 rounded-full border-2 border-[var(--color-border-card)]" aria-label="pending" />;
  if (status === 'fetching') return (
    <svg className="w-5 h-5 shrink-0 animate-spin text-accent" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" aria-label="fetching">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
    </svg>
  );
  if (status === 'done') return (
    <svg className="w-5 h-5 shrink-0 text-green-500" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="success">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
  return (
    <svg className="w-5 h-5 shrink-0 text-red-500" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-label="failed">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}
