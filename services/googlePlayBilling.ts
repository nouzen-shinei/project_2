import * as RNIap from 'react-native-iap';
import type {
  AndroidSubscriptionOfferInput,
  EventSubscription,
  Product,
  ProductOrSubscription,
  ProductSubscriptionAndroid,
  Purchase,
  PurchaseError,
} from 'react-native-iap';

export type GooglePlayPurchaseResult = {
  productId: string;
  purchaseToken: string;
  orderId?: string;
};

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function extractPurchaseToken(purchase: Purchase): string {
  // Android: `purchaseToken` is the critical server verification token.
  return (
    asTrimmedString((purchase as any)?.purchaseToken) ||
    asTrimmedString((purchase as any)?.purchaseTokenAndroid) ||
    asTrimmedString((purchase as any)?.dataAndroid?.purchaseToken)
  );
}

function extractProductId(purchase: Purchase): string {
  return (
    asTrimmedString((purchase as any)?.productId) ||
    asTrimmedString((purchase as any)?.productIdAndroid) ||
    asTrimmedString((purchase as any)?.dataAndroid?.productId)
  );
}

function extractOrderId(purchase: Purchase): string {
  // Often maps to the orderId / transactionId.
  return (
    asTrimmedString((purchase as any)?.transactionId) ||
    asTrimmedString((purchase as any)?.transactionIdAndroid) ||
    asTrimmedString((purchase as any)?.dataAndroid?.orderId)
  );
}

function isAndroidSubscriptionProduct(product: ProductOrSubscription): product is ProductSubscriptionAndroid {
  return product.platform === 'android' && product.type === 'subs';
}

function pickAndroidOfferToken(product: ProductSubscriptionAndroid): string {
  const offerDetails = Array.isArray(product.subscriptionOfferDetailsAndroid)
    ? product.subscriptionOfferDetailsAndroid
    : [];
  for (const offer of offerDetails) {
    const token = asTrimmedString(offer?.offerToken);
    if (token) return token;
  }
  return '';
}

export async function purchaseGooglePlaySubscription(productId: string): Promise<GooglePlayPurchaseResult> {
  const sku = productId.trim();
  if (!sku) {
    throw new Error('product_id_required');
  }

  await RNIap.initConnection();

  try {
    const products = await RNIap.fetchProducts({ skus: [sku], type: 'subs' });
    const subProduct = (products || []).find(isAndroidSubscriptionProduct) || null;
    if (!subProduct) {
      throw new Error('product_not_found');
    }

    const offerToken = pickAndroidOfferToken(subProduct);
    const subscriptionOffers: AndroidSubscriptionOfferInput[] | undefined = offerToken
      ? [{ sku, offerToken }]
      : undefined;

    const purchasePromise = new Promise<Purchase>((resolve, reject) => {
      let updatedSub: EventSubscription | null = null;
      let errorSub: EventSubscription | null = null;

      const cleanup = () => {
        try {
          updatedSub?.remove();
        } catch {
          // ignore
        }
        try {
          errorSub?.remove();
        } catch {
          // ignore
        }
      };

      updatedSub = RNIap.purchaseUpdatedListener((purchase: Purchase) => {
        try {
          const pid = extractProductId(purchase);
          if (pid && pid !== sku) {
            return;
          }
          cleanup();
          resolve(purchase);
        } catch (e) {
          cleanup();
          reject(e);
        }
      });

      errorSub = RNIap.purchaseErrorListener((error: PurchaseError) => {
        cleanup();
        reject(error);
      });
    });

    // Request subscription purchase (event-based).
    await RNIap.requestPurchase({
      type: 'subs',
      request: {
        google: {
          skus: [sku],
          ...(subscriptionOffers ? { subscriptionOffers } : {}),
        },
      },
    });

    const purchase = await purchasePromise;

    const purchaseToken = extractPurchaseToken(purchase);
    if (!purchaseToken) {
      throw new Error('purchase_token_missing');
    }

    return {
      productId: sku,
      purchaseToken,
      orderId: extractOrderId(purchase) || undefined,
    };
  } finally {
    // Keep connection open? For now we close to avoid lingering listeners.
    try {
      await RNIap.endConnection();
    } catch {
      // ignore
    }
  }
}

export async function finishGooglePlayTransactionSafe(purchase: { purchaseToken: string; productId: string }) {
  // In many flows, server-side acknowledgement is enough. This is a best-effort cleanup.
  try {
    await RNIap.initConnection();
    await RNIap.acknowledgePurchaseAndroid(purchase.purchaseToken);
  } catch {
    // ignore
  } finally {
    try {
      await RNIap.endConnection();
    } catch {
      // ignore
    }
  }
}
