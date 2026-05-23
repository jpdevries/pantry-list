import { useState, useEffect } from 'react';
import CocktaildbImportPage from '@/components/pages/CocktaildbImportPage';
import { isServer } from '@pantry-host/shared/env';

/** See pages/import/mealdb/[idMeal].tsx for why <main id="stage"> is
 *  rendered here synchronously (before idDrink resolves). */
export default function CocktaildbImportRoute() {
  const [idDrink, setIdDrink] = useState<string | null>(null);
  useEffect(() => {
    if (isServer) return;
    const match = window.location.pathname.match(/^\/import\/cocktaildb\/([^/?#]+)/);
    setIdDrink(match ? decodeURIComponent(match[1]) : '');
  }, []);
  return (
    <main id="stage" className="max-sm:min-h-screen">
      {idDrink === null ? null
        : !idDrink ? <div className="max-w-3xl mx-auto py-12 px-4">Missing drink id.</div>
        : <CocktaildbImportPage idDrink={idDrink} />}
    </main>
  );
}
