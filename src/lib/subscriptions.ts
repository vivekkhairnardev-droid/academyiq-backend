import { neonQuery } from "./db.js";

export interface SubscriptionPlan {
  id: string;
  name: string;
  price: number;
  currency: string;
  billing_cycle: string;
  description: string;
  features: string[];
  popular: boolean;
  active: boolean;
  order_index: number;
  created_at?: string;
  updated_at?: string;
}

export interface PaymentSettings {
  id?: string;
  upi_id: string;
  upi_name: string;
  notes: string;
  qr_code_url?: string;
  updated_at?: string;
}

export interface InstitutePurchase {
  id: string;
  institute_id: string;
  order_id: string;
  invoice_number: string;
  plan_name: string;
  amount: number;
  currency: string;
  billing_cycle: string;
  payment_method: string;
  status: string;
  utr_number?: string;
  notes?: string;
  created_at: string;
  verified_at?: string;
  verified_by?: string;
  institute_name?: string;
  institute_email?: string;
  institute_phone?: string;
}

// -------------------------------------------------------------
// Database Table Initialization
// -------------------------------------------------------------
let dbTablesReady = false;

export async function tryInitDbTables(): Promise<boolean> {
  if (dbTablesReady) return true;

  try {
    await neonQuery(`
      CREATE TABLE IF NOT EXISTS public.subscription_plans (
        id VARCHAR(50) PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        price NUMERIC(10, 2) NOT NULL DEFAULT 0,
        currency VARCHAR(10) DEFAULT 'INR',
        billing_cycle VARCHAR(50) DEFAULT 'Monthly',
        description TEXT,
        features TEXT DEFAULT '[]',
        popular BOOLEAN DEFAULT false,
        active BOOLEAN DEFAULT true,
        order_index INT DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await neonQuery(`
      CREATE TABLE IF NOT EXISTS public.payment_settings (
        id VARCHAR(50) PRIMARY KEY DEFAULT 'default',
        upi_id VARCHAR(100) NOT NULL DEFAULT 'batchiq@upi',
        upi_name VARCHAR(100) NOT NULL DEFAULT 'BatchIQ Platform',
        notes TEXT DEFAULT 'Scan the QR code with any UPI app and enter the 12-digit UTR number below.',
        qr_code_url TEXT DEFAULT '',
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await neonQuery(`
      CREATE TABLE IF NOT EXISTS public.institute_purchases (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        institute_id UUID NOT NULL,
        order_id VARCHAR(100) NOT NULL,
        invoice_number VARCHAR(100) NOT NULL,
        plan_name VARCHAR(100) NOT NULL,
        amount NUMERIC(10, 2) NOT NULL,
        currency VARCHAR(10) DEFAULT 'INR',
        billing_cycle VARCHAR(50) DEFAULT 'Monthly',
        payment_method VARCHAR(100) DEFAULT 'Direct UPI (QR/Link)',
        status VARCHAR(50) DEFAULT 'pending_verification',
        utr_number VARCHAR(100),
        notes TEXT,
        verified_at TIMESTAMPTZ,
        verified_by UUID,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    await neonQuery(`ALTER TABLE public.institute_purchases ADD COLUMN IF NOT EXISTS utr_number VARCHAR(100);`).catch(() => {});
    await neonQuery(`ALTER TABLE public.institute_purchases ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;`).catch(() => {});
    await neonQuery(`ALTER TABLE public.institute_purchases ADD COLUMN IF NOT EXISTS verified_by UUID;`).catch(() => {});
    await neonQuery(`ALTER TABLE public.institute_purchases ADD COLUMN IF NOT EXISTS notes TEXT;`).catch(() => {});

    dbTablesReady = true;
    console.log("[Subscriptions] DB tables ready.");
    return true;
  } catch (err: any) {
    console.error("[Subscriptions DB Init Error]:", err.message);
    return false;
  }
}

// -------------------------------------------------------------
// Subscription Plans
// -------------------------------------------------------------
export async function getSubscriptionPlans(): Promise<SubscriptionPlan[]> {
  const rows = await neonQuery(
    `SELECT * FROM public.subscription_plans ORDER BY order_index ASC, price ASC;`
  );
  return (rows || []).map((r: any) => ({
    ...r,
    price: Number(r.price),
    features: typeof r.features === "string" ? JSON.parse(r.features || "[]") : (r.features || []),
  }));
}

export async function saveSubscriptionPlan(planData: Partial<SubscriptionPlan>): Promise<SubscriptionPlan> {
  const currentPlans = await getSubscriptionPlans();
  const id = planData.id || planData.name?.toLowerCase().replace(/[^a-z0-9]+/g, "_") || `plan_${Date.now()}`;
  const features = Array.isArray(planData.features) ? planData.features : [];

  const result = await neonQuery(
    `INSERT INTO public.subscription_plans 
      (id, name, price, currency, billing_cycle, description, features, popular, active, order_index, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
     ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      price = EXCLUDED.price,
      currency = EXCLUDED.currency,
      billing_cycle = EXCLUDED.billing_cycle,
      description = EXCLUDED.description,
      features = EXCLUDED.features,
      popular = EXCLUDED.popular,
      active = EXCLUDED.active,
      order_index = EXCLUDED.order_index,
      updated_at = NOW()
     RETURNING *;`,
    [
      id,
      planData.name || "Custom Plan",
      Number(planData.price || 0),
      planData.currency || "INR",
      planData.billing_cycle || "Monthly",
      planData.description || "",
      JSON.stringify(features),
      Boolean(planData.popular),
      planData.active !== undefined ? Boolean(planData.active) : true,
      planData.order_index !== undefined ? Number(planData.order_index) : currentPlans.length + 1,
    ]
  );

  const row = result[0];
  return {
    ...row,
    price: Number(row.price),
    features: typeof row.features === "string" ? JSON.parse(row.features || "[]") : (row.features || []),
  };
}

export async function deleteSubscriptionPlan(id: string): Promise<boolean> {
  await neonQuery(`DELETE FROM public.subscription_plans WHERE id = $1;`, [id]);
  return true;
}

// -------------------------------------------------------------
// Payment Settings
// -------------------------------------------------------------
export async function getPaymentSettings(): Promise<PaymentSettings> {
  const rows = await neonQuery(`SELECT * FROM public.payment_settings WHERE id = 'default';`);

  if (rows && rows.length > 0) {
    return rows[0];
  }

  // Seed default row if none exists
  await neonQuery(
    `INSERT INTO public.payment_settings (id, upi_id, upi_name, notes, qr_code_url)
     VALUES ('default', 'batchiq@upi', 'BatchIQ Platform', 'Scan the QR code with any UPI app (GPay, PhonePe, Paytm, BHIM) and enter the 12-digit UTR / Transaction Reference Number below.', '')
     ON CONFLICT (id) DO NOTHING;`
  );

  const seeded = await neonQuery(`SELECT * FROM public.payment_settings WHERE id = 'default';`);
  return seeded[0];
}

export async function savePaymentSettings(data: Partial<PaymentSettings>): Promise<PaymentSettings> {
  const current = await getPaymentSettings();

  const result = await neonQuery(
    `INSERT INTO public.payment_settings (id, upi_id, upi_name, notes, qr_code_url, updated_at)
     VALUES ('default', $1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET
      upi_id = EXCLUDED.upi_id,
      upi_name = EXCLUDED.upi_name,
      notes = EXCLUDED.notes,
      qr_code_url = EXCLUDED.qr_code_url,
      updated_at = NOW()
     RETURNING *;`,
    [
      (data.upi_id || current.upi_id).trim(),
      (data.upi_name || current.upi_name).trim(),
      data.notes !== undefined ? data.notes : current.notes,
      data.qr_code_url || "",
    ]
  );

  return result[0];
}

// -------------------------------------------------------------
// Purchases
// -------------------------------------------------------------
export async function getAllPurchases(): Promise<InstitutePurchase[]> {
  const rows = await neonQuery(`
    SELECT 
      p.*,
      pr.full_name as institute_name,
      pr.email as institute_email,
      pr.phone as institute_phone
    FROM public.institute_purchases p
    LEFT JOIN public.profiles pr ON pr.id = p.institute_id
    ORDER BY p.created_at DESC;
  `);
  return (rows || []).map((r: any) => ({ ...r, amount: Number(r.amount) }));
}

export async function getInstitutePurchases(instituteId: string): Promise<InstitutePurchase[]> {
  const rows = await neonQuery(
    `SELECT * FROM public.institute_purchases WHERE institute_id = $1 ORDER BY created_at DESC;`,
    [instituteId]
  );
  return (rows || []).map((r: any) => ({ ...r, amount: Number(r.amount) }));
}

export async function createPurchase(data: {
  institute_id: string;
  plan_name: string;
  amount: number;
  billing_cycle: string;
  utr_number: string;
}): Promise<InstitutePurchase> {
  const order_id = `ORD-${Math.floor(100000 + Math.random() * 900000)}`;
  const invoice_number = `INV-2026-${Math.floor(1000 + Math.random() * 9000)}`;
  const cleanUtr = String(data.utr_number).trim();

  const result = await neonQuery(
    `INSERT INTO public.institute_purchases 
      (institute_id, order_id, invoice_number, plan_name, amount, currency, billing_cycle, payment_method, status, utr_number, created_at)
     VALUES ($1, $2, $3, $4, $5, 'INR', $6, 'Direct UPI (QR/Link)', 'pending_verification', $7, NOW())
     RETURNING *;`,
    [
      data.institute_id,
      order_id,
      invoice_number,
      data.plan_name,
      Number(data.amount),
      data.billing_cycle || "Monthly",
      cleanUtr,
    ]
  );

  return { ...result[0], amount: Number(result[0].amount) };
}

export async function updatePurchaseStatus(
  id: string,
  status: string,
  verifiedBy?: string,
  notes?: string
): Promise<boolean> {
  const result = await neonQuery(
    `UPDATE public.institute_purchases
     SET status = $1, notes = COALESCE($2, notes), verified_at = NOW(), verified_by = $3
     WHERE id::text = $4 OR order_id = $4
     RETURNING *;`,
    [status, notes || null, verifiedBy || null, id]
  );

  if (!result || result.length === 0) {
    throw new Error(`Purchase with ID "${id}" not found.`);
  }

  return true;
}

// Run table init on startup
tryInitDbTables().catch(() => {});
