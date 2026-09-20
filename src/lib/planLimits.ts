import { neonQuery } from "./db.js";
import { getInstitutePurchases } from "./subscriptions.js";

// -1 means unlimited
export interface PlanLimits {
  maxStudents: number;
  maxTestsPerMonth: number;
}

export interface UsageInfo {
  students: { current: number; max: number; remaining: number; unlimited: boolean };
  testsThisMonth: { current: number; max: number; remaining: number; unlimited: boolean };
  planName: string | null;
}

// Plan limits configuration — maps plan IDs to their limits
const PLAN_LIMITS: Record<string, PlanLimits> = {
  starter: { maxStudents: 30, maxTestsPerMonth: 5 },
  pro_institute: { maxStudents: 100, maxTestsPerMonth: -1 },
  enterprise: { maxStudents: -1, maxTestsPerMonth: -1 },
};

// Fallback for institutes with no active plan (free tier)
const FREE_TIER_LIMITS: PlanLimits = {
  maxStudents: 5,
  maxTestsPerMonth: 2,
};

/**
 * Resolve the active plan ID for an institute from their purchases.
 * Returns the plan name (lowercased, underscored) or null if no active plan.
 */
async function getActivePlanId(instituteId: string): Promise<string | null> {
  const purchases = await getInstitutePurchases(instituteId);
  const activePurchase = purchases.find(
    (p) => p.status === "completed" || p.status === "active"
  );
  if (!activePurchase) return null;

  // Normalize plan name to match PLAN_LIMITS keys (e.g. "Pro Institute" → "pro_institute")
  return activePurchase.plan_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "");
}

/**
 * Get the plan limits for an institute based on their active subscription.
 */
export async function getInstitutePlanLimits(
  instituteId: string
): Promise<{ limits: PlanLimits; planId: string | null; planName: string | null }> {
  const purchases = await getInstitutePurchases(instituteId);
  const activePurchase = purchases.find(
    (p) => p.status === "completed" || p.status === "active"
  );

  if (!activePurchase) {
    return { limits: FREE_TIER_LIMITS, planId: null, planName: null };
  }

  const planId = activePurchase.plan_name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "");

  const limits = PLAN_LIMITS[planId] || FREE_TIER_LIMITS;

  return { limits, planId, planName: activePurchase.plan_name };
}

/**
 * Count current students for an institute.
 */
export async function countInstituteStudents(instituteId: string): Promise<number> {
  const rows = await neonQuery(
    `SELECT COUNT(*)::int as count FROM public.profiles WHERE institute_id = $1;`,
    [instituteId]
  );
  return rows?.[0]?.count || 0;
}

/**
 * Count exams created by this institute in the current calendar month.
 */
export async function countInstituteTestsThisMonth(instituteId: string): Promise<number> {
  const rows = await neonQuery(
    `SELECT COUNT(*)::int as count FROM public.exams
     WHERE created_by = $1
       AND created_at >= date_trunc('month', CURRENT_DATE)
       AND created_at < date_trunc('month', CURRENT_DATE) + interval '1 month';`,
    [instituteId]
  );
  return rows?.[0]?.count || 0;
}

/**
 * Get full usage info for an institute (limits + current counts).
 */
export async function getInstituteUsage(instituteId: string): Promise<UsageInfo> {
  const { limits, planName } = await getInstitutePlanLimits(instituteId);
  const [studentCount, testCount] = await Promise.all([
    countInstituteStudents(instituteId),
    countInstituteTestsThisMonth(instituteId),
  ]);

  const studentUnlimited = limits.maxStudents === -1;
  const testUnlimited = limits.maxTestsPerMonth === -1;

  return {
    students: {
      current: studentCount,
      max: limits.maxStudents,
      remaining: studentUnlimited ? -1 : Math.max(0, limits.maxStudents - studentCount),
      unlimited: studentUnlimited,
    },
    testsThisMonth: {
      current: testCount,
      max: limits.maxTestsPerMonth,
      remaining: testUnlimited ? -1 : Math.max(0, limits.maxTestsPerMonth - testCount),
      unlimited: testUnlimited,
    },
    planName,
  };
}

/**
 * Check if an institute can add another student.
 */
export async function checkStudentLimit(
  instituteId: string
): Promise<{ allowed: boolean; current: number; max: number; planName: string | null }> {
  const { limits, planName } = await getInstitutePlanLimits(instituteId);

  if (limits.maxStudents === -1) {
    return { allowed: true, current: 0, max: -1, planName };
  }

  const current = await countInstituteStudents(instituteId);
  return {
    allowed: current < limits.maxStudents,
    current,
    max: limits.maxStudents,
    planName,
  };
}

/**
 * Check if an institute can create another test this month.
 */
export async function checkTestLimit(
  instituteId: string
): Promise<{ allowed: boolean; current: number; max: number; planName: string | null }> {
  const { limits, planName } = await getInstitutePlanLimits(instituteId);

  if (limits.maxTestsPerMonth === -1) {
    return { allowed: true, current: 0, max: -1, planName };
  }

  const current = await countInstituteTestsThisMonth(instituteId);
  return {
    allowed: current < limits.maxTestsPerMonth,
    current,
    max: limits.maxTestsPerMonth,
    planName,
  };
}
