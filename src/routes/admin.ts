import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { getSystemSettings, updateSystemSettings } from "../lib/settings.js";
import { db, neonQuery } from "../lib/db.js";
import {
  getSubscriptionPlans,
  saveSubscriptionPlan,
  deleteSubscriptionPlan,
  getPaymentSettings,
  savePaymentSettings,
  getAllPurchases,
  updatePurchaseStatus,
} from "../lib/subscriptions.js";
import bcrypt from "bcryptjs";

const router = Router();

const SALT_ROUNDS = 10;

// Middleware to verify requester is super_admin
async function requireSuperAdmin(req: any, res: any, next: any) {
  try {
    const { data: profile } = await db
      .from("profiles_with_roles")
      .select("role_name")
      .eq("id", req.user.id)
      .single();

    if (profile?.role_name !== "super_admin") {
      return res.status(403).json({ error: "Forbidden: Super Admin access required" });
    }
    next();
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Forbidden" });
  }
}

// GET /api/admin/settings — get system settings
router.get("/settings", requireAuth, async (req: any, res) => {
  try {
    const settings = getSystemSettings();
    return res.json({ settings });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/admin/settings — update system settings (super admin only)
router.post("/settings", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const settings = updateSystemSettings(req.body);
    return res.json({ settings });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/admin/users — list all users (admin only)
router.get("/users", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { data: users, error } = await db
      .from("profiles_with_roles")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ users });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/admin/users/create — admin creates a user with any role
router.post("/users/create", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { email, password, fullName, role } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if user exists
    const existing = await neonQuery(
      `SELECT id FROM public.profiles WHERE email = $1 LIMIT 1;`,
      [normalizedEmail]
    );
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: "A user with this email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUserId = crypto.randomUUID();

    // Get role_id
    let roleId: string | null = null;
    const roleName = role || "student";
    const roles = await neonQuery(
      `SELECT id FROM public.roles WHERE name = $1 LIMIT 1;`,
      [roleName]
    );
    if (roles && roles.length > 0) roleId = roles[0].id;

    await neonQuery(
      `INSERT INTO public.profiles (id, email, full_name, encrypted_password, role_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW());`,
      [newUserId, normalizedEmail, fullName || "", hashedPassword, roleId]
    );

    return res.status(201).json({
      user: { id: newUserId, email: normalizedEmail, user_metadata: { full_name: fullName || "", role: roleName } },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PUT /api/admin/users/:id — update user details or toggle status
router.put("/users/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.fullName !== undefined) updates.full_name = body.fullName;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.isActive !== undefined) updates.is_active = body.isActive;

    const { error } = await db
      .from("profiles")
      .update(updates)
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ message: "User updated" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/admin/users/:id — delete a single user
router.delete("/users/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    if (req.user && req.user.id === id) {
      return res.status(400).json({ error: "You cannot delete your own admin account" });
    }

    await neonQuery(`DELETE FROM public.profiles WHERE id = $1;`, [id]);
    return res.json({ message: "User deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/admin/users/bulk-delete — bulk delete users
router.post("/users/bulk-delete", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required and must not be empty" });
    }

    const currentUserId = req.user?.id;
    const safeIds = currentUserId ? ids.filter((id: string) => id !== currentUserId) : ids;

    if (safeIds.length === 0) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    await neonQuery(`DELETE FROM public.profiles WHERE id = ANY($1::uuid[]);`, [safeIds]);
    return res.json({ message: "Users deleted successfully", count: safeIds.length });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/admin/users — bulk delete alternative route
router.delete("/users", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required and must not be empty" });
    }

    const currentUserId = req.user?.id;
    const safeIds = currentUserId ? ids.filter((id: string) => id !== currentUserId) : ids;

    if (safeIds.length === 0) {
      return res.status(400).json({ error: "Cannot delete your own account" });
    }

    await neonQuery(`DELETE FROM public.profiles WHERE id = ANY($1::uuid[]);`, [safeIds]);
    return res.json({ message: "Users deleted successfully", count: safeIds.length });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/admin/reports — list all test attempts with student + exam info
router.get("/reports", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const reports = await neonQuery(
      `SELECT 
         ta.id, ta.student_id, ta.exam_id, ta.score, ta.total_marks,
         ta.percentage, ta.time_taken_seconds, ta.status,
         ta.started_at, ta.submitted_at, ta.created_at,
         p.full_name AS student_name, p.email AS student_email,
         e.title AS exam_title, e.duration_minutes AS exam_duration
       FROM public.test_attempts ta
       LEFT JOIN public.profiles p ON ta.student_id = p.id
       LEFT JOIN public.exams e ON ta.exam_id = e.id
       ORDER BY ta.created_at DESC;`
    );

    return res.json({ reports: reports || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/admin/assign-tests
router.get("/assign-tests", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const examId = req.query.examId;

    const { data: institutes, error: instErr } = await db
      .from("profiles_with_roles")
      .select("id, full_name, email")
      .eq("role_name", "institute")
      .order("full_name", { ascending: true });

    if (instErr) return res.status(500).json({ error: instErr.message });
    if (!examId) {
      return res.json({ institutes });
    }

    const { data: assignments, error: assignErr } = await db
      .from("exam_assignments")
      .select("institute_id")
      .eq("exam_id", examId);

    if (assignErr) return res.status(500).json({ error: assignErr.message });

    const assignedSet = new Set((assignments || []).map((a: any) => a.institute_id));
    const institutesWithStatus = (institutes || []).map((inst: any) => ({
      ...inst,
      assigned: assignedSet.has(inst.id),
    }));

    return res.json({ institutes: institutesWithStatus });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/admin/assign-tests
router.post("/assign-tests", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { examId, instituteIds } = req.body;

    if (!examId || !Array.isArray(instituteIds)) {
      return res.status(400).json({ error: "examId and instituteIds are required" });
    }

    const rows = instituteIds.map((instId) => ({
      exam_id: examId,
      institute_id: instId,
      assigned_by: req.user.id,
    }));

    if (rows.length > 0) {
      const { error } = await db
        .from("exam_assignments")
        .upsert(rows, { onConflict: "exam_id,institute_id" });

      if (error) return res.status(500).json({ error: error.message });
    }

    return res.json({ message: "Assigned successfully" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/admin/assign-tests
router.delete("/assign-tests", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { examId, instituteId } = req.body;

    if (!examId || !instituteId) {
      return res.status(400).json({ error: "examId and instituteId are required in body" });
    }

    const { error } = await db
      .from("exam_assignments")
      .delete()
      .eq("exam_id", examId)
      .eq("institute_id", instituteId);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ message: "Assignment removed" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/admin/roles
router.get("/roles", optionalAuth, async (req: any, res) => {
  try {
    const { data: roles, error } = await db
      .from("roles")
      .select("*")
      .order("id", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ roles });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/admin/preview/:id — preview test
router.get("/preview/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;

    const { data: exam, error: examError } = await db
      .from("exams_with_creator")
      .select("*")
      .eq("id", id)
      .single();

    if (examError || !exam) {
      return res.status(404).json({ error: examError?.message || "Test not found" });
    }

    const { data: questions } = await db
      .from("questions")
      .select("id, question_text, question_type, marks, options, correct_answer, explanation, order_index, subject_id")
      .eq("exam_id", id)
      .order("order_index", { ascending: true });

    const { data: subjects } = await db
      .from("subjects")
      .select("id, name")
      .eq("exam_id", id)
      .order("order_index", { ascending: true });

    return res.json({
      exam,
      questions: questions || [],
      subjects: subjects || [],
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/admin/institutes
router.get("/institutes", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { data: institutes, error } = await db
      .from("profiles_with_roles")
      .select("*")
      .eq("role_name", "institute")
      .order("created_at", { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ institutes });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/admin/institutes — create a new institute account
router.post("/institutes", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { email, password, fullName, phone } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email and password required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existing = await neonQuery(
      `SELECT id FROM public.profiles WHERE email = $1 LIMIT 1;`,
      [normalizedEmail]
    );
    if (existing && existing.length > 0) {
      return res.status(400).json({ error: "A user with this email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);
    const newUserId = crypto.randomUUID();

    let roleId: string | null = null;
    const roles = await neonQuery(`SELECT id FROM public.roles WHERE name = 'institute' LIMIT 1;`);
    if (roles && roles.length > 0) roleId = roles[0].id;

    await neonQuery(
      `INSERT INTO public.profiles (id, email, full_name, encrypted_password, role_id, phone, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW());`,
      [newUserId, normalizedEmail, fullName || "", hashedPassword, roleId, phone || null]
    );

    return res.status(201).json({
      institute: { id: newUserId, email: normalizedEmail, user_metadata: { full_name: fullName || "" } },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PUT /api/admin/institutes/:id
router.put("/institutes/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (body.fullName !== undefined) updates.full_name = body.fullName;
    if (body.phone !== undefined) updates.phone = body.phone;
    if (body.isActive !== undefined) updates.is_active = body.isActive;

    const { error } = await db
      .from("profiles")
      .update(updates)
      .eq("id", id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ message: "Updated" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/admin/institutes/:id
router.delete("/institutes/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;

    await neonQuery(`DELETE FROM public.profiles WHERE id = $1;`, [id]);
    return res.json({ message: "Deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/admin/institutes/bulk-delete
router.post("/institutes/bulk-delete", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required and must not be empty" });
    }

    await neonQuery(`DELETE FROM public.profiles WHERE id = ANY($1::uuid[]);`, [ids]);
    return res.json({ message: "Institutes deleted successfully", count: ids.length });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/admin/institutes (bulk delete via body)
router.delete("/institutes", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "ids array is required and must not be empty" });
    }

    await neonQuery(`DELETE FROM public.profiles WHERE id = ANY($1::uuid[]);`, [ids]);
    return res.json({ message: "Institutes deleted successfully", count: ids.length });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/admin/questions — List all questions across all exams with subjects, exam title & creator info
router.get("/questions", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
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
        e.title AS exam_title,
        p.full_name AS creator_name,
        p.email AS creator_email
      FROM public.questions q
      LEFT JOIN public.subjects s ON q.subject_id = s.id
      LEFT JOIN public.subject_topics st ON q.topic_id = st.id
      LEFT JOIN public.exams e ON q.exam_id = e.id
      LEFT JOIN public.profiles p ON e.created_by = p.id
      ORDER BY q.created_at DESC;
    `;
    const questions = await neonQuery(sql);

    // Fetch all unique subjects and topics for assignment dropdown
    const subjects = await neonQuery(`SELECT id, name, exam_id FROM public.subjects ORDER BY name ASC;`);
    const topics = await neonQuery(`SELECT id, subject_id, title FROM public.subject_topics ORDER BY title ASC;`);

    return res.json({ questions, subjects, topics });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PUT /api/admin/questions/:id/subject — Assign or update topic/subject for a question
router.put("/questions/:id/subject", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { subject_id, topic_id } = req.body;

    const sql = `
      UPDATE public.questions 
      SET subject_id = $1, 
          topic_id = $2 
      WHERE id = $3 
      RETURNING *;
    `;
    const updated = await neonQuery(sql, [
      subject_id === "none" ? null : (subject_id || null),
      topic_id === "none" ? null : (topic_id || null),
      id
    ]);

    if (!updated || updated.length === 0) {
      return res.status(404).json({ error: "Question not found" });
    }

    return res.json({ message: "Topic assigned successfully", question: updated[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/admin/plans — List all plans (admin view)
router.get("/plans", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const plans = await getSubscriptionPlans();
    return res.json({ plans: plans || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch plans" });
  }
});

// POST /api/admin/plans — Create or update a plan
router.post("/plans", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id, name, price, currency, billing_cycle, description, features, popular, active, order_index } = req.body;

    if (!name || price === undefined) {
      return res.status(400).json({ error: "Plan name and price are required" });
    }

    const saved = await saveSubscriptionPlan({
      id,
      name,
      price: Number(price),
      currency: currency || "INR",
      billing_cycle: billing_cycle || "Monthly",
      description: description || "",
      features: Array.isArray(features) ? features : [],
      popular: Boolean(popular),
      active: active !== undefined ? Boolean(active) : true,
      order_index: order_index ? Number(order_index) : 0,
    });

    return res.json({ message: "Plan saved successfully", plan: saved });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to save plan" });
  }
});

// DELETE /api/admin/plans/:id — Delete a plan
router.delete("/plans/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    await deleteSubscriptionPlan(id);
    return res.json({ message: "Plan deleted successfully" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to delete plan" });
  }
});

// GET /api/admin/payment-settings — Get current UPI payment settings
router.get("/payment-settings", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const settings = await getPaymentSettings();
    return res.json({ settings });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch payment settings" });
  }
});

// POST /api/admin/payment-settings — Update UPI payment settings
router.post("/payment-settings", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { upi_id, upi_name, notes, qr_code_url } = req.body;

    if (!upi_id) {
      return res.status(400).json({ error: "UPI ID is required (e.g. yourname@okhdfcbank)" });
    }

    const saved = await savePaymentSettings({
      upi_id,
      upi_name,
      notes,
      qr_code_url,
    });

    return res.json({ message: "Payment settings saved successfully", settings: saved });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to save payment settings" });
  }
});

// GET /api/admin/purchases — List all institute purchases across the platform
router.get("/purchases", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const purchases = await getAllPurchases();
    return res.json({ purchases: purchases || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch purchases" });
  }
});

// PATCH /api/admin/purchases/:id/status — Approve or reject an institute purchase
router.patch("/purchases/:id/status", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!["completed", "active", "rejected", "pending_verification"].includes(status)) {
      return res.status(400).json({ error: "Invalid status value" });
    }

    await updatePurchaseStatus(id, status, req.user?.id, notes);
    return res.json({ message: `Purchase status updated to ${status}` });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to update purchase status" });
  }
});

// ─── LEADS MANAGEMENT ──────────────────────────────────────────────────────────

// GET /api/admin/leads — List all leads
router.get("/leads", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const leads = await neonQuery(
      `SELECT l.*, p.full_name AS assigned_name, p.email AS assigned_email
       FROM public.leads l
       LEFT JOIN public.profiles p ON l.assigned_to = p.id
       ORDER BY l.created_at DESC;`
    );
    return res.json({ leads: leads || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch leads" });
  }
});

// GET /api/admin/leads/stats — Aggregate pipeline stats
router.get("/leads/stats", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const stageStats = await neonQuery(
      `SELECT stage, COUNT(*)::int AS count, COALESCE(SUM(value), 0)::numeric AS total_value
       FROM public.leads
       GROUP BY stage;`
    );
    const totalLeads = await neonQuery(`SELECT COUNT(*)::int AS count FROM public.leads;`);
    const totalValue = await neonQuery(`SELECT COALESCE(SUM(value), 0)::numeric AS total FROM public.leads WHERE stage != 'lost';`);
    const wonCount = await neonQuery(`SELECT COUNT(*)::int AS count FROM public.leads WHERE stage = 'won';`);

    return res.json({
      stages: stageStats || [],
      totalLeads: totalLeads?.[0]?.count || 0,
      pipelineValue: totalValue?.[0]?.total || 0,
      wonCount: wonCount?.[0]?.count || 0,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch lead stats" });
  }
});

// POST /api/admin/leads — Create a new lead
router.post("/leads", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { name, email, phone, organization, source, stage, priority, value, notes, next_follow_up, tags } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Lead name is required" });
    }

    const result = await neonQuery(
      `INSERT INTO public.leads (name, email, phone, organization, source, stage, priority, value, notes, next_follow_up, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *;`,
      [
        name,
        email || null,
        phone || null,
        organization || null,
        source || "manual",
        stage || "new",
        priority || "medium",
        value || 0,
        notes || null,
        next_follow_up || null,
        tags || [],
      ]
    );

    return res.status(201).json({ lead: result?.[0] || null });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to create lead" });
  }
});

// PUT /api/admin/leads/:id — Update a lead
router.put("/leads/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, organization, source, stage, priority, value, notes, next_follow_up, tags, assigned_to } = req.body;

    const result = await neonQuery(
      `UPDATE public.leads SET
        name = COALESCE($1, name),
        email = $2,
        phone = $3,
        organization = $4,
        source = COALESCE($5, source),
        stage = COALESCE($6, stage),
        priority = COALESCE($7, priority),
        value = COALESCE($8, value),
        notes = $9,
        next_follow_up = $10,
        tags = COALESCE($11, tags),
        assigned_to = $12,
        updated_at = NOW()
       WHERE id = $13
       RETURNING *;`,
      [
        name || null,
        email ?? null,
        phone ?? null,
        organization ?? null,
        source || null,
        stage || null,
        priority || null,
        value ?? null,
        notes ?? null,
        next_follow_up ?? null,
        tags || null,
        assigned_to || null,
        id,
      ]
    );

    if (!result || result.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    return res.json({ lead: result[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to update lead" });
  }
});

// PATCH /api/admin/leads/:id/stage — Quick stage update (for drag-and-drop)
router.patch("/leads/:id/stage", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { stage } = req.body;

    const validStages = ["new", "contacted", "qualified", "proposal_sent", "negotiation", "won", "lost"];
    if (!stage || !validStages.includes(stage)) {
      return res.status(400).json({ error: `Invalid stage. Must be one of: ${validStages.join(", ")}` });
    }

    const result = await neonQuery(
      `UPDATE public.leads SET stage = $1, updated_at = NOW() WHERE id = $2 RETURNING *;`,
      [stage, id]
    );

    if (!result || result.length === 0) {
      return res.status(404).json({ error: "Lead not found" });
    }

    return res.json({ lead: result[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to update lead stage" });
  }
});

// DELETE /api/admin/leads/:id — Delete a lead
router.delete("/leads/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    await neonQuery(`DELETE FROM public.leads WHERE id = $1;`, [id]);
    return res.json({ message: "Lead deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to delete lead" });
  }
});

// ─── PROPOSALS MANAGEMENT ──────────────────────────────────────────────────────

// GET /api/admin/proposals — List all proposals
router.get("/proposals", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const proposals = await neonQuery(
      `SELECT p.*, l.name AS lead_name, l.organization AS lead_organization
       FROM public.proposals p
       LEFT JOIN public.leads l ON p.lead_id = l.id
       ORDER BY p.created_at DESC;`
    );
    return res.json({ proposals: proposals || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch proposals" });
  }
});

// GET /api/admin/proposals/:id — Get single proposal
router.get("/proposals/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const result = await neonQuery(
      `SELECT p.*, l.name AS lead_name, l.organization AS lead_organization
       FROM public.proposals p
       LEFT JOIN public.leads l ON p.lead_id = l.id
       WHERE p.id = $1;`,
      [id]
    );
    if (!result || result.length === 0) {
      return res.status(404).json({ error: "Proposal not found" });
    }
    return res.json({ proposal: result[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch proposal" });
  }
});

// POST /api/admin/proposals — Create a new proposal
router.post("/proposals", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const {
      title, client_name, client_email, client_phone, client_organization, lead_id,
      intro_text, plan_name, plan_price, plan_billing_cycle, plan_features, custom_features,
      discount_percent, validity_days, terms, status
    } = req.body;

    if (!title || !client_name) {
      return res.status(400).json({ error: "Title and client name are required" });
    }

    const result = await neonQuery(
      `INSERT INTO public.proposals (
        title, client_name, client_email, client_phone, client_organization, lead_id,
        intro_text, plan_name, plan_price, plan_billing_cycle, plan_features, custom_features,
        discount_percent, validity_days, terms, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *;`,
      [
        title,
        client_name,
        client_email || null,
        client_phone || null,
        client_organization || null,
        lead_id || null,
        intro_text || null,
        plan_name || null,
        plan_price || 0,
        plan_billing_cycle || "Monthly",
        JSON.stringify(plan_features || []),
        JSON.stringify(custom_features || []),
        discount_percent || 0,
        validity_days || 30,
        terms || null,
        status || "draft",
      ]
    );

    return res.status(201).json({ proposal: result?.[0] || null });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to create proposal" });
  }
});

// PUT /api/admin/proposals/:id — Update a proposal
router.put("/proposals/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const {
      title, client_name, client_email, client_phone, client_organization, lead_id,
      intro_text, plan_name, plan_price, plan_billing_cycle, plan_features, custom_features,
      discount_percent, validity_days, terms, status, sent_at, sent_via
    } = req.body;

    const result = await neonQuery(
      `UPDATE public.proposals SET
        title = COALESCE($1, title),
        client_name = COALESCE($2, client_name),
        client_email = $3,
        client_phone = $4,
        client_organization = $5,
        lead_id = $6,
        intro_text = $7,
        plan_name = $8,
        plan_price = COALESCE($9, plan_price),
        plan_billing_cycle = COALESCE($10, plan_billing_cycle),
        plan_features = COALESCE($11, plan_features),
        custom_features = COALESCE($12, custom_features),
        discount_percent = COALESCE($13, discount_percent),
        validity_days = COALESCE($14, validity_days),
        terms = $15,
        status = COALESCE($16, status),
        sent_at = $17,
        sent_via = $18,
        updated_at = NOW()
       WHERE id = $19
       RETURNING *;`,
      [
        title || null,
        client_name || null,
        client_email ?? null,
        client_phone ?? null,
        client_organization ?? null,
        lead_id ?? null,
        intro_text ?? null,
        plan_name ?? null,
        plan_price ?? null,
        plan_billing_cycle || null,
        plan_features ? JSON.stringify(plan_features) : null,
        custom_features ? JSON.stringify(custom_features) : null,
        discount_percent ?? null,
        validity_days ?? null,
        terms ?? null,
        status || null,
        sent_at ?? null,
        sent_via ?? null,
        id,
      ]
    );

    if (!result || result.length === 0) {
      return res.status(404).json({ error: "Proposal not found" });
    }

    return res.json({ proposal: result[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to update proposal" });
  }
});

// DELETE /api/admin/proposals/:id — Delete a proposal
router.delete("/proposals/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    await neonQuery(`DELETE FROM public.proposals WHERE id = $1;`, [id]);
    return res.json({ message: "Proposal deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to delete proposal" });
  }
});

// ─── DAILY ROUTINE & FIELD TRACKER (10 CALLS + 3 VISITS) ────────────────────────

// GET /api/admin/daily-tracker — Fetch calls, visits, and stats for a given date
router.get("/daily-tracker", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().split("T")[0];

    const calls = await neonQuery(
      `SELECT * FROM public.daily_calls 
       WHERE call_date = $1 
       ORDER BY created_at DESC;`,
      [targetDate]
    );

    const visits = await neonQuery(
      `SELECT * FROM public.daily_visits 
       WHERE visit_date = $1 
       ORDER BY created_at DESC;`,
      [targetDate]
    );

    // Get total past days activity for calendar / streak metrics
    const recentActivity = await neonQuery(
      `SELECT 
         d.date::text,
         COALESCE(c.call_count, 0) as call_count,
         COALESCE(v.visit_count, 0) as visit_count
       FROM (
         SELECT generate_series(
           CURRENT_DATE - INTERVAL '14 days',
           CURRENT_DATE,
           '1 day'::interval
         )::date as date
       ) d
       LEFT JOIN (
         SELECT call_date, COUNT(*) as call_count 
         FROM public.daily_calls 
         GROUP BY call_date
       ) c ON d.date = c.call_date
       LEFT JOIN (
         SELECT visit_date, COUNT(*) as visit_count 
         FROM public.daily_visits 
         GROUP BY visit_date
       ) v ON d.date = v.visit_date
       ORDER BY d.date DESC;`
    );

    // Calculate total calls and visits of all time
    const totals = await neonQuery(
      `SELECT 
        (SELECT COUNT(*) FROM public.daily_calls) as total_calls_all_time,
        (SELECT COUNT(*) FROM public.daily_visits) as total_visits_all_time;`
    );

    return res.json({
      date: targetDate,
      calls: calls || [],
      visits: visits || [],
      stats: {
        calls_count: calls?.length || 0,
        calls_target: 10,
        visits_count: visits?.length || 0,
        visits_target: 3,
        total_calls_all_time: Number(totals?.[0]?.total_calls_all_time || 0),
        total_visits_all_time: Number(totals?.[0]?.total_visits_all_time || 0),
      },
      recentActivity: recentActivity || [],
    });
  } catch (error: any) {
    console.error("Failed to fetch daily tracker data:", error);
    return res.status(500).json({ error: error.message || "Failed to fetch daily tracker" });
  }
});

// POST /api/admin/daily-tracker/calls — Log a phone call
router.post("/daily-tracker/calls", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const {
      call_date = new Date().toISOString().split("T")[0],
      institute_name,
      person_name,
      phone,
      outcome = "interested",
      notes,
    } = req.body;

    if (!institute_name || !phone) {
      return res.status(400).json({ error: "Institute name and phone number are required" });
    }

    const result = await neonQuery(
      `INSERT INTO public.daily_calls (
        call_date, institute_name, person_name, phone, outcome, notes
      ) VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *;`,
      [call_date, institute_name, person_name || null, phone, outcome, notes || null]
    );

    return res.status(201).json({ call: result[0] });
  } catch (error: any) {
    console.error("Failed to log call:", error);
    return res.status(500).json({ error: error.message || "Failed to log call" });
  }
});

// DELETE /api/admin/daily-tracker/calls/:id — Delete a call log
router.delete("/daily-tracker/calls/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    await neonQuery(`DELETE FROM public.daily_calls WHERE id = $1;`, [id]);
    return res.json({ message: "Call deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to delete call" });
  }
});

// POST /api/admin/daily-tracker/visits — Log a physical academy visit with selfie
router.post("/daily-tracker/visits", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const {
      visit_date = new Date().toISOString().split("T")[0],
      academy_name,
      person_name,
      role_title,
      phone,
      address,
      location_coords,
      selfie_url,
      outcome = "demo_given",
      follow_up_date,
      notes,
    } = req.body;

    if (!academy_name || !person_name || !phone || !address) {
      return res.status(400).json({
        error: "Academy name, person name, phone, and address are required",
      });
    }

    const result = await neonQuery(
      `INSERT INTO public.daily_visits (
        visit_date, academy_name, person_name, role_title, phone,
        address, location_coords, selfie_url, outcome, follow_up_date, notes
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;`,
      [
        visit_date,
        academy_name,
        person_name,
        role_title || null,
        phone,
        address,
        location_coords || null,
        selfie_url || null,
        outcome,
        follow_up_date || null,
        notes || null,
      ]
    );

    return res.status(201).json({ visit: result[0] });
  } catch (error: any) {
    console.error("Failed to log visit:", error);
    return res.status(500).json({ error: error.message || "Failed to log visit" });
  }
});

// DELETE /api/admin/daily-tracker/visits/:id — Delete a visit log
router.delete("/daily-tracker/visits/:id", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    await neonQuery(`DELETE FROM public.daily_visits WHERE id = $1;`, [id]);
    return res.json({ message: "Visit deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to delete visit" });
  }
});

// POST /api/admin/daily-tracker/convert-to-lead — Convert a visit or call into a Lead in Kanban
router.post("/daily-tracker/convert-to-lead", requireAuth, requireSuperAdmin, async (req: any, res) => {
  try {
    const { name, contact_person, phone, address, notes, source } = req.body;

    if (!name) {
      return res.status(400).json({ error: "Institute or academy name is required" });
    }

    const result = await neonQuery(
      `INSERT INTO public.leads (
        name, contact_person, phone, city, notes, stage, source
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *;`,
      [
        name,
        contact_person || null,
        phone || null,
        address || null,
        notes || null,
        "contacted",
        source || "Field Visit",
      ]
    );

    return res.status(201).json({ lead: result[0], message: "Successfully added to Leads pipeline!" });
  } catch (error: any) {
    console.error("Failed to convert to lead:", error);
    return res.status(500).json({ error: error.message || "Failed to convert to lead" });
  }
});

export default router;


