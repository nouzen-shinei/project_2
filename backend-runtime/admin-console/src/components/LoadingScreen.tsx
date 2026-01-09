import { Loader2 } from 'lucide-react';

export function LoadingScreen() {
  return (
    <div className="loading-screen">
      <div className="loading-card">
        <Loader2 className="loading-spinner" size={48} />
        <h1>Booting admin console…</h1>
        <p className="muted">Fetching secure storage and wiring up runtime access.</p>
      </div>
    </div>
  );
}
