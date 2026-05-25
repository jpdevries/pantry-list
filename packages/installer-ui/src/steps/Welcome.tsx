import { useNavigate } from 'react-router-dom';
import WizardShell from '@/components/WizardShell';

export default function Welcome() {
  const navigate = useNavigate();
  return (
    <WizardShell
      stepIndex={1}
      totalSteps={4}
      title="Welcome to your pantry."
      primary={{ label: 'Get started', onClick: () => navigate('/tailscale') }}
    >
      <p className="text-lg text-[var(--color-text-secondary)] mb-6">
        Let's get a few things set up — it'll take about two minutes.
      </p>
      <ul className="space-y-3 text-[var(--color-text-primary)]">
        <li className="flex items-start gap-3">
          <span className="mt-1 inline-block h-2 w-2 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
          <span>
            <span className="font-semibold">Remote access.</span>{' '}
            <span className="text-[var(--color-text-secondary)]">
              Reach your pantry securely from anywhere — your phone, your laptop, away from home.
              Required for mobile camera scanning.
            </span>
          </span>
        </li>
        <li className="flex items-start gap-3">
          <span className="mt-1 inline-block h-2 w-2 rounded-full bg-[var(--color-accent)]" aria-hidden="true" />
          <span>
            <span className="font-semibold">Bluesky sharing.</span>{' '}
            <span className="text-[var(--color-text-secondary)]">
              Optionally publish and discover recipes on the open social web.
            </span>
          </span>
        </li>
      </ul>
      <p className="mt-8 text-sm text-[var(--color-text-secondary)]">
        Everything here is optional — you can change it later in Settings.
      </p>
    </WizardShell>
  );
}
