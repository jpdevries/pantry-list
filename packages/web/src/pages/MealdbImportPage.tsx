/**
 * TheMealDB single-recipe import preview page — web package.
 *
 * Mirrors the app-side MealdbImportPage. Fetches via the shared
 * mealdb module and renders the shared ImportPreview component.
 */
import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import ImportPreview, { type ImportPreviewState } from '@pantry-host/shared/components/ImportPreview';
import { getMealDBRecipe, mealToRecipe } from '@pantry-host/shared/mealdb';
import type { ParsedRecipe } from '@pantry-host/shared/bluesky';
import { gql } from '@/lib/gql';

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

const RECIPES_QUERY = `{ recipes { id slug sourceUrl } }`;

export default function MealdbImportPage() {
  const { idMeal, kitchen: kitchenParam } = useParams<{ idMeal: string; kitchen?: string }>();
  const kitchen = kitchenParam ?? 'home';
  const [state, setState] = useState<ImportPreviewState>({ kind: 'loading' });
  const [existingSlug, setExistingSlug] = useState<string | null>(null);
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  const checkDuplicate = useCallback(async (sourceUrl: string) => {
    try {
      const data = await gql<{ recipes: { id: string; slug: string; sourceUrl: string | null }[] }>(RECIPES_QUERY);
      const match = data.recipes.find((r) => r.sourceUrl === sourceUrl);
      return match?.slug ?? null;
    } catch { return null; }
  }, []);

  const load = useCallback(async () => {
    if (!idMeal) return;
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
    <Link to={`/kitchens/${kitchen}/recipes/${slug}#stage`}>{children}</Link>
  ), [kitchen]);

  if (!idMeal) {
    return <div className="max-w-3xl mx-auto py-12 px-4">Missing recipe id.</div>;
  }

  return (
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
  );
}
