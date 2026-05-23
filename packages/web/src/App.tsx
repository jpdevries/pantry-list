import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Layout from './Layout';
import HomePage from './pages/HomePage';
import RecipesPage from './pages/RecipesPage';
import RecipeDetailPage from './pages/RecipeDetailPage';
import RecipeNewPage from './pages/RecipeNewPage';
import RecipeEditPage from './pages/RecipeEditPage';
import IngredientsPage from './pages/IngredientsPage';
import GroceryListPage from './pages/GroceryListPage';
import CookwarePage from './pages/CookwarePage';
import CookwareDetailPage from './pages/CookwareDetailPage';
import MenusPage from './pages/MenusPage';
import MenuDetailPage from './pages/MenuDetailPage';
import MenuNewPage from './pages/MenuNewPage';
import MenuEditPage from './pages/MenuEditPage';
import BlueskyFeedsPage from './pages/BlueskyFeedsPage';
import BlueskyMenuFeedsPage from './pages/BlueskyMenuFeedsPage';
import RecipeImportPage from './pages/RecipeImportPage';
import KitchensPage from './pages/KitchensPage';
import AccessibilityPage from './pages/AccessibilityPage';
import SettingsPage from './pages/SettingsPage';
import AtImportPage from './pages/AtImportPage';
import UrlImportPage from './pages/UrlImportPage';
import MealdbImportPage from './pages/MealdbImportPage';
import CocktaildbImportPage from './pages/CocktaildbImportPage';
import PublicDomainImportPage from './pages/PublicDomainImportPage';
import RecipeApiImportPage from './pages/RecipeApiImportPage';
import CooklangImportPage from './pages/CooklangImportPage';
import WikibooksImportPage from './pages/WikibooksImportPage';

/**
 * Kitchen-scoped routes — rendered at both top level (home kitchen)
 * and under /kitchens/:kitchen/. The :kitchen param is read by
 * useKitchen() hook; when absent (top-level), defaults to 'home'.
 */
/** Catch in-app navigation to `/kitchens/home/…` and swap the URL to the
 *  short alias (`/…`) before rendering. External / bookmark traffic is
 *  handled at the Cloudflare Pages edge via `public/_redirects`; this
 *  parallel client-side redirect catches everything that stays inside
 *  the SPA (Link clicks, programmatic navigate, etc.). */
function HomeRedirect() {
  const location = useLocation();
  const short = (location.pathname.replace(/^\/kitchens\/home/, '') || '/')
    + location.search + location.hash;
  return <Navigate to={short} replace />;
}

const KITCHEN_ROUTES = [
  { path: 'recipes', element: <RecipesPage /> },
  { path: 'recipes/new', element: <RecipeNewPage /> },
  { path: 'recipes/import', element: <RecipeImportPage /> },
  { path: 'recipes/feeds/bluesky', element: <BlueskyFeedsPage /> },
  { path: 'recipes/:slug', element: <RecipeDetailPage /> },
  { path: 'recipes/:slug/edit', element: <RecipeEditPage /> },
  { path: 'ingredients', element: <IngredientsPage /> },
  { path: 'list', element: <GroceryListPage /> },
  { path: 'cookware', element: <CookwarePage /> },
  { path: 'cookware/:id', element: <CookwareDetailPage /> },
  { path: 'menus', element: <MenusPage /> },
  { path: 'menus/new', element: <MenuNewPage /> },
  { path: 'menus/feeds/bluesky', element: <BlueskyMenuFeedsPage /> },
  { path: 'menus/:slug', element: <MenuDetailPage /> },
  { path: 'menus/:slug/edit', element: <MenuEditPage /> },
];

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<HomePage />} />
          {/* Top-level = home kitchen */}
          {KITCHEN_ROUTES.map((r) => (
            <Route key={r.path} path={`/${r.path}`} element={r.element} />
          ))}
          {/* Kitchen-scoped */}
          <Route path="/kitchens" element={<KitchensPage />} />
          {/* /kitchens/home/… short-circuits to the root alias so the
              URL bar matches what Cloudflare serves for external traffic.
              Each /kitchens/home/X route is registered with the same
              concrete path shape as its /kitchens/:kitchen/X counterpart
              so React Router's match-specificity scoring picks the
              literal `home` over the `:kitchen` wildcard. A bare splat
              route would lose to the concrete kitchen-scoped routes. */}
          <Route path="/kitchens/home" element={<HomeRedirect />} />
          {KITCHEN_ROUTES.map((r) => (
            <Route key={`h-${r.path}`} path={`/kitchens/home/${r.path}`} element={<HomeRedirect />} />
          ))}
          <Route path="/kitchens/home/at/*" element={<HomeRedirect />} />
          <Route path="/kitchens/:kitchen" element={<HomePage />} />
          {KITCHEN_ROUTES.map((r) => (
            <Route key={`k-${r.path}`} path={`/kitchens/:kitchen/${r.path}`} element={r.element} />
          ))}
          {/* /at/... is the top-level alias (defaults to home kitchen);
              /kitchens/:kitchen/at/... scopes the import to that kitchen. */}
          <Route path="/at/*" element={<AtImportPage />} />
          <Route path="/kitchens/:kitchen/at/*" element={<AtImportPage />} />
          <Route path="/http/*" element={<UrlImportPage scheme="http" />} />
          <Route path="/https/*" element={<UrlImportPage scheme="https" />} />
          <Route path="/import/mealdb/:idMeal" element={<MealdbImportPage />} />
          <Route path="/kitchens/:kitchen/import/mealdb/:idMeal" element={<MealdbImportPage />} />
          <Route path="/import/cocktaildb/:idDrink" element={<CocktaildbImportPage />} />
          <Route path="/kitchens/:kitchen/import/cocktaildb/:idDrink" element={<CocktaildbImportPage />} />
          <Route path="/import/publicdomain/:slug" element={<PublicDomainImportPage />} />
          <Route path="/kitchens/:kitchen/import/publicdomain/:slug" element={<PublicDomainImportPage />} />
          <Route path="/import/recipe-api/:id" element={<RecipeApiImportPage />} />
          <Route path="/kitchens/:kitchen/import/recipe-api/:id" element={<RecipeApiImportPage />} />
          <Route path="/import/cooklang/:id" element={<CooklangImportPage />} />
          <Route path="/kitchens/:kitchen/import/cooklang/:id" element={<CooklangImportPage />} />
          <Route path="/import/wikibooks/:slug" element={<WikibooksImportPage />} />
          <Route path="/kitchens/:kitchen/import/wikibooks/:slug" element={<WikibooksImportPage />} />
          <Route path="/accessibility" element={<AccessibilityPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
