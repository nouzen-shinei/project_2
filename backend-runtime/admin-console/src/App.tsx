import { useState } from 'react';
import clsx from 'clsx';
import { BarChart3, Building2, CreditCard, GaugeCircle, MessageCircle, MessageSquareDashed, Megaphone, PhoneCall, Settings2, type LucideIcon } from 'lucide-react';
import { AuthConfigPanel } from './features/settings/AuthConfigPanel';
import { RuntimeEndpointsPanel } from './features/settings/RuntimeEndpointsPanel';
import { MaintenanceModePanel } from './features/settings/MaintenanceModePanel';
import { ReminderChannelsPanel } from './features/settings/ReminderChannelsPanel';
import { GlobalAdminClaimsPanel } from './features/settings/GlobalAdminClaimsPanel';
import { DiagnosticsPanel } from './features/diagnostics/DiagnosticsPanel';
import { WhatsAppPanel } from './features/whatsapp/WhatsAppPanel';
import { NotificationsPanel } from './features/notifications/NotificationsPanel';
import { NotificationDashboardPanel } from './features/notifications/NotificationDashboardPanel';
import { TwilioPanel } from './features/twilio/TwilioPanel';
import { ChatPanel } from './features/chat/ChatPanel';
import { OverviewPanel } from './features/overview/OverviewPanel';
import { OnboardingGate } from './features/onboarding/OnboardingGate';
import { LoadingScreen } from './components/LoadingScreen';
import { useConfigHydration } from './hooks/useStoreHydration';
import { useConfigStore, type ConfigState } from './store/configStore';
import { TenantDirectoryPanel } from './features/tenants/TenantDirectoryPanel';
import { UsageAnalyticsPanel } from './features/tenants/UsageAnalyticsPanel';
import { BillingCatalogPanel } from './features/billing/BillingCatalogPanel';
import { BillingOpsPanel } from './features/billing/BillingOpsPanel';

type PanelComponent = () => JSX.Element;
type TabId = 'overview' | 'queue' | 'broadcasts' | 'telephony' | 'chat' | 'tenants' | 'usage' | 'billing' | 'settings';

interface TabDefinition {
  id: TabId;
  label: string;
  description: string;
  icon: LucideIcon;
  panels: PanelComponent[];
}

const TAB_CONFIG: TabDefinition[] = [
  {
    id: 'overview',
    label: 'Overview',
    description: 'Runtime health, queue depth, and failure telemetry.',
    icon: GaugeCircle,
    panels: [OverviewPanel, DiagnosticsPanel],
  },
  {
    id: 'queue',
    label: 'WhatsApp queue',
    description: 'Fee reminders, confirmations, and event jobs.',
    icon: MessageSquareDashed,
    panels: [WhatsAppPanel],
  },
  {
    id: 'broadcasts',
    label: 'Notifications',
    description: 'Global delivery health plus broadcast triggers.',
    icon: Megaphone,
    panels: [NotificationsPanel, NotificationDashboardPanel],
  },
  {
    id: 'telephony',
    label: 'Twilio bridge',
    description: 'SMS + voice calls via stored Twilio creds.',
    icon: PhoneCall,
    panels: [TwilioPanel],
  },
  {
    id: 'chat',
    label: 'Chat tools',
    description: 'Delta fetch, edits, deletion, SSE stream.',
    icon: MessageCircle,
    panels: [ChatPanel],
  },
  {
    id: 'tenants',
    label: 'Tenant directory',
    description: 'Search tenants, inspect memberships, and manage quotas.',
    icon: Building2,
    panels: [TenantDirectoryPanel],
  },
  {
    id: 'usage',
    label: 'Usage analytics',
    description: 'Usage summaries, trends, headroom, and CSV exports.',
    icon: BarChart3,
    panels: [UsageAnalyticsPanel],
  },
  {
    id: 'billing',
    label: 'Billing',
    description: 'Manage catalog, view ops events, and run backfills.',
    icon: CreditCard,
    panels: [BillingCatalogPanel, BillingOpsPanel],
  },
  {
    id: 'settings',
    label: 'Connection & auth',
    description: 'Base URL, master key, scoped console tokens, and runtime endpoints.',
    icon: Settings2,
    panels: [AuthConfigPanel, GlobalAdminClaimsPanel, RuntimeEndpointsPanel, MaintenanceModePanel, ReminderChannelsPanel],
  },
];

export default function App() {
  const baseUrl = useConfigStore((state: ConfigState) => state.baseUrl);
  const bearerToken = useConfigStore((state: ConfigState) => state.bearerToken);
  const masterKey = useConfigStore((state: ConfigState) => state.masterKey);
  const hydrated = useConfigHydration();

  const isMembershipInspectorView = (() => {
    if (typeof window === 'undefined') return false;
    const view = new URLSearchParams(window.location.search).get('view');
    return (view || '').trim().toLowerCase() === 'membership-inspector';
  })();

  const [activeTab, setActiveTab] = useState<TabId>(() => {
    if (typeof window === 'undefined') return 'overview';
    const raw = new URLSearchParams(window.location.search).get('tab');
    const normalized = (raw || '').trim().toLowerCase();
    if (
      normalized === 'overview' ||
      normalized === 'queue' ||
      normalized === 'broadcasts' ||
      normalized === 'telephony' ||
      normalized === 'chat' ||
      normalized === 'tenants' ||
      normalized === 'usage' ||
      normalized === 'billing' ||
      normalized === 'settings'
    ) {
      return normalized;
    }
    return 'overview';
  });
  const isReady = Boolean(baseUrl?.trim()) && Boolean((bearerToken?.trim() || masterKey?.trim()));
  const activeConfig = TAB_CONFIG.find((tab) => tab.id === activeTab) ?? TAB_CONFIG[0];

  if (!hydrated) {
    return <LoadingScreen />;
  }

  if (!isReady) {
    return <OnboardingGate />;
  }

  if (isMembershipInspectorView) {
    return (
      <div className="app-shell">
        <main className="main">
          <div className="page-grid page-grid--single">
            <TenantDirectoryPanel />
          </div>
        </main>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Backend Runtime Console</h1>
        <p className="muted">Purpose-built operator UI for the isolated WhatsApp + notification runtime.</p>
        <dl style={{ marginTop: '1.2rem' }}>
          <dt className="muted">Backend URL</dt>
          <dd>{baseUrl || '— not configured —'}</dd>
          <dt className="muted" style={{ marginTop: '0.8rem' }}>Bearer token</dt>
          <dd>{bearerToken ? 'Stored' : '— issue via auth panel —'}</dd>
        </dl>
      </aside>
      <main className="main">
        <div className="main-header">
          <div>
            <p className="main-eyebrow">Operator workspace · {new Date().toLocaleDateString()}</p>
            <h2>{activeConfig.label}</h2>
            <p className="muted">{activeConfig.description}</p>
          </div>
          <nav className="tab-rail" aria-label="Console sections">
            {TAB_CONFIG.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={clsx('tab-chip', { active: tab.id === activeConfig.id })}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon size={18} />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>
        <div className={clsx('page-grid', { 'page-grid--single': activeConfig.id === 'billing' || activeConfig.id === 'broadcasts' })}>
          {activeConfig.panels.map((PanelComponent, index) => (
            <PanelComponent key={`${activeConfig.id}-${index}`} />
          ))}
        </div>
      </main>
    </div>
  );
}
