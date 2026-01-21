import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type * as admin from 'firebase-admin';
import PDFDocument from 'pdfkit';

type InvoicePdfInput = {
  tenantId: string;
  coachingName?: string;
  tenantName?: string;
  timeZone?: string;
  invoiceId: string;
  invoiceNumber?: string;
  issuedAt?: string;
  dueAt?: string;
  updatedAt?: string;
  status?: string;
  planId?: string;
  planVariantId?: string;
  couponCode?: string;
  amountInr: number;
  payerEmail?: string;
  method?: string;
  cardLast4?: string;
  cardNetwork?: string;
  upiVpaMasked?: string;
  authorizedAt?: string;
  capturedAt?: string;
  failedAt?: string;
  billingPeriodStart?: string;
  billingPeriodEnd?: string;
  provider?: string;
  providerPaymentId?: string;
  providerSubscriptionId?: string;
  subscriptionId?: string;
};

function formatInr(amountInr: number): string {
  const value = Number.isFinite(amountInr) ? Math.round(amountInr) : 0;
  try {
    return new Intl.NumberFormat('en-IN', {
      style: 'currency',
      currency: 'INR',
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `₹${value}`;
  }
}

function formatDateLine(value?: string, timeZone?: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  try {
    return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric', timeZone });
  } catch {
    try {
      return d.toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });
    } catch {
      return value;
    }
  }
}

function formatDateTimeLine(value?: string, timeZone?: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  try {
    return d.toLocaleString('en-IN', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    });
  } catch {
    try {
      return d.toLocaleString('en-IN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch {
      return value;
    }
  }
}

type PdfDoc = InstanceType<typeof PDFDocument>;

function writeLabelValue(doc: PdfDoc, label: string, value: string | null | undefined): void {
  if (!value) return;
  doc.font('Helvetica-Bold').text(`${label}: `, { continued: true });
  doc.font('Helvetica').text(value);
}

function resolveInvoiceAssetPath(fileName: string): string[] {
  // Best-effort resolution across local dev, repo-root runs, and deployed builds.
  return [
    path.resolve(process.cwd(), 'assets', fileName),
    path.resolve(process.cwd(), 'backend-runtime', 'assets', fileName),
    path.resolve(__dirname, '../../assets', fileName),
    path.resolve(__dirname, '../../../assets', fileName),
  ];
}

async function loadImageBuffer(fileName: string): Promise<Buffer | null> {
  const candidates = resolveInvoiceAssetPath(fileName);
  for (const candidate of candidates) {
    try {
      const buf = await fs.readFile(candidate);
      if (buf?.length) return buf;
    } catch {
      // ignore
    }
  }
  return null;
}

function drawKeyValueRow(doc: PdfDoc, options: { x: number; y: number; width: number; label: string; value: string }): number {
  const { x, y, width, label, value } = options;
  const labelWidth = Math.min(140, Math.round(width * 0.42));
  const valueWidth = width - labelWidth;

  doc
    .font('Helvetica-Bold')
    .fillColor('#333333')
    .text(label, x, y, { width: labelWidth, continued: false });
  doc
    .font('Helvetica')
    .fillColor('#000000')
    .text(value || '—', x + labelWidth, y, { width: valueWidth, align: 'right' });

  const used = Math.max(
    doc.heightOfString(label, { width: labelWidth }),
    doc.heightOfString(value || '—', { width: valueWidth }),
  );
  return Math.ceil(used) + 6;
}

function drawDivider(doc: PdfDoc, y: number): void {
  const pageWidth = doc.page.width;
  const left = (doc as any).page.margins.left as number;
  const right = pageWidth - ((doc as any).page.margins.right as number);
  doc.save();
  doc.moveTo(left, y).lineTo(right, y).lineWidth(1).strokeColor('#E5E7EB').stroke();
  doc.restore();
}

function safeUpper(value?: string): string {
  return (value || '').trim().toUpperCase();
}

export async function generateInvoicePdfBuffer(input: InvoicePdfInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: 48 });

  const chunks: Buffer[] = [];
  doc.on('data', (c: unknown) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));

  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', (err: unknown) => reject(err));
  });

  const timeZone = (input.timeZone || '').trim() || 'Asia/Kolkata';

  const companyName = 'Vipika Learning Pvt. Ltd.';
  const companyTagline = 'Student-first learning tools';
  const companyAddress = '3rd Floor, MG Road, Bengaluru, Karnataka 560001, India';
  const companyEmail = 'billing@vipika.app';
  const companyPhone = '+91 90000 00000';
  const companyGstin = 'GSTIN: 29ABCDE1234F1Z5';

  const issued = formatDateTimeLine(input.issuedAt, timeZone) || formatDateLine(input.issuedAt, timeZone) || '—';
  const due = formatDateTimeLine(input.dueAt, timeZone) || formatDateLine(input.dueAt, timeZone) || '—';
  const rawStatus = (input.status || 'open').trim().toLowerCase();
  const status = rawStatus === 'void' ? 'FAILED' : safeUpper(rawStatus);
  const amount = formatInr(input.amountInr);
  const billingStart = formatDateLine(input.billingPeriodStart, timeZone) || input.billingPeriodStart || '';
  const billingEnd = formatDateLine(input.billingPeriodEnd, timeZone) || input.billingPeriodEnd || '';
  // Use an ASCII separator to avoid font glyph issues in PDF rendering.
  const billingPeriod = billingStart && billingEnd ? `${billingStart} - ${billingEnd}` : billingEnd || billingStart || '—';

  // Filenames match `backend-runtime/assets/`.
  // Icons disabled for now (per request).
  // const appIcon = await loadImageBuffer('app_icon.png');
  // const companyIcon = await loadImageBuffer('company_icon.png');
  const appIcon: Buffer | null = null;
  const companyIcon: Buffer | null = null;

  // Header
  const pageWidth = doc.page.width;
  const marginLeft = (doc as any).page.margins.left as number;
  const marginRight = (doc as any).page.margins.right as number;
  const contentWidth = pageWidth - marginLeft - marginRight;

  const headerTop = doc.y;
  const logoBoxSize = 36;
  const logoGap = 10;
  const logoCount = (appIcon ? 1 : 0) + (companyIcon ? 1 : 0);
  const logosWidth = logoCount > 0 ? logoCount * logoBoxSize + (logoCount - 1) * logoGap : 0;
  const headerTextX = marginLeft + (logosWidth ? logosWidth + 14 : 0);

  const rightLabelWidth = 180;
  const leftTextWidth = Math.max(180, contentWidth - (headerTextX - marginLeft) - rightLabelWidth - 12);

  // Draw icons (if present)
  let iconX = marginLeft;
  if (appIcon) {
    doc.image(appIcon, iconX, headerTop, { fit: [logoBoxSize, logoBoxSize] });
    iconX += logoBoxSize + logoGap;
  }
  if (companyIcon) {
    doc.image(companyIcon, iconX, headerTop, { fit: [logoBoxSize, logoBoxSize] });
  }

  // Right-side label
  doc
    .font('Helvetica-Bold')
    .fontSize(22)
    .fillColor('#111827')
    .text('INVOICE', marginLeft + contentWidth - rightLabelWidth, headerTop, {
      width: rightLabelWidth,
      align: 'right',
    });

  // Left-side company details (manually positioned for consistent spacing)
  let headerY = headerTop;
  doc.font('Helvetica-Bold').fontSize(16).fillColor('#111827');
  doc.text(companyName, headerTextX, headerY, { width: leftTextWidth, align: 'left' });
  headerY += doc.heightOfString(companyName, { width: leftTextWidth }) + 3;

  doc.font('Helvetica').fontSize(10).fillColor('#4B5563');
  doc.text(companyTagline, headerTextX, headerY, { width: leftTextWidth, align: 'left' });
  headerY += doc.heightOfString(companyTagline, { width: leftTextWidth }) + 4;

  doc.font('Helvetica').fontSize(9.5).fillColor('#4B5563');
  doc.text(companyAddress, headerTextX, headerY, { width: leftTextWidth, align: 'left' });
  headerY += doc.heightOfString(companyAddress, { width: leftTextWidth }) + 4;

  doc.text(`${companyEmail} · ${companyPhone}`, headerTextX, headerY, { width: leftTextWidth, align: 'left' });
  headerY += doc.heightOfString(`${companyEmail} · ${companyPhone}`, { width: leftTextWidth }) + 4;

  doc.text(companyGstin, headerTextX, headerY, { width: leftTextWidth, align: 'left' });
  headerY += doc.heightOfString(companyGstin, { width: leftTextWidth }) + 2;

  const headerHeight = Math.max(logoBoxSize, headerY - headerTop, 28);
  doc.y = headerTop + headerHeight + 10;

  drawDivider(doc, doc.y);
  doc.moveDown(0.9);

  // Two-column: Bill To + Invoice Meta
  const colGap = 24;
  const colWidth = (contentWidth - colGap) / 2;
  const colLeftX = marginLeft;
  const colRightX = marginLeft + colWidth + colGap;
  const sectionTop = doc.y;

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('BILL TO', colLeftX, sectionTop, { width: colWidth });
  doc.moveDown(0.35);
  doc.font('Helvetica').fontSize(10).fillColor('#000000');
  const coachingDisplay = input.coachingName || input.tenantName || '—';
  doc.text(`Coaching: ${coachingDisplay}`, colLeftX, doc.y, { width: colWidth });
  doc.text(`Tenant ID: ${input.tenantId}`, colLeftX, doc.y, { width: colWidth });
  if (input.payerEmail) {
    doc.text(`Contact: ${input.payerEmail}`, colLeftX, doc.y, { width: colWidth });
  }
  doc.text(`Subscription: ${input.subscriptionId || input.providerSubscriptionId || '—'}`, colLeftX, doc.y, { width: colWidth });

  let metaY = sectionTop;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('INVOICE DETAILS', colRightX, metaY, { width: colWidth, align: 'right' });
  metaY += 18;
  doc.fontSize(10);
  metaY += drawKeyValueRow(doc, { x: colRightX, y: metaY, width: colWidth, label: 'Invoice #', value: input.invoiceNumber || input.invoiceId });
  metaY += drawKeyValueRow(doc, { x: colRightX, y: metaY, width: colWidth, label: 'Issued', value: issued });
  metaY += drawKeyValueRow(doc, { x: colRightX, y: metaY, width: colWidth, label: 'Due', value: due });
  metaY += drawKeyValueRow(doc, { x: colRightX, y: metaY, width: colWidth, label: 'Status', value: status });
  metaY += drawKeyValueRow(doc, { x: colRightX, y: metaY, width: colWidth, label: 'Billing period', value: billingPeriod });

  doc.y = Math.max(doc.y, metaY) + 6;
  drawDivider(doc, doc.y);
  doc.moveDown(0.8);

  // Line items
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('LINE ITEMS', colLeftX, doc.y);
  doc.moveDown(0.45);

  const tableX = marginLeft;
  const tableWidth = contentWidth;
  const descWidth = Math.round(tableWidth * 0.62);
  const qtyWidth = Math.round(tableWidth * 0.12);
  const amtWidth = tableWidth - descWidth - qtyWidth;

  const rowY = doc.y;
  doc
    .font('Helvetica-Bold')
    .fontSize(10)
    .fillColor('#374151')
    .text('Description', tableX, rowY, { width: descWidth });
  doc.text('Qty', tableX + descWidth, rowY, { width: qtyWidth, align: 'right' });
  doc.text('Amount', tableX + descWidth + qtyWidth, rowY, { width: amtWidth, align: 'right' });
  doc.moveDown(0.35);
  drawDivider(doc, doc.y);
  doc.moveDown(0.5);

  const planName = input.planVariantId
    ? `${input.planVariantId}`
    : input.planId
      ? input.planId
      : 'Subscription';
  const itemDescriptionParts = [
    `Plan: ${planName}`,
    input.planId ? `(${safeUpper(input.planId)})` : null,
  ].filter(Boolean);
  const itemDescription = itemDescriptionParts.join(' ');

  const itemRowY = doc.y;
  doc.font('Helvetica').fontSize(10).fillColor('#111827').text(itemDescription, tableX, itemRowY, { width: descWidth });
  doc.text('1', tableX + descWidth, itemRowY, { width: qtyWidth, align: 'right' });
  doc.text(amount, tableX + descWidth + qtyWidth, itemRowY, { width: amtWidth, align: 'right' });
  doc.moveDown(0.9);

  if (input.couponCode) {
    doc.font('Helvetica').fontSize(9.5).fillColor('#6B7280').text(`Coupon applied: ${safeUpper(input.couponCode)}`, tableX);
    doc.moveDown(0.6);
  }

  // Totals box (right aligned)
  const totalsTop = doc.y;
  const totalsWidth = Math.min(320, Math.round(contentWidth * 0.44));
  const totalsX = marginLeft + contentWidth - totalsWidth;
  let totalsY = totalsTop;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('TOTALS', totalsX, totalsY, { width: totalsWidth, align: 'right' });
  totalsY += 18;
  doc.fontSize(10);
  totalsY += drawKeyValueRow(doc, { x: totalsX, y: totalsY, width: totalsWidth, label: 'Subtotal', value: amount });
  totalsY += drawKeyValueRow(doc, { x: totalsX, y: totalsY, width: totalsWidth, label: 'Tax', value: '—' });
  totalsY += drawKeyValueRow(doc, { x: totalsX, y: totalsY, width: totalsWidth, label: 'Total', value: amount });
  doc.y = Math.max(doc.y, totalsY) + 6;

  drawDivider(doc, doc.y);
  doc.moveDown(0.8);

  // Payment details
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111827').text('PAYMENT DETAILS', marginLeft, doc.y);
  doc.moveDown(0.45);

  const method = input.method ? safeUpper(input.method) : '—';
  const cardSuffix = input.cardLast4 ? `**** ${input.cardLast4}` : '';
  const cardNetwork = input.cardNetwork ? safeUpper(input.cardNetwork) : '';
  const upi = input.upiVpaMasked ? input.upiVpaMasked : '';
  const methodDetail = [cardNetwork, cardSuffix, upi].filter(Boolean).join(' · ');

  doc.font('Helvetica').fontSize(10).fillColor('#111827');
  doc.text(`Provider: ${input.provider || '—'}`);
  doc.text(`Payment ID: ${input.providerPaymentId || '—'}`);
  doc.text(`Method: ${method}${methodDetail ? ` · ${methodDetail}` : ''}`);
  const paymentAt =
    formatDateTimeLine(input.capturedAt, timeZone) ||
    formatDateTimeLine(input.failedAt, timeZone) ||
    formatDateTimeLine(input.authorizedAt, timeZone) ||
    null;
  const updatedAt = formatDateTimeLine(input.updatedAt, timeZone);
  doc.text(`Issued at: ${formatDateTimeLine(input.issuedAt, timeZone) || '—'}`);
  doc.text(`Payment time: ${paymentAt || '—'}`);
  doc.text(`Last updated: ${updatedAt || '—'}`);
  doc.text(`Timezone: ${timeZone}`);

  doc.moveDown(0.9);
  doc.font('Helvetica').fontSize(9.5).fillColor('#6B7280');
  doc.text('This invoice is system-generated and does not require a signature.', { align: 'left' });
  doc.text('For billing support, contact us at billing@vipika.app.', { align: 'left' });
  doc.fillColor('#000000');

  doc.end();
  return await done;
}

export function buildInvoiceStoragePath(tenantId: string, invoiceId: string): string {
  const safeTenant = (tenantId || '').trim();
  const safeInvoice = (invoiceId || '').trim();
  const token = crypto.createHash('sha1').update(`${safeTenant}:${safeInvoice}`).digest('hex').slice(0, 10);
  return `billing-invoices/${safeTenant}/${safeInvoice}/invoice_${token}.pdf`;
}

export async function ensureInvoicePdfInStorage(options: {
  bucket: ReturnType<admin.storage.Storage['bucket']>;
  tenantId: string;
  invoice: InvoicePdfInput;
  force?: boolean;
}): Promise<{ downloadUrl: string; path: string }>{
  const { bucket, tenantId, invoice, force } = options;
  const path = buildInvoiceStoragePath(tenantId, invoice.invoiceId);
  const file = bucket.file(path);

  const [exists] = await file.exists().catch(() => [false as boolean]);
  const downloadToken =
    typeof (crypto as any).randomUUID === 'function'
      ? (crypto as any).randomUUID()
      : crypto.randomBytes(16).toString('hex');

  if (force || !exists) {
    const pdf = await generateInvoicePdfBuffer(invoice);
    await file.save(pdf, {
      resumable: false,
      contentType: 'application/pdf',
      metadata: {
        metadata: {
          firebaseStorageDownloadTokens: downloadToken,
        },
      },
    });
  } else {
    // Best-effort: refresh download token so we can always return a working link.
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: downloadToken } } as any).catch(() => undefined);
  }

  const url = `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${downloadToken}`;
  return { downloadUrl: url, path };
}
