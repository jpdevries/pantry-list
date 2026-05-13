/**
 * TheMealDB single-recipe import preview page.
 *
 * Mirrors AtImportPage's shape — fetches a MealDB recipe by id, runs
 * the duplicate-check against existing recipes' sourceUrl, and renders
 * the shared ImportPreview. Used by `/import/mealdb/{idMeal}` and
 * `/kitchens/{kitchen}/import/mealdb/{idMeal}` (future).
 */
import { useState, useEffect, useCallback } from 'react';
import Head from 'next/head';
import ImportPreview, { type ImportPreviewState } from '@pantry-host/shared/components/ImportPreview';
import { getMealDBRecipe, mealToRecipe } from '@pantry-host/shared/mealdb';
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

interface Props {
  idMeal: string;
}

export default function MealdbImportPage({ idMeal }: Props) {
  const kitchen = useKitchen();
  const [state, setState] = useState<ImportPreviewState>({ kind: 'loading' });
  const [existingSlug, setExistingSlug] = useState<string | null>(null);
  const shareUrl = isBrowser ? window.location.href : '';

  const checkDuplicate = useCallback(async (sourceUrl: string) => {
    try {
      const data = await gql<{ recipes: { id: string; slug: string; sourceUrl: string | null }[] }>(RECIPES_QUERY, { kitchenSlug: kitchen });
      const match = data.recipes.find((r) => r.sourceUrl === sourceUrl);
      return match?.slug ?? null;
    } catch { return null; }
  }, [kitchen]);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const meal = await getMealDBRecipe(idMeal);
      if (!meal) {
        setState({ kind: 'error', message: `Recipe ${idMeal} not found on TheMealDB.` });
        return;
      }
      const converted = mealToRecipe(meal);
      const recipe: ParsedRecipe = {
        title: converted.title,
        description: undefined,
        instructions: converted.instructions,
        tags: converted.tags,
        photoUrl: converted.photoUrl ?? undefined,
        sourceUrl: converted.sourceUrl ?? `https://www.themealdb.com/meal/${idMeal}`,
        ingredients: converted.ingredients,
      };
      const dup = await checkDuplicate(recipe.sourceUrl);
      setExistingSlug(dup);
      setState({ kind: 'recipe', recipe });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, [idMeal, checkDuplicate]);

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
        <meta name="description" content="Preview a recipe from TheMealDB before importing into your Pantry Host." />
      </Head>
      {/* #stage anchor is rendered by the route wrapper at
          pages/import/mealdb/[idMeal].tsx so it exists in the DOM
          before idMeal parses — see the comment there. */}
      <ImportPreview
        state={state}
        sourceLabel="TheMealDB"
        sourceAttributionUrl={`https://www.themealdb.com/meal/${idMeal}`}
        attributionLabel="themealdb.com"
        shareUrl={shareUrl}
        existingSlug={existingSlug}
        onImport={handleImport}
        onRetry={load}
        renderRecipeLink={renderRecipeLink}
      />
    </>
  );
}
