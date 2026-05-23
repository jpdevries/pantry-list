import { useState, useEffect } from 'react';
import MealdbImportPage from '@/components/pages/MealdbImportPage';
import { isServer } from '@pantry-host/shared/env';

/** Top-level `/import/mealdb/{idMeal}` route. Imports land in the
 *  `home` kitchen by default, mirroring the `/at/*` alias.
 *
 *  The <main id="stage"> wrapper is rendered synchronously on the first
 *  client render (and on SSR) so the #stage anchor exists in the DOM
 *  before any state hooks resolve. Without this, the route wrapper
 *  initially returns `null` while idMeal parses, _app.tsx's hash-scroll
 *  workaround misses the anchor on first mount, and the page paints
 *  with the (mobile-tall) Nav at the top of the viewport before the
 *  300ms retry kicks in and snaps to <main>. */
export default function MealdbImportRoute() {
  const [idMeal, setIdMeal] = useState<string | null>(null);
  useEffect(() => {
    if (isServer) return;
    const match = window.location.pathname.match(/^\/import\/mealdb\/([^/?#]+)/);
    setIdMeal(match ? decodeURIComponent(match[1]) : '');
  }, []);
  return (
    <main id="stage" className="max-sm:min-h-screen">
      {idMeal === null ? null
        : !idMeal ? <div className="max-w-3xl mx-auto py-12 px-4">Missing recipe id.</div>
        : <MealdbImportPage idMeal={idMeal} />}
    </main>
  );
}
