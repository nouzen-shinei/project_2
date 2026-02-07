import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertTriangle, CheckCircle2, Clock3, LogIn, MailPlus, Shield, Sparkles, UserPlus, X } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import Toast from 'react-native-toast-message';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@/hooks/useAuthUnified';
import { useTenant } from '@/hooks/useTenantContext';
import { tenantService } from '@/services/tenantService';
import { logger } from '@/lib/logger';
import type { Tenant, TenantInvite, TenantMembershipRole } from '@/types';
import { inviteOverlayStore } from '@/lib/inviteOverlayStore';

type InviteViewState = 'loading' | 'ready' | 'expired' | 'accepted' | 'error';
type InviteDisplayState = InviteViewState | 'wrong_account';

type StepConfig = {
  id: string;
  title: string;
  description: string;
  Icon: typeof LogIn;
};

interface InviteOverlayProps {
  token: string;
}

const roleLabel = (role: TenantMembershipRole): string => {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'staff':
      return 'Staff';
    default:
      return 'Member';
  }
};

const formatDateLabel = (iso?: string | null): string => {
  if (!iso) {
    return 'Not specified';
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return 'Not specified';
  }
  return date.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const computeState = (invite: TenantInvite | null): InviteViewState => {
  if (!invite) {
    return 'error';
  }
  if (invite.status === 'accepted') {
    return 'accepted';
  }
  if (invite.status === 'rejected') {
    return 'error';
  }
  if (invite.status === 'revoked') {
    return 'error';
  }
  const expiresAt = invite.expiresAt ? Date.parse(invite.expiresAt) : NaN;
  if (invite.status === 'expired' || (!Number.isNaN(expiresAt) && expiresAt < Date.now())) {
    return 'expired';
  }
  return 'ready';
};

const statusCopyFor = (state: InviteViewState, invite?: TenantInvite | null): string => {
  if (invite?.status === 'rejected') {
    return 'This invite was declined. Ask an admin for a fresh link if you still need access.';
  }
  switch (state) {
    case 'ready':
      return 'Review the access details below, then accept to step inside the workspace.';
    case 'accepted':
      return 'This invite is already activated. Jump into your dashboard when you are ready.';
    case 'expired':
      return `This invite expired on ${formatDateLabel(invite?.expiresAt)}. Ask your admin for a fresh link.`;
    case 'error':
      return 'This invite is no longer available. It may have been revoked or already used.';
    default:
      return 'Checking your invite details…';
  }
};

const bannerPalette = (state: InviteDisplayState, theme: ReturnType<typeof useTheme>['theme']) => {
  if (state === 'ready') {
    return {
      backgroundColor: `${theme.primary}12`,
      borderColor: `${theme.primary}35`,
      textColor: theme.primary,
      Icon: UserPlus,
    };
  }
  if (state === 'wrong_account') {
    return {
      backgroundColor: `${theme.warning}18`,
      borderColor: `${theme.warning}40`,
      textColor: theme.warning,
      Icon: AlertTriangle,
    };
  }
  if (state === 'accepted') {
    return {
      backgroundColor: `${theme.success ?? theme.primary}15`,
      borderColor: `${theme.success ?? theme.primary}30`,
      textColor: theme.success ?? theme.primary,
      Icon: CheckCircle2,
    };
  }
  if (state === 'expired') {
    return {
      backgroundColor: `${theme.warning}18`,
      borderColor: `${theme.warning}35`,
      textColor: theme.warning,
      Icon: Clock3,
    };
  }
  if (state === 'error') {
    return {
      backgroundColor: `${theme.error}15`,
      borderColor: `${theme.error}35`,
      textColor: theme.error,
      Icon: AlertTriangle,
    };
  }
  return {
    backgroundColor: `${theme.border}30`,
    borderColor: theme.border,
    textColor: theme.textSecondary,
    Icon: Clock3,
  };
};

const InviteOverlay = ({ token }: InviteOverlayProps) => {
  const { theme } = useTheme();
  const { user } = useAuth();
  const { refreshTenants } = useTenant();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isNarrow = width < 490;

  const [invite, setInvite] = useState<TenantInvite | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [viewState, setViewState] = useState<InviteViewState>('loading');
  const [statusCopy, setStatusCopy] = useState('Checking your invite details…');
  const [accepting, setAccepting] = useState(false);

  const inviteEmailMismatch = useMemo(() => {
    if (!invite?.email || !user?.email) {
      return false;
    }
    return invite.email.trim().toLowerCase() !== user.email.trim().toLowerCase();
  }, [invite?.email, user?.email]);

  const displayState: InviteDisplayState = useMemo(() => {
    if (viewState === 'ready' && inviteEmailMismatch) {
      return 'wrong_account';
    }
    return viewState;
  }, [inviteEmailMismatch, viewState]);

  const derivedStatusCopy = useMemo(() => {
    if (displayState === 'wrong_account') {
      if (!invite?.email) {
        return 'This invite is tied to a different email. Sign in with the invited account to continue.';
      }
      if (!user?.email) {
        return `Sign in as ${invite.email} to continue.`;
      }
      return `This invite was sent to ${invite.email}, but you are signed in as ${user.email}. Switch accounts to accept it.`;
    }
    return statusCopy;
  }, [displayState, invite?.email, statusCopy, user?.email]);

  const loadInvite = useCallback(async () => {
    if (!token) {
      setInvite(null);
      setTenant(null);
      setViewState('error');
      setStatusCopy('This invite link looks incomplete. Double-check the URL you received.');
      return;
    }

    setViewState('loading');
    setStatusCopy('Checking your invite details…');
    try {
      const inviteDoc = await tenantService.findInviteByToken(token);
      if (!inviteDoc) {
        setInvite(null);
        setTenant(null);
        setViewState('error');
        setStatusCopy('We could not find this invite. It might have been revoked or already used.');
        return;
      }
      setInvite(inviteDoc);
      const tenantMeta = await tenantService.getTenantById(inviteDoc.tenantId);
      setTenant(tenantMeta);
      const nextState = computeState(inviteDoc);
      setViewState(nextState);
      setStatusCopy(statusCopyFor(nextState, inviteDoc));
    } catch (error) {
      logger.error('InviteOverlay: failed to load invite', error);
      setInvite(null);
      setTenant(null);
      setViewState('error');
      setStatusCopy('Something went wrong while loading this invite. Try refreshing the link.');
    }
  }, [token]);

  useEffect(() => {
    loadInvite().catch((error) => logger.error('InviteOverlay: load effect failed', error));
  }, [loadInvite]);

  const dismiss = useCallback(() => {
    inviteOverlayStore.setToken(null);
  }, []);

  const handleBackHome = () => {
    dismiss();
    router.replace('/(tabs)');
  };

  const handleAcceptInvite = async () => {
    if (!invite || displayState !== 'ready') {
      return;
    }
    if (inviteEmailMismatch) {
      const targetEmail = invite.email || 'the invited email';
      Toast.show({
        type: 'info',
        text1: 'Use invited email',
        text2: `Sign in as ${targetEmail} to continue.`,
      });
      return;
    }
    if (!user?.uid || !user.email) {
      Toast.show({ type: 'info', text1: 'Sign in required', text2: 'Sign in again to accept this invite.' });
      return;
    }
    setAccepting(true);
    try {
      await tenantService.acceptInvite(invite.token);
      await refreshTenants();
      setViewState('accepted');
      setStatusCopy(statusCopyFor('accepted', invite));
      Toast.show({
        type: 'success',
        text1: 'Invite accepted',
        text2: tenant?.name ? `Welcome to ${tenant.name}.` : 'You can now access the workspace.',
      });
      setTimeout(() => {
        dismiss();
        router.replace('/(tabs)');
      }, 900);
    } catch (error) {
      logger.error('InviteOverlay: accept failed', error);
      const message = error instanceof Error ? error.message : 'Unable to accept this invite right now.';
      Toast.show({ type: 'error', text1: 'Invite failed', text2: message });
      setStatusCopy(message);
      setViewState('error');
    } finally {
      setAccepting(false);
    }
  };

  const steps: StepConfig[] = useMemo(() => {
    return [
      {
        id: 'account',
        title: inviteEmailMismatch ? 'Switch accounts' : user?.email ? 'Account ready' : 'Sign in first',
        description: inviteEmailMismatch
          ? `This invite is tied to ${invite?.email}. You are signed in as ${user?.email ?? 'a different account'}.`
          : user?.email
              ? `You are signed in as ${user.email}. We will link this invite to the same email.`
              : 'Use the email that received this invite to sign in before accepting.',
        Icon: LogIn,
      },
      {
        id: 'role',
        title: `Access level · ${roleLabel(invite?.role || 'member')}`,
        description: 'Admins can view billing & settings, while staff manage daily operations.',
        Icon: Shield,
      },
      {
        id: 'workspace',
        title: tenant?.name ? `Join ${tenant.name}` : 'Join this workspace',
        description: 'Once accepted, this workspace appears in your dashboard right away.',
        Icon: CheckCircle2,
      },
    ];
  }, [invite?.email, invite?.role, inviteEmailMismatch, tenant?.name, user?.email]);

  const infoChips = useMemo(() => {
    if (!invite) {
      return [];
    }
    const chips = [
      {
        id: 'role',
        label: 'Joining as',
        value: roleLabel(invite.role),
        Icon: Shield,
      },
      {
        id: 'email',
        label: 'Sent to',
        value: invite.email,
        Icon: MailPlus,
      },
    ] as const;

    if (invite.status === 'pending') {
      return [
        ...chips,
        {
          id: 'expires',
          label: 'Expires',
          value: formatDateLabel(invite.expiresAt),
          Icon: Clock3,
        },
      ];
    }

    return [...chips];
  }, [invite]);

  const heroTitle = useMemo(() => {
    if (displayState === 'accepted') {
      return 'You are all set';
    }
    if (displayState === 'wrong_account') {
      return invite?.email ? `Sign in as ${invite.email}` : 'Use the invited account';
    }
    if (displayState === 'expired') {
      return 'Invite expired';
    }
    if (displayState === 'error') {
      return 'Invite unavailable';
    }
    return tenant?.name ? `You are invited to ${tenant.name}` : 'You are invited to a coaching center';
  }, [displayState, invite?.email, tenant?.name]);

  const heroSubtitle = useMemo(() => {
    if (displayState === 'accepted') {
      return 'This workspace is already linked to your account.';
    }
    if (displayState === 'expired' || displayState === 'error' || displayState === 'wrong_account') {
      return derivedStatusCopy;
    }
    return 'Preview the workspace details and confirm access.';
  }, [derivedStatusCopy, displayState]);

  const palette = bannerPalette(displayState, theme);
  const disablePrimary = displayState !== 'ready' || accepting;

  return (
    <View style={styles.overlay} pointerEvents="auto">
      <View
        style={[
          styles.backdrop,
          {
            paddingTop: Math.max(insets.top + 24, 60),
            paddingBottom: Math.max(insets.bottom + 24, 60),
          },
        ]}
      >
        <View style={[styles.cardShell, { borderColor: theme.border, backgroundColor: theme.surface }]}> 
          <ScrollView
            style={styles.cardScroll}
            contentContainerStyle={styles.cardContent}
            showsVerticalScrollIndicator={false}
          >
            <View style={styles.heroHeader}>
              <View style={styles.heroHeaderRow}>
                <View style={[styles.heroBadge, { borderColor: `${theme.primary}35`, backgroundColor: `${theme.primary}15` }]}> 
                  <Sparkles size={16} color={theme.primary} />
                  <Text style={[styles.heroBadgeText, { color: theme.primary }]}>Team invite</Text>
                </View>
                <TouchableOpacity
                  style={[styles.closeButton, { borderColor: theme.border, backgroundColor: theme.surface }]}
                  onPress={dismiss}
                  accessibilityRole="button"
                  accessibilityLabel="Close invite"
                >
                  <X size={16} color={theme.textSecondary} />
                </TouchableOpacity>
              </View>
              <Text style={[styles.heroTitle, { color: theme.text }]}>{heroTitle}</Text>
              <Text style={[styles.heroSubtitle, { color: theme.textSecondary }]}>{heroSubtitle}</Text>
            </View>

            <View
              style={[
                styles.statusBanner,
                { backgroundColor: palette.backgroundColor, borderColor: palette.borderColor },
              ]}
            >
              <palette.Icon size={18} color={palette.textColor} />
              <Text style={[styles.statusText, { color: palette.textColor }]}>{derivedStatusCopy}</Text>
            </View>

            {displayState === 'wrong_account' && (
              <View
                style={[
                  styles.mismatchCard,
                  { borderColor: `${theme.error}35`, backgroundColor: `${theme.error}10` },
                ]}
              >
                <AlertTriangle size={18} color={theme.error} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.mismatchTitle, { color: theme.error }]}>Use the invited account</Text>
                  <Text style={[styles.mismatchBody, { color: theme.textSecondary }]}>
                    {invite?.email
                      ? `This invite is tied to ${invite.email} but you are signed in as ${user?.email ?? 'another account'}.`
                      : 'Sign in with the email that originally received this invite.'}
                  </Text>
                </View>
              </View>
            )}

            {!!infoChips.length && (
              <View style={styles.infoGrid}>
                {infoChips.map(({ id, label, value, Icon }) => (
                  <View
                    key={id}
                    style={[
                      styles.infoChip,
                      isNarrow && styles.infoChipFull,
                      { borderColor: theme.border },
                    ]}
                  > 
                    <View style={[styles.infoIcon, { backgroundColor: `${theme.primary}12` }]}> 
                      <Icon size={14} color={theme.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.infoLabel, { color: theme.textSecondary }]}>{label}</Text>
                      <Text style={[styles.infoValue, { color: theme.text }]} numberOfLines={1}>
                        {value}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {invite?.invitationMessage && (
              <View style={[styles.messageCard, { borderColor: `${theme.primary}30`, backgroundColor: `${theme.primary}08` }]}> 
                <Text style={[styles.messageLabel, { color: theme.primary }]}>Message from your admin</Text>
                <Text style={[styles.messageBody, { color: theme.text }]}>{invite.invitationMessage}</Text>
              </View>
            )}

            {viewState === 'loading' && (
              <View style={styles.loadingRow}>
                <ActivityIndicator color={theme.primary} />
                <Text style={[styles.loadingText, { color: theme.textSecondary }]}>Fetching live status…</Text>
              </View>
            )}

            {viewState === 'ready' && (
              <View style={[styles.stepCard, { borderColor: theme.border }]}> 
                <Text style={[styles.stepHeading, { color: theme.text }]}>Before you hop in</Text>
                {steps.map(({ id, title, description, Icon }, index) => (
                  <View
                    key={id}
                    style={[
                      styles.stepRow,
                      {
                        borderBottomColor: index + 1 === steps.length ? 'transparent' : theme.border,
                        borderBottomWidth: index + 1 === steps.length ? 0 : StyleSheet.hairlineWidth,
                      },
                    ]}
                  >
                    <View style={[styles.stepIcon, { backgroundColor: `${theme.primary}12` }]}> 
                      <Icon size={18} color={theme.primary} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.stepTitle, { color: theme.text }]}>{title}</Text>
                      <Text style={[styles.stepDescription, { color: theme.textSecondary }]}>{description}</Text>
                    </View>
                  </View>
                ))}
              </View>
            )}

            {(viewState === 'error' || viewState === 'expired') && (
              <TouchableOpacity
                style={[styles.retryPill, { borderColor: theme.border }]}
                onPress={() => loadInvite().catch((error) => logger.error('InviteOverlay: manual reload failed', error))}
              >
                <Text style={[styles.retryText, { color: theme.text }]}>Try reloading this invite</Text>
              </TouchableOpacity>
            )}

            <View style={styles.buttonStack}>
              {displayState === 'ready' && (
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: theme.primary }]}
                  onPress={handleAcceptInvite}
                  disabled={disablePrimary}
                  activeOpacity={0.9}
                >
                  <Text style={styles.primaryButtonText}>
                    {accepting ? 'Linking workspace…' : `Join as ${roleLabel(invite?.role || 'member')}`}
                  </Text>
                </TouchableOpacity>
              )}

              {viewState === 'accepted' && (
                <TouchableOpacity
                  style={[styles.primaryButton, { backgroundColor: theme.primary }]}
                  onPress={handleBackHome}
                >
                  <Text style={styles.primaryButtonText}>Open dashboard</Text>
                </TouchableOpacity>
              )}

              <TouchableOpacity
                style={[styles.secondaryButton, { borderColor: theme.border }]}
                onPress={handleBackHome}
              >
                <Text style={[styles.secondaryButtonText, { color: theme.text }]}>Back to home</Text>
              </TouchableOpacity>
            </View>

            <Text style={[styles.helpText, { color: theme.textSecondary }]}>Need help? Ask the person who invited you to resend the link or to approve a join request instead.</Text>
          </ScrollView>
        </View>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 20,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(15, 23, 42, 0.5)',
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardShell: {
    width: '100%',
    maxWidth: 560,
    maxHeight: '85%',
    borderWidth: 1,
    borderRadius: 28,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 28,
    elevation: 10,
  },
  cardScroll: {
    maxHeight: '100%',
  },
  cardContent: {
    paddingHorizontal: 28,
    paddingVertical: 24,
  },
  closeButton: {
    borderWidth: 1,
    borderRadius: 999,
    padding: 8,
  },
  heroHeader: {
    marginBottom: 20,
  },
  heroHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  heroBadge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  heroBadgeText: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.3,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: '700',
    marginTop: 16,
  },
  heroSubtitle: {
    fontSize: 16,
    marginTop: 8,
    lineHeight: 22,
  },
  statusBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 12,
    marginBottom: 20,
    gap: 12,
  },
  statusText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '600',
  },
  mismatchCard: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    borderWidth: 1,
    borderRadius: 18,
    padding: 16,
    gap: 12,
    marginBottom: 16,
  },
  mismatchTitle: {
    fontSize: 15,
    fontWeight: '700',
    marginBottom: 4,
  },
  mismatchBody: {
    fontSize: 14,
    lineHeight: 20,
  },
  infoGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    marginBottom: 16,
  },
  infoChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 18,
    padding: 14,
    flexBasis: '48%',
    gap: 12,
  },
  infoChipFull: {
    flexBasis: '100%',
  },
  infoIcon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  infoLabel: {
    fontSize: 12,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  infoValue: {
    fontSize: 16,
    fontWeight: '600',
  },
  messageCard: {
    borderWidth: 1,
    borderRadius: 20,
    padding: 18,
    marginBottom: 20,
  },
  messageLabel: {
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  messageBody: {
    fontSize: 15,
    lineHeight: 22,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginBottom: 20,
  },
  loadingText: {
    fontSize: 14,
  },
  stepCard: {
    borderWidth: 1,
    borderRadius: 28,
    paddingHorizontal: 18,
    paddingTop: 18,
    paddingBottom: 4,
    marginBottom: 24,
  },
  stepHeading: {
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 12,
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 14,
    paddingVertical: 14,
    borderBottomWidth: 0,
  },
  stepIcon: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  stepDescription: {
    fontSize: 14,
    marginTop: 4,
    lineHeight: 20,
  },
  retryPill: {
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 12,
    paddingHorizontal: 16,
    alignItems: 'center',
    marginBottom: 20,
  },
  retryText: {
    fontWeight: '600',
  },
  buttonStack: {
    gap: 12,
    marginBottom: 16,
  },
  primaryButton: {
    borderRadius: 18,
    paddingVertical: 16,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowOffset: { width: 0, height: 12 },
    shadowRadius: 24,
    elevation: 8,
  },
  primaryButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 18,
    paddingVertical: 14,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: '600',
  },
  helpText: {
    fontSize: 13,
    lineHeight: 20,
    opacity: 0.9,
  },
});

export default InviteOverlay;
