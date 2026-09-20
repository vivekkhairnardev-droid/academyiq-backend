import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, neonQuery } from "../lib/db.js";
import {
  getSubscriptionPlans,
  getPaymentSettings,
  getInstitutePurchases,
  createPurchase,
} from "../lib/subscriptions.js";
import bcrypt from "bcryptjs";

const router = Router();

const SALT_ROUNDS = 10;

// Middleware to verify requester is an institute
async function requireInstitute(req: any, res: any, next: any) {
  try {
    const { data: profile } = await db
      .from("profiles_with_roles")
      .select("role_name")
      .eq("id", req.user.id)
      .single();

    if (profile?.role_name !== "institute") {
      return res.status(403).json({ error: "Forbidden: Institute access required" });
    }
    next();
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Forbidden" });
  }
}

// GET /api/institute/students — list students for this institute
router.get("/students", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;

    const { data: students, error } = await db
      .from("profiles_with_roles")
      .select("*")
      .eq("role_name", "student")
      .eq("institute_id", user.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ students });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/institute/students — create a new student under this institute
router.post("/students", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;
    const { email, password, fullName, phone } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user already exists
    const existing = await neonQuery(
      `SELECT id FROM public.profiles WHERE email = $1 LIMIT 1;`,
      [normalizedEmail]
    );
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: "A user with this email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUserId = crypto.randomUUID();

    // Get student role_id
    let roleId: string | null = null;
    const roles = await neonQuery(`SELECT id FROM public.roles WHERE name = 'student' LIMIT 1;`);
    if (roles && roles.length > 0) roleId = roles[0].id;

    await neonQuery(
      `INSERT INTO public.profiles (id, email, full_name, encrypted_password, role_id, institute_id, phone, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW());`,
      [newUserId, normalizedEmail, fullName || "", hashedPassword, roleId, user.id, phone || null]
    );

    return res.status(201).json({
      student: { id: newUserId, email: normalizedEmail, user_metadata: { full_name: fullName || "" } },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PUT /api/institute/students/:id — update student
router.put("/students/:id", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const { id } = req.params;
    const user = req.user;
    const body = req.body;

    // Verify the student belongs to this institute
    const { data: studentCheck } = await db.from("profiles").select("institute_id").eq("id", id).single();
    if (studentCheck?.institute_id !== user.id) {
      return res.status(403).json({ error: "Student does not belong to this institute" });
    }

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.fullName !== undefined) updates.full_name = body.fullName;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.isActive !== undefined) updates.is_active = body.isActive;

    const { error } = await db.from("profiles").update(updates).eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ message: "Updated" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/institute/students/:id — delete student
router.delete("/students/:id", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const { id } = req.params;
    const user = req.user;

    // Verify the student belongs to this institute
    const { data: studentCheck } = await db.from("profiles").select("institute_id").eq("id", id).single();
    if (studentCheck?.institute_id !== user.id) {
      return res.status(403).json({ error: "Student does not belong to this institute" });
    }

    // Delete the profile (cascade should handle related data)
    await neonQuery(`DELETE FROM public.profiles WHERE id = $1;`, [id]);
    return res.json({ message: "Deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/institute/test-bank — list platform tests
router.get("/test-bank", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;

    const { data: exams, error } = await db
      .from("exams")
      .select("id, title, description, exam_type, question_mode, duration_minutes, total_marks, is_paid, price, created_at, created_by")
      .eq("status", "published")
      .neq("created_by", user.id)
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ exams });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/institute/assigned-tests — list exams assigned to this institute by admin
router.get("/assigned-tests", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    const user = req.user;

    const rows = await neonQuery(
      `SELECT e.id, e.title, e.description, e.exam_type, e.question_mode,
              e.duration_minutes, e.total_marks, e.is_paid, e.price, e.status,
              e.created_at, e.created_by, ea.assigned_by
       FROM public.exam_assignments ea
       JOIN public.exams e ON ea.exam_id = e.id
       WHERE ea.institute_id = $1 AND ea.assigned_by != $1 AND e.status = 'published';`,
      [user.id]
    );

    return res.json({ exams: rows || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/institute/profile
router.get("/profile", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;

    const { data: profile, error } = await db
      .from("profiles")
      .select("full_name, email, phone, avatar_url, created_at")
      .eq("id", user.id)
      .single();

    if (error) return res.status(550).json({ error: error.message });
    return res.json({ profile });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PATCH /api/institute/profile
router.patch("/profile", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;
    const { full_name, phone } = req.body;

    const updates: Record<string, string> = {};
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;

    const { data: profile, error } = await db
      .from("profiles")
      .update(updates)
      .eq("id", user.id)
      .select("full_name, email, phone, avatar_url, created_at")
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ profile });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/institute/questions — List questions created by this institute
router.get("/questions", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;
    const sql = `
      SELECT 
        q.id,
        q.exam_id,
        q.subject_id,
        q.question_text,
        q.question_type,
        q.marks,
        q.options,
        q.correct_answer,
        q.explanation,
        q.created_at,
        q.topic_id,
        s.name AS subject_name,
        st.title AS topic_title,
        e.title AS exam_title
      FROM public.questions q
      JOIN public.exams e ON q.exam_id = e.id
      LEFT JOIN public.subjects s ON q.subject_id = s.id
      LEFT JOIN public.subject_topics st ON q.topic_id = st.id
      WHERE e.created_by = $1
      ORDER BY q.created_at DESC;
    `;
    const questions = await neonQuery(sql, [user.id]);

    // Fetch subjects and topics
    const subjects = await neonQuery(
      `SELECT s.id, s.name, s.exam_id FROM public.subjects s ORDER BY s.name ASC;`
    );
    const topics = await neonQuery(
      `SELECT id, subject_id, title FROM public.subject_topics ORDER BY title ASC;`
    );

    return res.json({ questions, subjects, topics });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/institute/subscription-status — Quick check for subscription gate
router.get("/subscription-status", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;
    const purchases = await getInstitutePurchases(user.id);

    // Check for an active (admin-approved) purchase
    const activePurchase = purchases.find(
      (p) => p.status === "completed" || p.status === "active"
    );
    if (activePurchase) {
      return res.json({
        status: "active",
        plan_name: activePurchase.plan_name,
        amount: activePurchase.amount,
        billing_cycle: activePurchase.billing_cycle,
      });
    }

    // Check for a pending purchase awaiting admin verification
    const pendingPurchase = purchases.find(
      (p) => p.status === "pending_verification"
    );
    if (pendingPurchase) {
      return res.json({
        status: "pending",
        plan_name: pendingPurchase.plan_name,
        amount: pendingPurchase.amount,
        billing_cycle: pendingPurchase.billing_cycle,
        utr_number: pendingPurchase.utr_number,
        submitted_at: pendingPurchase.created_at,
      });
    }

    // No subscription at all
    return res.json({ status: "none" });
  } catch (error: any) {
    return res.json({ status: "none" });
  }
});

// GET /api/institute/purchases — List purchases for this institute
router.get("/purchases", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;
    const purchases = await getInstitutePurchases(user.id);
    return res.json({ purchases });
  } catch (error: any) {
    return res.json({ purchases: [] });
  }
});

// GET /api/institute/plans — List active subscription plans configured by super admin
router.get("/plans", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const plans = await getSubscriptionPlans();
    return res.json({ plans: (plans || []).filter((p) => p.active) });
  } catch (error: any) {
    return res.json({ plans: [] });
  }
});

// GET /api/institute/payment-info — Get active UPI payment configuration
router.get("/payment-info", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const settings = await getPaymentSettings();
    return res.json({ paymentInfo: settings });
  } catch (error: any) {
    return res.json({
      paymentInfo: {
        upi_id: "batchiq@upi",
        upi_name: "BatchIQ Platform",
        notes: "Scan the QR code and enter the 12-digit UTR number below.",
      },
    });
  }
});

// POST /api/institute/purchases/initiate — Submit a new purchase with UPI UTR for verification
router.post("/purchases/initiate", requireAuth, requireInstitute, async (req: any, res) => {
  try {
    const user = req.user;
    const { plan_name, amount, billing_cycle, utr_number } = req.body;

    if (!plan_name || !amount || !utr_number) {
      return res.status(400).json({ error: "Plan details and 12-digit UPI UTR are required" });
    }

    const cleanUtr = String(utr_number).trim();
    if (cleanUtr.length < 6) {
      return res.status(400).json({ error: "Please enter a valid UPI Reference / UTR Number" });
    }

    const purchase = await createPurchase({
      institute_id: user.id,
      plan_name,
      amount: Number(amount),
      billing_cycle: billing_cycle || "Monthly",
      utr_number: cleanUtr,
    });

    return res.json({
      message: "Payment submitted successfully for verification!",
      purchase,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to submit purchase" });
  }
});

export default router;
