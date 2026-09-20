import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db, neonQuery } from "../lib/db.js";

const router = Router();

// GET — list exams (institute sees own, admin sees all)
router.get("/", requireAuth, async (req: any, res) => {
  try {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    const user = req.user;
    const { scope, creator_role } = req.query;

    // Check role to scope results (check token role, or look up in DB)
    let userRole = user.role;
    if (!userRole) {
      try {
        const profiles = await neonQuery(
          `SELECT role_name FROM public.profiles_with_roles WHERE id = $1 LIMIT 1;`,
          [user.id]
        );
        if (profiles && profiles.length > 0 && profiles[0].role_name) {
          userRole = profiles[0].role_name;
        }
      } catch {
        // Fallback to db query
        const { data: profile } = await db
          .from("profiles_with_roles")
          .select("role_name")
          .eq("id", user.id)
          .single();
        userRole = profile?.role_name;
      }
    }

    const isSuperOrAdmin = userRole === "super_admin" || userRole === "admin";
    let query = db.from("exams_with_creator").select("*");

    if (!isSuperOrAdmin || scope === "own") {
      // Institutes and non-admins can ONLY see their own exams
      query = query.eq("created_by", user.id);
    } else if (scope === "institute" || creator_role === "institute") {
      // Admin scoping to all institute tests
      query = query.eq("creator_role", "institute");
    } else if (creator_role) {
      query = query.eq("creator_role", creator_role);
    }

    const { data: exams, error } = await query.order("created_at", { ascending: false });
    if (error) return res.status(500).json({ error: error.message });

    return res.json({ exams });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST — create exam
router.post("/", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;
    const body = req.body;

    const { data: exam, error } = await db
      .from("exams")
      .insert({
        title: body.title,
        description: body.description || "",
        exam_type: body.exam_type || "short",
        question_mode: body.question_mode || "objective",
        duration_minutes: body.duration_minutes || 30,
        total_marks: body.total_marks || 0,
        status: body.status || "draft",
        category_id: body.category_id || null,
        created_by: user.id,
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Auto-assign the exam to the creator's own academy if they are an institute
    const { data: creatorProfile } = await db
      .from("profiles_with_roles")
      .select("role_name")
      .eq("id", user.id)
      .single();

    if (creatorProfile?.role_name === "institute" && exam) {
      await db.from("exam_assignments").insert({
        exam_id: exam.id,
        institute_id: user.id,
        assigned_by: user.id,
      });
    }

    if (creatorProfile?.role_name === "super_admin" && exam && body.institute_id) {
      await db.from("exam_assignments").insert({
        exam_id: exam.id,
        institute_id: body.institute_id,
        assigned_by: user.id,
      });
    }

    return res.status(201).json({ exam });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET single exam
router.get("/:id", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;

    const { data: exam, error } = await db
      .from("exams_with_creator")
      .select("*")
      .eq("id", id)
      .single();

    if (error) return res.status(404).json({ error: error.message });
    return res.json({ exam });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PUT — update exam
router.put("/:id", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    const { data: exam, error } = await db
      .from("exams")
      .update({ ...body, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ exam });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE exam
router.delete("/:id", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;

    const { error } = await db.from("exams").delete().eq("id", id);

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ message: "Deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET — list subjects for an exam
router.get("/:id/subjects", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;

    const { data: subjects, error } = await db
      .from("subjects")
      .select("*")
      .eq("exam_id", id)
      .order("order_index", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ subjects });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST — add subject(s) to an exam
router.post("/:id/subjects", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    const items = Array.isArray(body) ? body : [body];

    const prepared = items.map((s: { name: string; order_index?: number }, i: number) => ({
      exam_id: id,
      name: s.name.trim(),
      order_index: s.order_index ?? i,
    }));

    const { data: subjects, error } = await db
      .from("subjects")
      .insert(prepared)
      .select();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ subjects });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PUT — update a subject
router.put("/:id/subjects/:subjectId", requireAuth, async (req: any, res) => {
  try {
    const { subjectId } = req.params;
    const body = req.body;

    const { data: subject, error } = await db
      .from("subjects")
      .update({ name: body.name, order_index: body.order_index })
      .eq("id", subjectId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ subject });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE — delete a subject
router.delete("/:id/subjects/:subjectId", requireAuth, async (req: any, res) => {
  try {
    const { subjectId } = req.params;

    const { error } = await db.from("subjects").delete().eq("id", subjectId);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ message: "Deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET — list questions for an exam
router.get("/:id/questions", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;

    const questions = await neonQuery(`
      SELECT 
        q.*,
        s.name AS subject_name,
        st.title AS topic_title
      FROM public.questions q
      LEFT JOIN public.subjects s ON q.subject_id = s.id
      LEFT JOIN public.subject_topics st ON q.topic_id = st.id
      WHERE q.exam_id = $1
      ORDER BY q.order_index ASC;
    `, [id]);

    if (questions && questions.length > 0) {
      const qIds = questions.map((q: any) => q.id);
      const { data: translations } = await db
        .from("question_translations")
        .select("*")
        .in("question_id", qIds);

      if (translations) {
        for (const q of questions) {
          const hi = translations.find((t: any) => t.question_id === q.id && t.language === "hindi");
          const mr = translations.find((t: any) => t.question_id === q.id && t.language === "marathi");

          if (hi) {
            q.question_text_hi = hi.question_text;
            q.correct_answer_hi = hi.correct_answer;
            q.explanation_hi = hi.explanation;
            if (Array.isArray(q.options) && Array.isArray(hi.options)) {
              q.options = q.options.map((opt: any, idx: number) => ({
                ...opt,
                text_hi: hi.options[idx]?.text || "",
              }));
            }
          }
          if (mr) {
            q.question_text_mr = mr.question_text;
            q.correct_answer_mr = mr.correct_answer;
            q.explanation_mr = mr.explanation;
            if (Array.isArray(q.options) && Array.isArray(mr.options)) {
              q.options = q.options.map((opt: any, idx: number) => ({
                ...opt,
                text_mr: mr.options[idx]?.text || "",
              }));
            }
          }
        }
      }
    }

    return res.json({ questions });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST — add question(s) to an exam
router.post("/:id/questions", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const body = req.body;

    const questions = Array.isArray(body) ? body : [body];
    const prepared = questions.map((q, i) => ({
      exam_id: id,
      question_text: q.question_text,
      question_type: q.question_type || "mcq",
      marks: q.marks || 1,
      options: q.options || [],
      correct_answer: q.correct_answer || "",
      explanation: q.explanation || "",
      order_index: q.order_index ?? i,
      subject_id: q.subject_id || null,
      topic_id: q.topic_id || null,
    }));

    const { data, error } = await db
      .from("questions")
      .insert(prepared)
      .select();

    if (error) return res.status(500).json({ error: error.message });

    // Recalculate total_marks on exam
    const { data: allQ } = await db
      .from("questions")
      .select("marks")
      .eq("exam_id", id);
    if (allQ) {
      const newTotal = allQ.reduce((s: number, q: { marks: number }) => s + q.marks, 0);
      await db.from("exams").update({ total_marks: newTotal }).eq("id", id);
    }

    return res.status(201).json({ questions: data });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE — remove a single question from an exam
router.delete("/:id/questions/:qid", requireAuth, async (req: any, res) => {
  try {
    const { id, qid } = req.params;

    // Delete the question
    const { error } = await db
      .from("questions")
      .delete()
      .eq("id", qid)
      .eq("exam_id", id);

    if (error) return res.status(500).json({ error: error.message });

    // Recalculate total_marks on exam
    const { data: allQ } = await db
      .from("questions")
      .select("marks")
      .eq("exam_id", id);

    const newTotal = allQ
      ? allQ.reduce((s: number, q: { marks: number }) => s + q.marks, 0)
      : 0;
    await db.from("exams").update({ total_marks: newTotal }).eq("id", id);

    return res.json({ message: "Deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PUT — update a single question in an exam (e.g. marks, content)
router.put("/:id/questions/:qid", requireAuth, async (req: any, res) => {
  try {
    const { id, qid } = req.params;
    const body = req.body;

    const updates: any = {};
    if (body.marks !== undefined) updates.marks = Number(body.marks) || 1;
    if (body.question_text !== undefined) updates.question_text = body.question_text;
    if (body.question_type !== undefined) updates.question_type = body.question_type;
    if (body.options !== undefined) updates.options = body.options;
    if (body.correct_answer !== undefined) updates.correct_answer = body.correct_answer;
    if (body.explanation !== undefined) updates.explanation = body.explanation;
    if (body.subject_id !== undefined) updates.subject_id = body.subject_id;
    if (body.topic_id !== undefined) updates.topic_id = body.topic_id;

    const { data, error } = await db
      .from("questions")
      .update(updates)
      .eq("id", qid)
      .eq("exam_id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });

    // Recalculate total_marks on exam
    const { data: allQ } = await db
      .from("questions")
      .select("marks")
      .eq("exam_id", id);

    const newTotal = allQ
      ? allQ.reduce((s: number, q: { marks: number }) => s + Number(q.marks || 0), 0)
      : 0;
    await db.from("exams").update({ total_marks: newTotal }).eq("id", id);

    return res.json({ question: data, total_marks: newTotal });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

export default router;
