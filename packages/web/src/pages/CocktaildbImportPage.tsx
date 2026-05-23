import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import ImportPreview, { type ImportPreviewState } from '@pantry-host/shared/components/ImportPreview';
import { getCocktailDBRecipe, drinkToRecipe } from '@pantry-host/shared/cocktaildb';
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

export default function CocktaildbImportPage() {
  const { idDrink, kitchen: kitchenParam } = useParams<{ idDrink: string; kitchen?: string }>();
  const kitchen = kitchenParam ?? 'home';
  const [state, setState] = useState<ImportPreviewState>({ kind: 'loading' });
  const [existingSlug, setExistingSlug] = useState<string | null>(null);
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';

  const checkDuplicate = useCallback(async (sourceUrl: string) => {
    try {
      const data = await gql<{ recipes: { id: string; slug: string; sourceUrl: string | null }[] }>(RECIPES_QUERY);
      return data.recipes.find((r) => r.sourceUrl === sourceUrl)?.slug ?? null;
    } catch { return null; }
  }, []);

  const load = useCallback(async () => {
    if (!idDrink) return;
    setState({ kind: 'loading' });
    if (typeof window !== 'undefined' && localStorage.getItem('age-verified') !== 'true') {
      setState({ kind: 'error', message: 'TheCocktailDB is 21+. Verify your age on /recipes/import first.' });
      return;
    }
    try {
      const drink = await getCocktailDBRecipe(idDrink);
      if (!drink) {
        setState({ kind: 'error', message: `Drink ${idDrink} not found on TheCocktailDB.` });
        return;
      }
      const converted = drinkToRecipe(drink);
      const recipe: ParsedRecipe = {
        title: converted.title,
        description: undefined,
        instructions: converted.instructions,
        tags: converted.tags,
        photoUrl: converted.photoUrl ?? undefined,
        sourceUrl: converted.sourceUrl ?? `https://www.thecocktaildb.com/drink/${idDrink}`,
        ingredients: converted.ingredients,
      };
      const dup = await checkDuplicate(recipe.sourceUrl);
      setExistingSlug(dup);
      setState({ kind: 'recipe', recipe });
    } catch (err) {
      setState({ kind: 'error', message: (err as Error).message });
    }
  }, [idDrink, checkDuplicate]);

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

  if (!idDrink) return <div className="max-w-3xl mx-auto py-12 px-4">Missing drink id.</div>;

  return (
    <ImportPreview
      state={state}
      sourceLabel="TheCocktailDB"
      sourceAttributionUrl={`https://www.thecocktaildb.com/drink/${idDrink}`}
      attributionLabel="thecocktaildb.com"
      shareUrl={shareUrl}
      existingSlug={existingSlug}
      onImport={handleImport}
      onRetry={load}
      renderRecipeLink={renderRecipeLink}
    />
  );
}
