/**
 * Recipe-API single-recipe import preview page.
 *
 * Recipe-API requires an API key (owner-gated via /api/recipe-api-key).
 * If no key is available we show an error pointing the user to /settings.
 *
 * Note: Recipe-API responses don't include photo URLs; the preview will
 * render text-only above the fold.
 */
import { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import ImportPreview, { type ImportPreviewState } from '@pantry-host/shared/components/ImportPreview';
import { getRecipeAPIRecipe, recipeApiToParsed } from '@pantry-host/shared/recipe-api';
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

interface Props { id: string; }

export default function RecipeApiImportPage({ id }: Props) {
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
      const keyRes = await fetch('/api/recipe-api-key').then((r) => r.json()).catch(() => ({ key: null }));
      const apiKey: string | null = keyRes?.key ?? null;
      if (!apiKey) {
        setState({ kind: 'error', message: 'Recipe-API requires a key. Add RECIPE_API_KEY in /settings.' });
        return;
      }
      const raw = await getRecipeAPIRecipe(id, apiKey);
      const parsed = recipeApiToParsed(raw);
      const recipe: ParsedRecipe = {
        title: parsed.title,
        description: parsed.description ?? undefined,
        instructions: parsed.instructions,
        servings: parsed.servings ?? undefined,
        prepTime: parsed.prepTime ?? undefined,
        cookTime: parsed.cookTime ?? undefined,
        tags: parsed.tags,
        photoUrl: parsed.photoUrl ?? undefined,
        sourceUrl: parsed.sourceUrl ?? `https://recipe-api.com/recipes/${id}`,
        ingredients: parsed.ingredients,
      };
      const dup = await checkDuplicate(recipe.sourceUrl);
      setExistingSlug(dup);
      setState({ kind: 'recipe', recipe });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, [id, checkDuplicate]);

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

  const renderRecipeLink = useCallback((slug: string, children: React.ReactNode) => (
    <a href={`/kitchens/${kitchen}/recipes/${slug}#stage`}>{children}</a>
  ), [kitchen]);

  return (
    <>
      <Head>
        <title>Import Recipe | Pantry Host</title>
        <meta name="description" content="Preview a Recipe-API recipe before importing." />
      </Head>
      <ImportPreview
        state={state}
        sourceLabel="Recipe-API"
        sourceAttributionUrl={`https://recipe-api.com/recipes/${id}`}
        attributionLabel="recipe-api.com"
        shareUrl={shareUrl}
        existingSlug={existingSlug}
        onImport={handleImport}
        onRetry={load}
        renderRecipeLink={renderRecipeLink}
      />
    </>
  );
}
