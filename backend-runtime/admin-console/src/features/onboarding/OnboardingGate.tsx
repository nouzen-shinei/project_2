import { CheckCircle2, Lock, Shield, WifiOff } from 'lucide-react';
import { AuthConfigPanel } from '../settings/AuthConfigPanel';
import { useConfigStore } from '../../store/configStore';

export function OnboardingGate() {
  const { baseUrl, masterKey, bearerToken } = useConfigStore();

  const requirements = [
    {
      key: 'base-url',
      title: 'Backend URL configured',
      description: 'Point the console at the runtime deployment.',
      satisfied: Boolean(baseUrl?.trim()),
    },
    {
      key: 'auth-secret',
      title: 'Master key or token available',
      description: 'Paste the INTERNAL_API_KEY or mint a scoped bearer token for this browser.',
      satisfied: Boolean(masterKey?.trim() || bearerToken?.trim()),
    },
  ];

  const ready = requirements.every((req) => req.satisfied);

  return (
    <div className="gate-wrapper">
      <div className="gate-hero">
        <div className="gate-pill">Secure operator access</div>
        <h1>Authenticate before entering the runtime console</h1>
        <p className="muted">
          We load secrets from encrypted browser storage and require a valid master key or scoped token before exposing telemetry,
          WhatsApp queue controls, and broadcast tooling.
        </p>
        <ul className="gate-checklist">
          {requirements.map((req) => (
            <li key={req.key} className={req.satisfied ? 'ready' : 'pending'}>
              {req.satisfied ? <CheckCircle2 size={18} /> : <WifiOff size={18} />}
              <div>
                <p>{req.title}</p>
                <span>{req.description}</span>
              </div>
            </li>
          ))}
        </ul>
        <div className="gate-actions">
          {ready ? (
            <span className="gate-ready">
              <Shield size={18} /> Secure session ready – console will unlock automatically.
            </span>
          ) : (
            <span className="gate-warning">
              <Lock size={18} /> Complete the checklist to unlock the console.
            </span>
          )}
        </div>
      </div>
      <div className="gate-panel">
        <AuthConfigPanel />
      </div>
    </div>
  );
}
