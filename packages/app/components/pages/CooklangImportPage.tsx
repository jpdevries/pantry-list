/**
 * Cooklang Federation single-recipe import preview page.
 *
 * Federation has a 60req/min ceiling; the import grid throttles at 40
 * req/min for the image-probe queue. This page only makes one fetch
 * per visit, so it doesn't need its own throttle, but heavy direct
 * navigation could still hit the limit. Treat errors gracefully.
 */
import { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import ImportPreview, { type ImportPreviewState } from '@pantry-host/shared/components/ImportPreview';
import { getFederationRecipe, cooklangToRecipe } from '@pantry-host/shared/cooklang';
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

export default function CooklangImportPage({ id }: Props) {
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
    const numId = parseInt(id, 10);
    if (!Number.isFinite(numId)) {
      setState({ kind: 'error', message: `Invalid Cooklang recipe id: "${id}".` });
      return;
    }
    try {
      const raw = await getFederationRecipe(numId);
      const parsed = cooklangToRecipe(raw);
      const recipe: ParsedRecipe = {
        title: parsed.title,
        description: parsed.description ?? undefined,
        instructions: parsed.instructions,
        servings: parsed.servings ?? undefined,
        prepTime: parsed.prepTime ?? undefined,
        cookTime: parsed.cookTime ?? undefined,
        tags: parsed.tags,
        photoUrl: parsed.photoUrl ?? undefined,
        sourceUrl: parsed.sourceUrl ?? `https://cooklang.org/recipes/${numId}`,
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
        <meta name="description" content="Preview a Cooklang Federation recipe before importing." />
      </Head>
      <ImportPreview
        state={state}
        sourceLabel="Cooklang Federation"
        attributionLabel="cooklang.org"
        sourceAttributionUrl="https://cooklang.org/"
        shareUrl={shareUrl}
        existingSlug={existingSlug}
        onImport={handleImport}
        onRetry={load}
        renderRecipeLink={renderRecipeLink}
      />
    </>
  );
}
