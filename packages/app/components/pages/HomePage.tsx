import Head from 'next/head';
import { useState, useEffect } from 'react';
import { gql } from '@/lib/gql';
import GenerateButton from '@/components/GenerateButton';
import RecipeCard from '@/components/RecipeCard';
import WelcomeBanner from '@/components/WelcomeBanner';
import { getDailyQuote } from '@pantry-host/shared/dailyQuote';
import { Carrot, BookOpen, Coffee, Package, Leaf, Tag, Wine, ForkKnife, CookingPot, Flask, Heart } from '@phosphor-icons/react';
import { isTrustedNetwork } from '@/lib/isTrustedNetwork';
import { useKitchen } from '@/lib/kitchen-context';
import { readFavorites } from '@pantry-host/shared/favorites';

interface HomeRecipe {
  id: string;
  slug: string | null;
  title: string;
  cookTime: number | null;
  prepTime: number | null;
  servings: number | null;
  source: string;
  tags: string[];
  photoUrl: string | null;
  queued: boolean;
}

interface HomeData {
  ingredients: { id: string; category: string | null }[];
  cookware: { id: string; name: string; tags: string[]; notes: string | null }[];
  recipes: HomeRecipe[];
  kitchens: { id: string; slug: string; name: string }[];
}

const HOME_QUERY = `
  query Home($kitchenSlug: String) {
    ingredients(kitchenSlug: $kitchenSlug) { id category }
    cookware(kitchenSlug: $kitchenSlug) { id name tags notes }
    recipes(kitchenSlug: $kitchenSlug) { id slug title cookTime prepTime servings source tags photoUrl queued }
    kitchens { id slug name }
  }
`;

/** Pantry Host dashboard. Rendered at `/` for the Home kitchen and at
 *  `/kitchens/:slug` for every other kitchen — the two URLs share this
 *  one component. The active kitchen comes from `useKitchen()` (derived
 *  once in `_app.tsx` from `router.asPath`); all internal links render
 *  as `/kitchens/{slug}/…` regardless of whether it's home. */
export default function HomePage() {
  const kitchen = useKitchen();
  const [data, setData] = useState<HomeData | null>(null);
  const [isSecure, setIsSecure] = useState(false);
  const [quote, setQuote] = useState<{ text: string; author: string } | null>(null);
  useEffect(() => { setQuote(getDailyQuote()); }, []);

  useEffect(() => {
    gql<HomeData>(HOME_QUERY, { kitchenSlug: kitchen }).then(setData).catch(console.error);
    setIsSecure(isTrustedNetwork(window.location.hostname) || window.location.protocol === 'https:');
  }, [kitchen]);

  const [recipeLimit, setRecipeLimit] = useState(6);
  const [seasonalLimit, setSeasonalLimit] = useState(2);
  const [favoritesLimit, setFavoritesLimit] = useState(3);
  // Favorites are localStorage-only; hydrate after mount so SSR doesn't crash.
  const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
  useEffect(() => { setFavoriteIds(readFavorites()); }, []);

  const ingredientCount = data?.ingredients.length ?? 0;
  const cookwareList = data?.cookware ?? [];
  const allRecipes = data?.recipes ?? [];
  const recentRecipes = allRecipes.slice(0, recipeLimit);
  const hasMore = allRecipes.length > recipeLimit;
  const kitchens = data?.kitchens ?? [];

  // Every internal link is kitchen-scoped. No structural special case
  // for home — if you're on `/`, `kitchen` is `'home'` and links read
  // `/kitchens/home/…`, which is a valid, canonical URL.
  const base = `/kitchens/${kitchen}`;
  const kitchenName = kitchens.find((k) => k.slug === kitchen)?.name ?? kitchen;
  const pageTitle = `${kitchenName} · Pantry Host`;

  const season = currentSeason();
  const seasonalAll = allRecipes.filter((r) => r.tags.some((t) => t.toLowerCase() === season));
  const seasonalRecipes = seasonalAll.slice(0, seasonalLimit);
  const hasMoreSeasonal = seasonalAll.length > seasonalLimit;

  // Favorites: intersect localStorage IDs with the current-kitchen recipe
  // list so deleted/other-kitchen recipes silently drop out.
  const favoriteSet = new Set(favoriteIds);
  const favoritesAll = allRecipes.filter((r) => favoriteSet.has(r.id));
  const favoriteRecipes = favoritesAll.slice(0, favoritesLimit);
  const hasMoreFavorites = favoritesAll.length > favoritesLimit;

  const categoryCounts = data
    ? Object.entries(
        data.ingredients.reduce<Record<string, number>>((acc, i) => {
          const k = i.category ?? 'other';
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      )
        .map(([category, count]) => ({ category, count }))
        .sort((a, b) => b.count - a.count)
    : [];

  return (
    <>
      <Head>
        <title>{pageTitle}</title>
        <meta name="description" content="Family recipe manager — pantry, cookware, and AI-generated recipes." />
        <meta property="og:title" content={pageTitle} />
        <meta property="og:description" content="Family recipe manager — pantry, cookware, and AI-generated recipes." />
        <meta property="og:type" content="website" />
        <meta name="twitter:card" content="summary" />
      </Head>

      <main id="stage" className="min-h-screen px-4 py-10 md:px-8 max-w-4xl mx-auto">
        <WelcomeBanner />

        {/* Quote (desktop only — mobile shows in nav) */}
        {quote && (
          <blockquote className="hidden sm:block mb-12 text-2xl italic text-[var(--color-text-secondary)] font-serif pretty text-center">
            <p>&ldquo;{quote.text}&rdquo;</p>
            <footer className="mt-2 text-base not-italic font-sans text-[var(--color-text-secondary)]">— {quote.author}</footer>
          </blockquote>
        )}

        {/* Hero */}
        <section aria-labelledby="hero-heading" className="mb-8">
          <h1 id="hero-heading" className="text-4xl font-bold mb-3">
            {kitchenName}
          </h1>
          <p className="text-lg text-[var(--color-text-secondary)] max-w-prose">
            Manage your pantry and cookware, then let AI suggest recipes tailored to what you have on hand.
          </p>
        </section>

        {/* Kitchens */}
        {kitchens.length > 0 && (
          <section aria-labelledby="kitchens-heading" className="mb-10">
            <div className="flex items-center justify-between mb-3">
              <h2 id="kitchens-heading" className="text-sm font-semibold uppercase tracking-widest text-[var(--color-text-secondary)]">Kitchens</h2>
              <a href="/kitchens#stage" className="text-sm font-semibold text-accent hover:underline">
                {kitchens.length > 1 ? 'Manage →' : '+ Add kitchen'}
              </a>
            </div>
            <ul className="flex flex-wrap gap-3" role="list">
              {kitchens.map((k) => {
                const active = k.slug === kitchen;
                return (
                <li key={k.id}>
                  <a
                    href={`/kitchens/${k.slug}#stage`}
                    aria-current={active ? 'true' : undefined}
                    className={[
                      'card block px-4 py-3 transition-colors',
                      active
                        ? 'border-accent text-accent'
                        : 'hover:text-accent',
                    ].join(' ')}
                  >
                    <span className="font-medium">{k.name}</span>
                    {active && (
                      <span className="ml-2 text-xs opacity-70">current</span>
                    )}
                  </a>
                </li>
                );
              })}
            </ul>
          </section>
        )}

        {/* Stats row */}
        <section aria-label="Pantry summary" className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-12">
          <StatCard label="Ingredients" value={ingredientCount} href={`${base}/ingredients#stage`} icon={<Carrot size={20} aria-hidden />} />
          <StatCard label="Recipes" value={data?.recipes.length ?? 0} href={`${base}/recipes#stage`} icon={<BookOpen size={20} aria-hidden />} />
          {categoryCounts.slice(0, 2).map((c) => (
            <StatCard key={c.category} label={categoryLabel(c.category)} value={c.count} href={`${base}/ingredients#cat-${c.category}`} icon={categoryIcon(c.category)} />
          ))}
        </section>

        {/* Cookware chips — owner only. Each chip is a tab stop, so a
            keyboard user without this skip link has to tab through every
            piece of cookware before reaching the AI generator below. */}
        {isSecure && cookwareList.length > 0 && (
          <section aria-label="Available cookware" className="mb-10 relative">
            {cookwareList.length >= 3 && (
              <a
                href="#ai-heading"
                className="sr-only focus-visible:not-sr-only focus-visible:absolute focus-visible:right-0 focus-visible:top-0 focus-visible:z-10 focus-visible:bg-[var(--color-bg-card)] focus-visible:border focus-visible:border-[var(--color-accent)] focus-visible:rounded focus-visible:px-3 focus-visible:py-1 focus-visible:text-sm focus-visible:font-semibold focus-visible:text-accent focus-visible:underline"
              >
                Skip cookware list
              </a>
            )}
            <h2 className="text-sm font-semibold uppercase tracking-widest text-[var(--color-text-secondary)] mb-3">
              Cookware
            </h2>
            <ul className="flex flex-wrap gap-2" role="list">
              {cookwareList.map((c) => (
                <li key={c.id}>
                  <a href={`${base}/cookware/${c.id}#stage`} className="tag hover:underline">
                    {c.name}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Generate CTA — owner only (requires localhost or HTTPS) */}
        {isSecure && (
          <section aria-labelledby="ai-heading" className="mb-12">
            <h2 id="ai-heading" className="text-xl font-bold mb-2">Artificial Intelligence</h2>
            <p className="legible text-sm text-[var(--color-text-secondary)] mb-4">Generate a recipe based on the ingredients and cookware in your kitchen.<br />Your ingredient list is sent to the Anthropic API. Anthropic does not use API data to train models or sell it to third parties.</p>
            <GenerateButton ingredientCount={ingredientCount} cookware={cookwareList} />
          </section>
        )}

        {/* Favorites — read from localStorage.favorites, intersected with
            the current kitchen's recipe list. Silent when empty. */}
        {favoriteRecipes.length > 0 && (
          <section aria-labelledby="favorites-heading" className="mb-12">
            <div className="flex items-center justify-between mb-4">
              <h2 id="favorites-heading" className="text-xl font-bold inline-flex items-center gap-2">
                <Heart size={18} weight="fill" aria-hidden className="opacity-70" />
                Your Favorites
              </h2>
              <a href={`${base}/recipes?favorites=1#stage`} className="text-sm font-semibold text-accent hover:underline">
                All favorites &rarr;
              </a>
            </div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {favoriteRecipes.map((r) => (
                <RecipeCard key={r.id} recipe={r} />
              ))}
            </div>
            {hasMoreFavorites && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => setFavoritesLimit((n) => n + 6)}
                  className="text-sm font-semibold text-accent hover:underline"
                  aria-describedby="favorites-heading"
                >
                  Load more favorites
                </button>
              </div>
            )}
          </section>
        )}

        {/* Seasonal recipes */}
        {seasonalRecipes.length > 0 && (
          <section aria-labelledby="seasonal-heading" className="mb-12">
            <div className="flex items-center justify-between mb-4">
              <h2 id="seasonal-heading" className="text-xl font-bold">{capitalize(season)} Recipes</h2>
              <a href={`${base}/recipes?search=${season}#stage`} className="text-sm font-semibold text-accent hover:underline">
                All {season} recipes &rarr;
              </a>
            </div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {seasonalRecipes.map((r) => (
                <RecipeCard key={r.id} recipe={r} />
              ))}
            </div>
            {hasMoreSeasonal && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => setSeasonalLimit((n) => n + 6)}
                  className="text-sm font-semibold text-accent hover:underline"
                  aria-describedby="seasonal-heading"
                >
                  Load more {season} recipes
                </button>
              </div>
            )}
          </section>
        )}

        {/* Recent recipes */}
        {recentRecipes.length > 0 && (
          <section aria-labelledby="recent-heading" className="mb-12">
            <div className="flex items-center justify-between mb-4">
              <h2 id="recent-heading" className="text-xl font-bold">Recent Recipes</h2>
              <a href={`${base}/recipes#stage`} className="text-sm font-semibold text-accent hover:underline">
                All recent recipes &rarr;
              </a>
            </div>
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {recentRecipes.map((r) => (
                <RecipeCard key={r.id} recipe={r} />
              ))}
            </div>
            {hasMore && (
              <div className="mt-6 text-center">
                <button
                  type="button"
                  onClick={() => setRecipeLimit((n) => n + 6)}
                  className="text-sm font-semibold text-accent hover:underline"
                  aria-describedby="recent-heading"
                >
                  Load more recent recipes
                </button>
              </div>
            )}
          </section>
        )}

        {/* What's Cooking? */}
        <section className="mt-12">
          <h2 id="whats-cooking" className="text-2xl font-bold mb-4">What&rsquo;s Cooking?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <a href={`${base}/recipes/feeds/bluesky#stage`} className="card rounded-xl p-5 flex items-center gap-4 hover:border-accent transition-colors">
              <svg fill="currentColor" viewBox="0 0 600 530" width={28} height={24} aria-hidden="true" className="shrink-0 opacity-60">
                <path d="M135.72 44.03C202.216 93.951 273.74 195.17 299.91 249.49c26.17-54.32 97.694-155.539 164.19-205.46C512.18 8.005 590 -19.728 590 69.04c0 17.726-10.155 148.928-16.111 170.208-20.703 73.984-96.144 92.854-163.25 81.433 117.262 19.96 147.131 86.084 82.654 152.208-122.385 125.621-175.86-31.511-189.563-71.807-2.512-7.387-3.687-10.832-3.69-7.905-.003-2.927-1.179.518-3.69 7.905-13.704 40.296-67.18 197.428-189.563 71.807-64.477-66.124-34.61-132.251 82.65-152.208-67.105 11.421-142.548-7.45-163.25-81.433C20.232 217.968 10.077 86.766 10.077 69.04c0-88.768 77.82-61.035 125.9-25.01z" />
              </svg>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">Browse recipes from Bluesky</p>
                <p className="text-xs text-[var(--color-text-secondary)]">Discover community recipes shared on AT Protocol</p>
              </div>
            </a>
            <a href={`${base}/menus/feeds/bluesky#stage`} className="card rounded-xl p-5 flex items-center gap-4 hover:border-accent transition-colors">
              <div className="shrink-0 opacity-60 relative w-[28px] h-[24px]">
                <svg fill="currentColor" viewBox="0 0 600 530" width={16} height={14} aria-hidden="true" className="absolute top-0 left-0"><path d="M135.72 44.03C202.216 93.951 273.74 195.17 299.91 249.49c26.17-54.32 97.694-155.539 164.19-205.46C512.18 8.005 590 -19.728 590 69.04c0 17.726-10.155 148.928-16.111 170.208-20.703 73.984-96.144 92.854-163.25 81.433 117.262 19.96 147.131 86.084 82.654 152.208-122.385 125.621-175.86-31.511-189.563-71.807-2.512-7.387-3.687-10.832-3.69-7.905-.003-2.927-1.179.518-3.69 7.905-13.704 40.296-67.18 197.428-189.563 71.807-64.477-66.124-34.61-132.251 82.65-152.208-67.105 11.421-142.548-7.45-163.25-81.433C20.232 217.968 10.077 86.766 10.077 69.04c0-88.768 77.82-61.035 125.9-25.01z" /></svg>
                <svg fill="currentColor" viewBox="0 0 600 530" width={12} height={10} aria-hidden="true" className="absolute top-[6px] right-0"><path d="M135.72 44.03C202.216 93.951 273.74 195.17 299.91 249.49c26.17-54.32 97.694-155.539 164.19-205.46C512.18 8.005 590 -19.728 590 69.04c0 17.726-10.155 148.928-16.111 170.208-20.703 73.984-96.144 92.854-163.25 81.433 117.262 19.96 147.131 86.084 82.654 152.208-122.385 125.621-175.86-31.511-189.563-71.807-2.512-7.387-3.687-10.832-3.69-7.905-.003-2.927-1.179.518-3.69 7.905-13.704 40.296-67.18 197.428-189.563 71.807-64.477-66.124-34.61-132.251 82.65-152.208-67.105 11.421-142.548-7.45-163.25-81.433C20.232 217.968 10.077 86.766 10.077 69.04c0-88.768 77.82-61.035 125.9-25.01z" /></svg>
                <svg fill="currentColor" viewBox="0 0 600 530" width={10} height={9} aria-hidden="true" className="absolute bottom-0 left-[4px]"><path d="M135.72 44.03C202.216 93.951 273.74 195.17 299.91 249.49c26.17-54.32 97.694-155.539 164.19-205.46C512.18 8.005 590 -19.728 590 69.04c0 17.726-10.155 148.928-16.111 170.208-20.703 73.984-96.144 92.854-163.25 81.433 117.262 19.96 147.131 86.084 82.654 152.208-122.385 125.621-175.86-31.511-189.563-71.807-2.512-7.387-3.687-10.832-3.69-7.905-.003-2.927-1.179.518-3.69 7.905-13.704 40.296-67.18 197.428-189.563 71.807-64.477-66.124-34.61-132.251 82.65-152.208-67.105 11.421-142.548-7.45-163.25-81.433C20.232 217.968 10.077 86.766 10.077 69.04c0-88.768 77.82-61.035 125.9-25.01z" /></svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">Browse menus from Bluesky</p>
                <p className="text-xs text-[var(--color-text-secondary)]">Import curated recipe collections from the community</p>
              </div>
            </a>
          </div>

          <h3 className="text-xl font-bold mb-4 mt-8">Community Sources</h3>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4 max-w-prose pretty">
            Import from recipe communities directly inside the app via <a href={`${base}/recipes/import#stage`} className="underline hover:text-accent">Recipes &rarr; Import</a>.
          </p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[
              { name: 'TheMealDB', tab: 'mealdb', icon: ForkKnife, catalog: '~300 recipes', blurb: 'Browse by category, cuisine, or ingredient.' },
              { name: 'Cooklang Federation', tab: 'cooklang', icon: BookOpen, catalog: '3,500+ recipes', blurb: 'Community recipes in the standardized .cook format.' },
              { name: 'Wikibooks Cookbook', tab: 'wikibooks', icon: Leaf, catalog: '~3,900 recipes', blurb: 'The largest catalog. Cached locally for offline browsing.' },
              { name: 'Public Domain Recipes', tab: 'publicdomain', icon: CookingPot, catalog: '408 recipes', blurb: 'Truly public domain \u2014 no attribution required.' },
              { name: 'Recipe API', tab: 'recipe-api', icon: Flask, catalog: 'Proprietary', blurb: 'USDA-backed nutrition data per serving.' },
              { name: 'TheCocktailDB', tab: 'cocktaildb', icon: Wine, catalog: '~600 cocktails', blurb: 'Drinks-only companion to TheMealDB.' },
            ].map((s) => (
              <a key={s.name} href={`${base}/recipes/import?tab=${s.tab}#stage`} className="card rounded-xl p-4 flex flex-col hover:border-accent transition-colors">
                <div className="flex items-center gap-2 mb-2">
                  <s.icon size={18} weight="light" className="opacity-60 shrink-0" />
                  <p className="font-semibold text-sm">{s.name}</p>
                </div>
                <p className="text-xs font-semibold uppercase tracking-wider text-accent mb-1">{s.catalog}</p>
                <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">{s.blurb}</p>
              </a>
            ))}
          </div>
        </section>

      </main>
    </>
  );
}

function StatCard({ label, value, href, icon }: { label: string; value: number; href: string; icon?: React.ReactNode }) {
  return (
    <a href={href} className="card block pt-3 pb-5 px-5 hover:text-accent transition-colors text-center">
      {icon && <div className="text-[var(--color-text-secondary)] flex justify-center mb-2">{icon}</div>}
      <div className="text-3xl font-bold tabular-nums">{value}</div>
      <div className="text-sm text-[var(--color-text-secondary)] mt-1">{label}</div>
    </a>
  );
}

const CATEGORY_LABELS: Record<string, string> = { pantry: 'Pantry Items' };

function categoryLabel(s: string) {
  return CATEGORY_LABELS[s] ?? capitalize(s);
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function currentSeason(): string {
  const m = new Date().getMonth(); // 0-indexed
  if (m >= 2 && m <= 4) return 'spring';
  if (m >= 5 && m <= 7) return 'summer';
  if (m >= 8 && m <= 10) return 'fall';
  return 'winter';
}

const CATEGORY_ICONS: Record<string, React.ReactNode> = {
  pantry: <Package size={20} aria-hidden />,
  beverages: <Coffee size={20} aria-hidden />,
  produce: <Leaf size={20} aria-hidden />,
};

function categoryIcon(s: string): React.ReactNode {
  return CATEGORY_ICONS[s] ?? <Tag size={20} aria-hidden />;
}
