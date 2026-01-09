import { useCallback, useEffect, useMemo, useState } from 'react';
import { SectionCard } from '../../components/SectionCard';
import {
  ApiError,
  fetchBillingCatalogAdmin,
  type BillingCatalogCoupon,
  type BillingCatalogPlanVariant,
  upsertBillingCoupon,
  upsertBillingPlanVariant,
} from '../../lib/apiClient';

type PlanId = 'free' | 'pro' | 'enterprise';
type ApplyChangesMode = 'immediate' | 'next_billing';
type DecreasePolicy = 'soft' | 'hard';

const CANONICAL_PLAN_VARIANT_IDS: PlanId[] = ['free', 'pro', 'enterprise'];

function isCanonicalPlanVariantId(value: string): value is PlanId {
  return CANONICAL_PLAN_VARIANT_IDS.includes(value as PlanId);
}

function sortBy<T>(items: T[], getKey: (value: T) => number | string) {
  return [...items].sort((a, b) => {
    const ka = getKey(a);
    const kb = getKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function BillingCatalogPanel() {
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<BillingCatalogPlanVariant[]>([]);
  const [coupons, setCoupons] = useState<BillingCatalogCoupon[]>([]);

  const [editingPlanId, setEditingPlanId] = useState<string | null>(null);

  const emptyPlanDraft = useMemo(
    () => ({
      id: '',
      planId: 'pro' as PlanId,
      displayName: '',
      priceInr: 0,
      razorpayPlanId: '',
      playProductId: '',
      applyChangesMode: 'next_billing' as ApplyChangesMode,
      decreasePolicy: 'soft' as DecreasePolicy,
      active: true,
      sortOrder: 100,
      limits: {
        staffSeats: 0,
        students: 0,
        storageMb: 0,
        reminders: {
          total: 0,
          whatsapp: 0,
          sms: 0,
          voice: 0,
          email: 0,
        },
      },
    }),
    []
  );

  const [planDraft, setPlanDraft] = useState(emptyPlanDraft);

  const [couponDraft, setCouponDraft] = useState({
    id: '',
    code: '',
    mapsToPlanVariantId: '',
    active: true,
    startsAt: '',
    endsAt: '',
  });

  const [editingCouponId, setEditingCouponId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const data = await fetchBillingCatalogAdmin();
      setPlans(data.plans || []);
      setCoupons(data.coupons || []);
    } catch (err: any) {
      setError(err?.message || 'Failed to load billing catalog');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const isFreeDraft = planDraft.id.trim() === 'free' || planDraft.planId === 'free';
  const canonicalDraftId = planDraft.id.trim();
  const isCanonicalDraft = isCanonicalPlanVariantId(canonicalDraftId);

  const planOptions = useMemo(() => {
    const usable = plans.filter((entry) => entry.id);
    return sortBy(usable, (entry) => entry.sortOrder || 999);
  }, [plans]);

  const handleSelectPlan = (entry: BillingCatalogPlanVariant) => {
    setError(null);
    setEditingPlanId(entry.id);
    const isFree = entry.id === 'free' || entry.planId === 'free';
    setPlanDraft({
      id: entry.id,
      planId: entry.planId as PlanId,
      displayName: entry.displayName || '',
      priceInr: isFree ? 0 : entry.priceInr || 0,
      razorpayPlanId: isFree ? '' : entry.razorpayPlanId || '',
      playProductId: isFree ? '' : entry.playProductId || '',
      applyChangesMode: (isFree ? 'immediate' : entry.applyChangesMode || 'next_billing') as ApplyChangesMode,
      decreasePolicy: (entry.decreasePolicy || 'soft') as DecreasePolicy,
      active: isFree ? true : Boolean(entry.active),
      sortOrder: typeof entry.sortOrder === 'number' ? entry.sortOrder : 100,
      limits: {
        staffSeats: entry.limits?.staffSeats ?? 0,
        students: entry.limits?.students ?? 0,
        storageMb: entry.limits?.storageMb ?? 0,
        reminders: {
          total: entry.limits?.reminders?.total ?? 0,
          whatsapp: entry.limits?.reminders?.whatsapp ?? 0,
          sms: entry.limits?.reminders?.sms ?? 0,
          voice: entry.limits?.reminders?.voice ?? 0,
          email: entry.limits?.reminders?.email ?? 0,
        },
      },
    });
  };

  const handleNewPlan = () => {
    setError(null);
    setEditingPlanId(null);
    setPlanDraft(emptyPlanDraft);
  };

  const handleSavePlan = async () => {
    setError(null);
    setSaving(true);
    try {
      const isFree = planDraft.id.trim() === 'free' || planDraft.planId === 'free';
      const result = await upsertBillingPlanVariant({
        id: planDraft.id.trim(),
        planId: isFree ? ('free' as PlanId) : planDraft.planId,
        displayName: planDraft.displayName.trim(),
        priceInr: isFree ? 0 : Number(planDraft.priceInr),
        razorpayPlanId: isFree ? undefined : planDraft.razorpayPlanId.trim() || undefined,
        playProductId: isFree ? undefined : planDraft.playProductId.trim() || undefined,
        applyChangesMode: (isFree ? 'immediate' : planDraft.applyChangesMode) as ApplyChangesMode,
        decreasePolicy: planDraft.decreasePolicy as DecreasePolicy,
        limits: {
          staffSeats: planDraft.limits?.staffSeats ? Number(planDraft.limits.staffSeats) : undefined,
          students: planDraft.limits?.students ? Number(planDraft.limits.students) : undefined,
          storageMb: planDraft.limits?.storageMb ? Number(planDraft.limits.storageMb) : undefined,
          reminders: {
            total: planDraft.limits?.reminders?.total ? Number(planDraft.limits.reminders.total) : undefined,
            whatsapp: planDraft.limits?.reminders?.whatsapp ? Number(planDraft.limits.reminders.whatsapp) : undefined,
            sms: planDraft.limits?.reminders?.sms ? Number(planDraft.limits.reminders.sms) : undefined,
            voice: planDraft.limits?.reminders?.voice ? Number(planDraft.limits.reminders.voice) : undefined,
            email: planDraft.limits?.reminders?.email ? Number(planDraft.limits.reminders.email) : undefined,
          },
        },
        active: isFree ? true : planDraft.active,
        sortOrder: Number(planDraft.sortOrder),
      });
      await reload();
      setEditingPlanId(planDraft.id.trim());

      // If backend returned the saved plan, re-select it to reflect the persisted value.
      const saved = (result as any)?.plan as BillingCatalogPlanVariant | null | undefined;
      if (saved && typeof saved === 'object' && typeof saved.id === 'string') {
        handleSelectPlan(saved);
      }
    } catch (err: any) {
      if (err instanceof ApiError) {
        const details =
          err.data && typeof err.data === 'object'
            ? JSON.stringify(err.data)
            : typeof err.data === 'string'
              ? err.data
              : '';
        setError(details ? `Failed to save plan (${err.status}): ${details}` : `Failed to save plan (${err.status}).`);
      } else {
        setError(err?.message || 'Failed to save plan');
      }
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCoupon = async () => {
    setError(null);
    setSaving(true);
    try {
      await upsertBillingCoupon({
        id: couponDraft.id.trim(),
        code: couponDraft.code.trim(),
        mapsToPlanVariantId: couponDraft.mapsToPlanVariantId.trim(),
        active: couponDraft.active,
        startsAt: couponDraft.startsAt.trim() || undefined,
        endsAt: couponDraft.endsAt.trim() || undefined,
      });
      await reload();
      setEditingCouponId(couponDraft.id.trim());
    } catch (err: any) {
      setError(err?.message || 'Failed to save coupon');
    } finally {
      setSaving(false);
    }
  };

  const handleSelectCoupon = (entry: BillingCatalogCoupon) => {
    setError(null);
    setEditingCouponId(entry.id);
    setCouponDraft({
      id: entry.id,
      code: entry.code || '',
      mapsToPlanVariantId: entry.mapsToPlanVariantId || '',
      active: Boolean(entry.active),
      startsAt: entry.startsAt || '',
      endsAt: entry.endsAt || '',
    });
  };

  const handleNewCoupon = () => {
    setError(null);
    setEditingCouponId(null);
    setCouponDraft({
      id: '',
      code: '',
      mapsToPlanVariantId: '',
      active: true,
      startsAt: '',
      endsAt: '',
    });
  };

  return (
    <>
      <SectionCard
        title="Billing Catalog"
        description="Define plan variants (₹299/₹599/₹1599) and coupon code mappings that the mobile app can offer."
        headerExtra={
          <button className="primary-button" type="button" onClick={reload} disabled={loading || saving}>
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        }
      >
        {error && <p style={{ color: '#f87171', marginTop: '0.75rem' }}>{error}</p>}

        <div style={{ marginTop: '1rem' }}>
          <h3>Plan variants</h3>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            Click a plan below to edit it. Limits are optional; set them to control plan quotas.
          </p>
          <div className="form-grid" style={{ marginTop: '0.75rem' }}>
            <label>
              ID
              <input
                value={planDraft.id}
                onChange={(e) => setPlanDraft((s) => ({ ...s, id: e.target.value }))}
                placeholder="e.g. pro_basic"
                disabled={Boolean(editingPlanId)}
              />
              {!editingPlanId && (
                <span className="muted small-text">
                  Canonical tier IDs are {CANONICAL_PLAN_VARIANT_IDS.join(', ')}.
                </span>
              )}
              {editingPlanId && isCanonicalDraft && (
                <span className="muted small-text">Canonical tier plan ({canonicalDraftId}).</span>
              )}
            </label>
            <label>
              Base plan
              <select
                value={planDraft.planId}
                onChange={(e) => setPlanDraft((s) => ({ ...s, planId: e.target.value as PlanId }))}
                disabled={isFreeDraft}
              >
                {isFreeDraft && <option value="free">free</option>}
                <option value="pro">pro</option>
                <option value="enterprise">enterprise</option>
              </select>
            </label>
            <label>
              Display name
              <input
                value={planDraft.displayName}
                onChange={(e) => setPlanDraft((s) => ({ ...s, displayName: e.target.value }))}
                placeholder="e.g. Pro Basic"
              />
            </label>
            <label>
              Price (INR)
              <input
                value={String(isFreeDraft ? 0 : planDraft.priceInr)}
                onChange={(e) => setPlanDraft((s) => ({ ...s, priceInr: Number(e.target.value || 0) }))}
                inputMode="numeric"
                placeholder="e.g. 299"
                disabled={isFreeDraft}
              />
            </label>
            <label>
              Razorpay plan_id
              <input
                value={planDraft.razorpayPlanId}
                onChange={(e) => setPlanDraft((s) => ({ ...s, razorpayPlanId: e.target.value }))}
                placeholder="plan_**************"
                disabled={isFreeDraft}
              />
            </label>
            <label>
              Google Play product ID
              <input
                value={planDraft.playProductId}
                onChange={(e) => setPlanDraft((s) => ({ ...s, playProductId: e.target.value }))}
                placeholder="e.g. pro_monthly_299"
                disabled={isFreeDraft}
              />
              <span className="muted small-text">Optional: used by Android Google Play Billing.</span>
            </label>
            <label>
              Sort order
              <input
                value={String(planDraft.sortOrder)}
                onChange={(e) => setPlanDraft((s) => ({ ...s, sortOrder: Number(e.target.value || 0) }))}
                inputMode="numeric"
              />
            </label>

            <label>
              Apply limit changes
              <select
                value={isFreeDraft ? 'immediate' : planDraft.applyChangesMode}
                onChange={(e) => setPlanDraft((s) => ({ ...s, applyChangesMode: e.target.value as ApplyChangesMode }))}
                disabled={isFreeDraft}
              >
                {isFreeDraft && <option value="immediate">immediate</option>}
                <option value="immediate">immediate</option>
                <option value="next_billing">next billing</option>
              </select>
            </label>

            <label>
              If limits decrease
              <select
                value={planDraft.decreasePolicy}
                onChange={(e) => setPlanDraft((s) => ({ ...s, decreasePolicy: e.target.value as DecreasePolicy }))}
              >
                <option value="soft">soft</option>
                <option value="hard">hard</option>
              </select>
            </label>

            <label>
              Staff seats
              <input
                value={String(planDraft.limits?.staffSeats ?? 0)}
                onChange={(e) =>
                  setPlanDraft((s) => ({
                    ...s,
                    limits: { ...(s.limits || {}), staffSeats: Number(e.target.value || 0) },
                  }))
                }
                inputMode="numeric"
                placeholder="e.g. 25"
              />
            </label>
            <label>
              Students
              <input
                value={String(planDraft.limits?.students ?? 0)}
                onChange={(e) =>
                  setPlanDraft((s) => ({
                    ...s,
                    limits: { ...(s.limits || {}), students: Number(e.target.value || 0) },
                  }))
                }
                inputMode="numeric"
                placeholder="e.g. 1200"
              />
            </label>
            <label>
              Storage (MB)
              <input
                value={String(planDraft.limits?.storageMb ?? 0)}
                onChange={(e) =>
                  setPlanDraft((s) => ({
                    ...s,
                    limits: { ...(s.limits || {}), storageMb: Number(e.target.value || 0) },
                  }))
                }
                inputMode="numeric"
                placeholder="e.g. 20480"
              />
            </label>

            <label>
              Monthly reminders (total)
              <input
                value={String(planDraft.limits?.reminders?.total ?? 0)}
                onChange={(e) =>
                  setPlanDraft((s) => ({
                    ...s,
                    limits: {
                      ...(s.limits || {}),
                      reminders: { ...(s.limits?.reminders || {}), total: Number(e.target.value || 0) },
                    },
                  }))
                }
                inputMode="numeric"
                placeholder="e.g. 5000"
              />
            </label>
            <label>
              Monthly reminders (WhatsApp)
              <input
                value={String(planDraft.limits?.reminders?.whatsapp ?? 0)}
                onChange={(e) =>
                  setPlanDraft((s) => ({
                    ...s,
                    limits: {
                      ...(s.limits || {}),
                      reminders: { ...(s.limits?.reminders || {}), whatsapp: Number(e.target.value || 0) },
                    },
                  }))
                }
                inputMode="numeric"
                placeholder="e.g. 2500"
              />
            </label>
            <label>
              Monthly reminders (SMS)
              <input
                value={String(planDraft.limits?.reminders?.sms ?? 0)}
                onChange={(e) =>
                  setPlanDraft((s) => ({
                    ...s,
                    limits: {
                      ...(s.limits || {}),
                      reminders: { ...(s.limits?.reminders || {}), sms: Number(e.target.value || 0) },
                    },
                  }))
                }
                inputMode="numeric"
                placeholder="e.g. 1500"
              />
            </label>
            <label>
              Monthly reminders (Voice)
              <input
                value={String(planDraft.limits?.reminders?.voice ?? 0)}
                onChange={(e) =>
                  setPlanDraft((s) => ({
                    ...s,
                    limits: {
                      ...(s.limits || {}),
                      reminders: { ...(s.limits?.reminders || {}), voice: Number(e.target.value || 0) },
                    },
                  }))
                }
                inputMode="numeric"
                placeholder="e.g. 250"
              />
            </label>
            <label>
              Monthly reminders (Email)
              <input
                value={String(planDraft.limits?.reminders?.email ?? 0)}
                onChange={(e) =>
                  setPlanDraft((s) => ({
                    ...s,
                    limits: {
                      ...(s.limits || {}),
                      reminders: { ...(s.limits?.reminders || {}), email: Number(e.target.value || 0) },
                    },
                  }))
                }
                inputMode="numeric"
                placeholder="e.g. 5000"
              />
            </label>

            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input
                type="checkbox"
                checked={isFreeDraft ? true : planDraft.active}
                onChange={(e) => setPlanDraft((s) => ({ ...s, active: e.target.checked }))}
                disabled={isFreeDraft}
              />
              Active
            </label>
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '1rem' }}>
            <button className="primary-button" type="button" onClick={handleSavePlan} disabled={saving}>
              {saving ? 'Saving…' : 'Save plan'}
            </button>
            <button className="secondary-button" type="button" onClick={handleNewPlan} disabled={saving}>
              New plan
            </button>
            {editingPlanId && <span className="muted">Editing: {editingPlanId}</span>}
          </div>

          <div style={{ marginTop: '1rem' }}>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Base plan</th>
                    <th>Price</th>
                    <th>Razorpay plan_id</th>
                    <th>Play product</th>
                    <th>Apply</th>
                    <th>Decrease</th>
                    <th>Sort</th>
                    <th>Limits</th>
                    <th>Status</th>
                    <th>Updated</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {planOptions.length === 0 ? (
                    <tr>
                      <td colSpan={12} className="muted">
                        No plan variants configured yet.
                      </td>
                    </tr>
                  ) : (
                    planOptions.map((entry) => (
                      <tr
                        key={entry.id}
                        onClick={() => handleSelectPlan(entry)}
                        style={{ cursor: 'pointer', opacity: entry.active ? 1 : 0.7 }}
                        title="Click to edit"
                      >
                        <td>
                          {entry.id}
                          {isCanonicalPlanVariantId(entry.id) ? <span className="muted"> · canonical</span> : null}
                        </td>
                        <td>{entry.planId}</td>
                        <td>₹{entry.priceInr}</td>
                        <td>{entry.razorpayPlanId || '—'}</td>
                        <td>{entry.playProductId || '—'}</td>
                        <td>{entry.applyChangesMode || (entry.planId === 'free' ? 'immediate' : 'next_billing')}</td>
                        <td>{entry.decreasePolicy || 'soft'}</td>
                        <td>{typeof entry.sortOrder === 'number' ? entry.sortOrder : '—'}</td>
                        <td>
                          {[
                            entry.limits?.staffSeats ? `Staff ${entry.limits.staffSeats}` : null,
                            entry.limits?.students ? `Students ${entry.limits.students}` : null,
                            entry.limits?.reminders?.total ? `Rem ${entry.limits.reminders.total}` : null,
                            entry.limits?.storageMb ? `Storage ${entry.limits.storageMb}MB` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ') || '—'}
                        </td>
                        <td>{entry.active ? 'active' : 'inactive'}</td>
                        <td className="muted">{entry.updatedAt || '—'}</td>
                        <td className="muted">{entry.createdAt || '—'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div style={{ marginTop: '2rem' }}>
          <h3>Coupons</h3>
          <p className="muted" style={{ marginTop: '0.35rem' }}>
            Coupons map a code to a specific plan variant. Use this for festival offers by mapping to a discounted variant.
          </p>
          <div className="form-grid" style={{ marginTop: '0.75rem' }}>
            <label>
              Coupon ID
              <input
                value={couponDraft.id}
                onChange={(e) => setCouponDraft((s) => ({ ...s, id: e.target.value }))}
                placeholder="e.g. diwali_2025"
              />
            </label>
            <label>
              Code
              <input
                value={couponDraft.code}
                onChange={(e) => setCouponDraft((s) => ({ ...s, code: e.target.value }))}
                placeholder="e.g. DIWALI"
              />
            </label>
            <label>
              Maps to plan variant ID
              <input
                value={couponDraft.mapsToPlanVariantId}
                onChange={(e) => setCouponDraft((s) => ({ ...s, mapsToPlanVariantId: e.target.value }))}
                placeholder="e.g. pro_diwali"
              />
            </label>
            <label>
              Starts at (ISO)
              <input
                value={couponDraft.startsAt}
                onChange={(e) => setCouponDraft((s) => ({ ...s, startsAt: e.target.value }))}
                placeholder="2025-12-20T00:00:00.000Z"
              />
            </label>
            <label>
              Ends at (ISO)
              <input
                value={couponDraft.endsAt}
                onChange={(e) => setCouponDraft((s) => ({ ...s, endsAt: e.target.value }))}
                placeholder="2025-12-31T23:59:59.000Z"
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.5rem' }}>
              <input
                type="checkbox"
                checked={couponDraft.active}
                onChange={(e) => setCouponDraft((s) => ({ ...s, active: e.target.checked }))}
              />
              Active
            </label>
          </div>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', marginTop: '1rem' }}>
            <button className="primary-button" type="button" onClick={handleSaveCoupon} disabled={saving}>
              {saving ? 'Saving…' : 'Save coupon'}
            </button>
            <button className="secondary-button" type="button" onClick={handleNewCoupon} disabled={saving}>
              New coupon
            </button>
            {editingCouponId && <span className="muted">Editing: {editingCouponId}</span>}
          </div>

          <div style={{ marginTop: '1rem' }}>
            <div className="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Code</th>
                    <th>Maps to</th>
                    <th>Status</th>
                    <th>Window</th>
                  </tr>
                </thead>
                <tbody>
                  {coupons.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">
                        No coupons configured yet.
                      </td>
                    </tr>
                  ) : (
                    sortBy(coupons, (entry) => entry.code).map((entry) => (
                      <tr key={entry.id} onClick={() => handleSelectCoupon(entry)} style={{ cursor: 'pointer' }} title="Click to edit">
                        <td>{entry.id}</td>
                        <td>{entry.code}</td>
                        <td>{entry.mapsToPlanVariantId}</td>
                        <td>{entry.active ? 'active' : 'inactive'}</td>
                        <td>
                          {(entry.startsAt || '—') + ' → ' + (entry.endsAt || '—')}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </SectionCard>
    </>
  );
}
