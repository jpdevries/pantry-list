/**
 * Wikibooks Cookbook single-recipe import preview page.
 *
 * Wikibooks data isn't per-record fetchable from upstream; the app
 * caches the full dataset in `.cache/wikibooks-cookbook.json` via the
 * /api/wikibooks endpoint. The detail page queries that endpoint with
 * a slug lookup parameter.
 */
import { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import ImportPreview, { type ImportPreviewState } from '@pantry-host/shared/components/ImportPreview';
import { parseIngredientLine, type WikibooksEntry } from '@pantry-host/shared/wikibooks';
import type { ParsedRecipe } from '@pantry-host/shared/bluesky';
import { gql } from '@/lib/gql';
import { useKitchen } from '@/lib/kitchen-context';
import { isBrowser } from '@pantry-host/shared/env';

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
    ) { id slug }
  }
`;

const RECIPES_QUERY = `query($kitchenSlug:String){ recipes(kitchenSlug:$kitchenSlug){ id slug sourceUrl } }`;

interface Props { slug: string; }

function wikibooksToParsed(entry: WikibooksEntry): ParsedRecipe {
  const parsedIngredients = entry.ingredients.map((line) => parseIngredientLine(line));
  return {
    title: entry.title,
    description: undefined,
    instructions: entry.instructions,
    servings: entry.servings ?? undefined,
    prepTime: undefined,
    cookTime: undefined,
    tags: entry.tags,
    photoUrl: undefined,
    sourceUrl: entry.sourceUrl,
    ingredients: parsedIngredients,
  };
}

export default function WikibooksImportPage({ slug }: Props) {
  const kitchen = useKitchen();
  const [state, setState] = useState<ImportPreviewState>({ kind: 'loading' });
  const [existingSlug, setExistingSlug] = useState<string | null>(null);
  const shareUrl = isBrowser ? window.location.href : '';

  const checkDuplicate = useCallback(async (sourceUrl: string) => {
    try {
      const data = await gql<{ recipes: { id: string; slug: string; sourceUrl: string | null }[] }>(RECIPES_QUERY, { kitchenSlug: kitchen });
      return data.recipes.find((r) => r.sourceUrl === sourceUrl)?.slug ?? null;
    } catch { return null; }
  }, [kitchen]);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch(`/api/wikibooks?slug=${encodeURIComponent(slug)}`);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setState({ kind: 'error', message: data?.error ?? `Failed to load Wikibooks recipe (HTTP ${res.status}).` });
        return;
      }
      const data = await res.json() as { entry: WikibooksEntry };
      const recipe = wikibooksToParsed(data.entry);
      const dup = await checkDuplicate(recipe.sourceUrl);
      setExistingSlug(dup);
      setState({ kind: 'recipe', recipe });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, [slug, checkDuplicate]);

  useEffect(() => { load(); }, [load]);

  async function handleImport() {
    if (state.kind !== 'recipe') return;
    const { recipe } = state;
    setState({ kind: 'importing', recipe });
    try {
      const data = await gql<{ createRecipe: { id: string; slug: string } }>(CREATE_RECIPE, {
        title: recipe.title,
        description: recipe.description ?? null,
        instructions: recipe.instructions,
        servings: recipe.servings ?? null,
        prepTime: recipe.prepTime ?? null,
        cookTime: recipe.cookTime ?? null,
        tags: recipe.tags,
        photoUrl: recipe.photoUrl ?? null,
        sourceUrl: recipe.sourceUrl,
        ingredients: recipe.ingredients.map((i) => ({
          ingredientName: i.ingredientName,
          quantity: i.quantity ?? null,
          unit: i.unit ?? null,
        })),
        kitchenSlug: kitchen,
      });
      setState({ kind: 'imported', slug: data.createRecipe.slug });
    } catch (err) {
      setState({ kind: 'error', message: `Import failed: ${(err as Error).message}` });
    }
  }

  const renderRecipeLink = useCallback((slugOut: string, children: React.ReactNode) => (
    <a href={`/kitchens/${kitchen}/recipes/${slugOut}#stage`}>{children}</a>
  ), [kitchen]);

  return (
    <>
      <Head>
        <title>Import Recipe | Pantry Host</title>
        <meta name="description" content="Preview a Wikibooks Cookbook recipe before importing." />
      </Head>
      <ImportPreview
        state={state}
        sourceLabel="Wikibooks Cookbook"
        attributionLabel="en.wikibooks.org"
        sourceAttributionUrl="https://en.wikibooks.org/wiki/Cookbook"
        shareUrl={shareUrl}
        existingSlug={existingSlug}
        onImport={handleImport}
        onRetry={load}
        renderRecipeLink={renderRecipeLink}
      />
    </>
  );
}
