/**
 * Shared web-URL recipe detail + import CTA.
 *
 * Renders a preview of a recipe scraped from an http(s):// URL, with an
 * Import button. Mirrors `AtRecipeDetail` but fetches from an arbitrary
 * webpage (LD+JSON → fallback scrape) rather than AT Protocol.
 *
 * The caller provides:
 * - `sourceUrl`: the full http(s):// URL being previewed
 * - `fetcher(url)`: performs the scrape; returns a ParsedRecipe-shaped payload
 * - `onImport(recipe)`: runs the createRecipe mutation
 * - `checkDuplicate(sourceUrl)`: returns existing slug or null
 * - `recipeBasePath`: e.g. "/recipes"
 * - `renderRecipeLink(slug, children)`: package-specific Link wrapper
 * - `renderManualImportLink(url, children)`: link to /recipes/import?url=…
 *   for the error fallback path
 */
import { useState, useEffect, useCallback } from 'react';
import { groupIngredients } from '../ingredient-groups';
import type { ParsedRecipe, ParsedIngredient } from '../bluesky';
import { ArrowSquareIn, Warning, SpinnerGap } from '@phosphor-icons/react';

interface FetchedRecipe {
  title?: string;
  description?: string;
  instructions?: string;
  servings?: number;
  prepTime?: number;
  cookTime?: number;
  tags?: string[];
  photoUrl?: string;
  ingredients?: Array<{ ingredientName: string; quantity: number | null; unit: string | null }>;
}

interface UrlRecipeDetailProps {
  sourceUrl: string;
  fetcher: (url: string) => Promise<FetchedRecipe>;
  onImport: (recipe: ParsedRecipe) => Promise<{ slug: string }>;
  checkDuplicate: (sourceUrl: string) => Promise<string | null>;
  renderRecipeLink: (slug: string, children: React.ReactNode) => React.ReactNode;
  renderManualImportLink: (url: string, children: React.ReactNode) => React.ReactNode;
}

type PageState =
  | { kind: 'loading' }
  | { kind: 'recipe'; recipe: ParsedRecipe; existingSlug: string | null }
  | { kind: 'importing'; recipe: ParsedRecipe }
  | { kind: 'imported'; slug: string }
  | { kind: 'error'; message: string };

function normalize(raw: FetchedRecipe, sourceUrl: string): ParsedRecipe {
  const ingredients: ParsedIngredient[] = (raw.ingredients ?? []).map((i) => ({
    ingredientName: i.ingredientName,
    quantity: i.quantity ?? undefined,
    unit: i.unit ?? undefined,
  }));
  return {
    title: raw.title ?? '',
    description: raw.description,
    instructions: raw.instructions ?? '',
    servings: raw.servings,
    prepTime: raw.prepTime,
    cookTime: raw.cookTime,
    tags: raw.tags ?? [],
    photoUrl: raw.photoUrl,
    sourceUrl,
    ingredients,
  };
}

export default function UrlRecipeDetail({
  sourceUrl,
  fetcher,
  onImport,
  checkDuplicate,
  renderRecipeLink,
  renderManualImportLink,
}: UrlRecipeDetailProps) {
  const [state, setState] = useState<PageState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const raw = await fetcher(sourceUrl);
      const recipe = normalize(raw, sourceUrl);
      if (!recipe.title) {
        setState({ kind: 'error', message: 'This page does not look like a recipe — no title found.' });
        return;
      }
      const existingSlug = await checkDuplicate(sourceUrl);
      setState({ kind: 'recipe', recipe, existingSlug });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, [sourceUrl, fetcher, checkDuplicate]);

  useEffect(() => { load(); }, [load]);

  async function handleImport() {
    if (state.kind !== 'recipe') return;
    const { recipe } = state;
    setState({ kind: 'importing', recipe });
    try {
      const { slug } = await onImport(recipe);
      setState({ kind: 'imported', slug });
    } catch (err) {
      setState({ kind: 'error', message: `Import failed: ${(err as Error).message}` });
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4 flex items-center gap-3 text-[var(--color-text-secondary)]">
        <SpinnerGap size={20} className="animate-spin" />
        Fetching recipe from <span className="break-all">{hostnameOf(sourceUrl)}</span>…
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4">
        <div className="card p-6">
          <div className="flex items-start gap-3 mb-4">
            <Warning size={20} className="shrink-0 mt-0.5 text-red-400" />
            <div className="min-w-0">
              <p className="font-semibold mb-1">Couldn't load recipe</p>
              <p className="text-sm text-[var(--color-text-secondary)] legible pretty break-words">{state.message}</p>
              <p className="text-xs text-[var(--color-text-secondary)] mt-2 break-all">
                <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">{sourceUrl}</a>
              </p>
            </div>
          </div>
          <div className="flex flex-wrap gap-3">
            <button onClick={load} className="btn-secondary text-sm">Try again</button>
            {renderManualImportLink(sourceUrl, (
              <span className="btn-secondary text-sm inline-flex items-center gap-1.5">
                Open manual import →
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (state.kind === 'imported') {
    return (
      <div className="max-w-3xl mx-auto py-12 px-4">
        <div className="card p-6 text-center">
          <p className="font-semibold mb-2">Recipe imported</p>
          {renderRecipeLink(state.slug, (
            <span className="text-accent hover:underline">View in your pantry →</span>
          ))}
        </div>
      </div>
    );
  }

  const recipe = state.recipe;
  const existingSlug = state.kind === 'recipe' ? state.existingSlug : null;
  const importing = state.kind === 'importing';

  return (
    <div className="max-w-3xl mx-auto py-8 px-4">
      {/* Import CTA bar */}
      <div className="card p-4 mb-6 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm text-[var(--color-text-secondary)] break-words min-w-0">
            from <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">{hostnameOf(sourceUrl)}</a>
          </span>
        </div>
        <div className="flex flex-col sm:flex-row gap-2 sm:gap-3 sm:shrink-0">
          {existingSlug ? (
            renderRecipeLink(existingSlug, (
              <span className="btn-secondary text-sm inline-flex items-center justify-center gap-1.5">
                Already in your pantry →
              </span>
            ))
          ) : (
            <button
              onClick={handleImport}
              disabled={importing}
              className="btn-primary text-sm flex items-center justify-center gap-1.5"
            >
              <ArrowSquareIn size={16} />
              {importing ? 'Importing…' : 'Import to your pantry'}
            </button>
          )}
        </div>
      </div>

      {recipe.photoUrl && (
        <img
          src={recipe.photoUrl}
          alt={recipe.title}
          className="w-full rounded-xl mb-6 object-cover max-h-96"
          loading="lazy"
        />
      )}

      <h1 className="text-3xl font-bold mb-2">{recipe.title}</h1>

      <div className="flex flex-wrap gap-4 text-sm text-[var(--color-text-secondary)] mb-6">
        {recipe.servings != null && <span>Serves {recipe.servings}</span>}
        {recipe.prepTime != null && <span>Prep {recipe.prepTime}m</span>}
        {recipe.cookTime != null && <span>Cook {recipe.cookTime}m</span>}
      </div>

      {recipe.description && (
        <p className="text-[var(--color-text-secondary)] mb-6 legible pretty whitespace-pre-line">
          {recipe.description}
        </p>
      )}

      {recipe.tags.length > 0 && (
        <div className="flex flex-wrap gap-2 mb-6">
          {recipe.tags.map((tag) => (
            <span key={tag} className="tag">{tag}</span>
          ))}
        </div>
      )}

      {recipe.ingredients.length > 0 && (
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">Ingredients</h2>
          {groupIngredients(recipe.ingredients).map((g, gi) => {
            const list = (
              <ul className="list-disc pl-6 space-y-1.5 marker:text-[var(--color-text-secondary)]">
                {g.items.map((ing, ii) => (
                  <li key={ii} className="text-sm pl-1">
                    {ing.quantity != null && <span className="font-medium">{Math.round(ing.quantity * 100) / 100}</span>}
                    {ing.unit && <span className="text-[var(--color-text-secondary)]"> {ing.unit}</span>}
                    {' '}{ing.ingredientName}
                  </li>
                ))}
              </ul>
            );
            if (!g.group) return <div key={`g-${gi}`}>{list}</div>;
            return (
              <fieldset key={`g-${gi}`} className="mt-4 first:mt-0">
                <legend className="text-sm font-semibold uppercase tracking-wider text-[var(--color-text-secondary)] mb-2">{g.group}</legend>
                {list}
              </fieldset>
            );
          })}
        </section>
      )}

      {recipe.instructions && (
        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3">Instructions</h2>
          <ol className="list-decimal pl-6 space-y-3 text-[var(--color-text-primary)] legible pretty marker:text-[var(--color-text-secondary)]">
            {recipe.instructions.split(/\n+/).filter((s) => s.trim()).map((step, i) => (
              <li key={i} className="text-sm pl-1">{step.replace(/^\d+\.\s*/, '')}</li>
            ))}
          </ol>
        </section>
      )}

      <p className="text-xs text-[var(--color-text-secondary)] break-all">
        Source: <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">{sourceUrl}</a>
      </p>
    </div>
  );
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return url; }
}
