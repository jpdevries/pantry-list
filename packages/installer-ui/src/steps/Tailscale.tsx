import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import WizardShell from '@/components/WizardShell';
import { api, type TailscaleState } from '@/lib/api';

const POLL_INTERVAL_MS = 1500;

export default function Tailscale() {
  const navigate = useNavigate();
  const [state, setState] = useState<TailscaleState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef(false);

  // If we're landing on this step *already* on the secure tailnet origin
  // with HTTPS configured, there's nothing for the user to do here — the
  // browser address bar already confirms the handoff worked. Skip to the
  // next step so the moment doesn't get lost in a redundant intermediate
  // page.
  useEffect(() => {
    if (state?.state === 'configured' && onSecureOrigin(state.url)) {
      navigate('/bluesky', { replace: true });
    }
  }, [state, navigate]);

  // Initial fetch + poll while we're mid-connect or mid-serve. Once the
  // user lands on `configured` or `not_connected` (and isn't actively
  // doing something), polling backs off.
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const s = await api.getTailscaleStatus();
        if (cancelled) return;
        setState(s);
        // Keep polling while waiting on the user/login server to finish.
        const shouldPoll =
          s.state === 'awaiting_auth' || (pollingRef.current && s.state !== 'configured');
        if (shouldPoll) {
          setTimeout(tick, POLL_INTERVAL_MS);
        }
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Failed to read Tailscale status');
      }
    }
    tick();
    return () => {
      cancelled = true;
    };
  }, []);

  async function startConnect() {
    setBusy(true);
    setError(null);
    pollingRef.current = true;
    try {
      const s = await api.connectTailscale();
      setState(s);
      // Kick the poll loop — useEffect's tick is one-shot once polling
      // settles, so we re-arm it here for the awaiting_auth → running
      // transition.
      pollOnce();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start Tailscale connect');
    } finally {
      setBusy(false);
    }
  }

  async function enableServe() {
    setBusy(true);
    setError(null);
    try {
      const s = await api.enableTailscaleServe();
      setState(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to enable HTTPS');
    } finally {
      setBusy(false);
    }
  }

  function pollOnce() {
    api
      .getTailscaleStatus()
      .then((s) => {
        setState(s);
        if (s.state === 'awaiting_auth' || s.state === 'not_connected') {
          setTimeout(pollOnce, POLL_INTERVAL_MS);
        }
      })
      .catch(() => {
        // Transient errors swallowed — the next manual interaction or
        // re-render will retry.
      });
  }

  const back = { label: 'Back', onClick: () => navigate('/') };
  const next = { label: 'Continue', onClick: () => navigate('/bluesky') };

  if (!state) {
    return (
      <WizardShell stepIndex={2} totalSteps={4} title="Remote access" back={back} primary={{ label: 'Continue', onClick: next.onClick, disabled: true }}>
        <p className="text-[var(--color-text-secondary)]">Checking…</p>
      </WizardShell>
    );
  }

  return (
    <WizardShell
      stepIndex={2}
      totalSteps={4}
      title="Remote access"
      back={back}
      skip={state.state === 'configured' ? undefined : { label: 'Skip for now', onClick: next.onClick }}
      primary={{ label: busy ? 'Working…' : 'Continue', onClick: next.onClick, disabled: busy }}
    >
      <p className="text-lg text-[var(--color-text-secondary)] mb-6">
        Use your pantry securely from anywhere — from your phone at the grocery store, from your
        laptop while traveling — without putting anything on the public internet. We set this up
        with Tailscale, a private network just for your devices. It's also required for mobile
        camera scanning, which needs a secure connection.
      </p>

      {state.state === 'unavailable' && (
        <Panel tone="info">
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">
            Tailscale isn't installed on this device.
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)]">
            Remote access and camera scanning will stay disabled for now. You can install Tailscale
            on your Pantry Host device later, then re-run setup from the Settings menu.
          </p>
        </Panel>
      )}

      {state.state === 'not_connected' && (
        <Panel>
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">
            Sign in to your Tailscale account
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4">
            We'll open a Tailscale login page in your browser. If you don't have a Tailscale
            account, you can create a free one — it works with Google, Microsoft, GitHub, or email.
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={startConnect}
            disabled={busy}
          >
            {busy ? 'Starting…' : 'Sign in with Tailscale'}
          </button>
        </Panel>
      )}

      {state.state === 'awaiting_auth' && (
        <Panel tone="info">
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">
            Open this link to finish signing in
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4">
            You can open it on this device or scan it from your phone. We'll detect when sign-in
            completes — keep this page open.
          </p>
          <a
            href={state.auth_url}
            target="_blank"
            rel="noreferrer"
            className="btn-primary inline-block break-all"
          >
            Open Tailscale login
          </a>
          <p className="mt-3 text-xs text-[var(--color-text-secondary)] break-all">
            {state.auth_url}
          </p>
        </Panel>
      )}

      {state.state === 'connected_no_serve' && (
        <Panel>
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">
            Signed in as <span className="font-mono text-sm">{state.tailnet}</span>
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4">
            One more step: turn on the secure tunnel so your other devices can reach this pantry.
            It takes a few seconds.
          </p>
          <button
            type="button"
            className="btn-primary"
            onClick={enableServe}
            disabled={busy}
          >
            {busy ? 'Enabling secure access…' : 'Enable secure access'}
          </button>
        </Panel>
      )}

      {state.state === 'configured' && !onSecureOrigin(state.url) && (
        <Panel tone="success">
          <h2 className="font-semibold text-[var(--color-text-primary)] mb-1">
            Your secure URL is ready.
          </h2>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4">
            This is how you'll reach your pantry from anywhere — your phone, your laptop, away from
            home. Open it now to finish setup on the secure connection.
          </p>
          <a
            href={`${state.url}/setup/bluesky`}
            className="btn-primary inline-block break-all"
          >
            Open {hostOf(state.url)}
          </a>
          <p className="mt-3 text-xs text-[var(--color-text-secondary)] break-all">
            {state.url}
          </p>
        </Panel>
      )}

      {state.state === 'configured' && onSecureOrigin(state.url) && (
        // The auto-navigate effect above will redirect to /summary on the
        // next tick; this is the brief loading state in between.
        <Panel>
          <p className="text-sm text-[var(--color-text-secondary)]">Loading…</p>
        </Panel>
      )}

      {error && (
        <p role="alert" className="mt-4 text-sm text-[var(--color-danger,#dc2626)]">
          {error}
        </p>
      )}
    </WizardShell>
  );
}

/** True if the browser is already viewing the wizard on the secure tailnet
 *  origin. Used to switch the "configured" panel between the "switch over"
 *  CTA and the "you're already secure" confirmation. */
function onSecureOrigin(url: string): boolean {
  try {
    return new URL(url).host === window.location.host;
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Panel({
  children,
  tone = 'default',
}: {
  children: React.ReactNode;
  tone?: 'default' | 'info' | 'success';
}) {
  const border =
    tone === 'success'
      ? 'border-[var(--color-accent)]'
      : 'border-[var(--color-border-card)]';
  return (
    <div
      className={`rounded-lg border ${border} bg-[var(--color-bg-card)] px-5 py-4`}
    >
      {children}
    </div>
  );
}
