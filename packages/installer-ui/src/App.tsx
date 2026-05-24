import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { api, type SetupStatus } from '@/lib/api';
import Welcome from '@/steps/Welcome';
import Tailscale from '@/steps/Tailscale';
import Bluesky from '@/steps/Bluesky';
import Summary from '@/steps/Summary';

export default function App() {
  const [status, setStatus] = useState<SetupStatus | null>(null);

  useEffect(() => {
    api.getSetupStatus().then(setStatus).catch(() => {
      // If the API isn't reachable we still render the welcome screen so the
      // user sees something — the Finish call will surface the real error.
      setStatus({
        complete: false,
        integrations: {
          tailscale: { state: 'not_configured' },
          bluesky: { state: 'not_configured' },
        },
      });
    });
  }, []);

  if (!status) return null;

  return (
    <BrowserRouter basename="/setup">
      <Routes>
        <Route path="/" element={<Welcome />} />
        <Route path="/tailscale" element={<Tailscale />} />
        <Route path="/bluesky" element={<Bluesky />} />
        <Route
          path="/summary"
          element={<Summary tailscale={status.integrations.tailscale} bluesky={status.integrations.bluesky} />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
