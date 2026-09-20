import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { getSystemSettings } from "../lib/settings.js";
import { db, neonQuery } from "../lib/db.js";

const router = Router();

// GET /api/student/results — list all submitted attempts with exam info
router.get("/results", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;

    const results = await neonQuery(
      `SELECT ta.id, ta.exam_id, ta.score, ta.total_marks, ta.percentage, ta.time_taken_seconds, ta.submitted_at,
              e.title, e.exam_type, e.question_mode
       FROM public.test_attempts ta
       LEFT JOIN public.exams e ON ta.exam_id = e.id
       WHERE ta.student_id = $1 AND ta.status = 'submitted'
       ORDER BY ta.submitted_at DESC;`,
      [user.id]
    );

    // Shape response
    const attempts = (results || []).map((r: any) => ({
      id: r.id,
      exam_id: r.exam_id,
      score: r.score,
      total_marks: r.total_marks,
      percentage: r.percentage,
      time_taken_seconds: r.time_taken_seconds,
      submitted_at: r.submitted_at,
      exams: { title: r.title, exam_type: r.exam_type, question_mode: r.question_mode },
    }));

    return res.json({ results: attempts });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/student/tests — fetch tests list
router.get("/tests", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;

    // Get student's institute_id
    const { data: profile } = await db
      .from("profiles")
      .select("institute_id")
      .eq("id", user.id)
      .single();
    const instituteId = profile?.institute_id;

    // Institute tests — published tests explicitly assigned to the student's academy
    let instituteExams: any[] = [];
    if (instituteId) {
      const rows = await neonQuery(
        `SELECT e.id, e.title, e.description, e.exam_type, e.question_mode,
                e.duration_minutes, e.total_marks, e.is_paid, e.price, e.created_at, e.status
         FROM public.exam_assignments ea
         JOIN public.exams e ON ea.exam_id = e.id
         WHERE ea.institute_id = $1 AND e.status = 'published';`,
        [instituteId]
      );
      instituteExams = rows || [];
    }

    // Platform tests — published tests created by super_admin that are NOT already in institute assignments
    const settings = getSystemSettings();
    let platformExams: any[] = [];

    if (settings.platform_tests_enabled) {
      const assignedExamIds = new Set(instituteExams.map((e) => e.id));

      const rows = await neonQuery(
        `SELECT e.id, e.title, e.description, e.exam_type, e.question_mode,
                e.duration_minutes, e.total_marks, e.is_paid, e.price, e.created_at, e.created_by
         FROM public.exams e
         WHERE e.status = 'published'
         ORDER BY e.created_at DESC;`
      );

      // Fetch admin ids
      const adminProfiles = await neonQuery(
        `SELECT id FROM public.profiles_with_roles WHERE role_name = 'super_admin';`
      );

      const adminIds = new Set((adminProfiles || []).map((p: any) => p.id));

      platformExams = (rows || []).filter(
        (e: any) => adminIds.has(e.created_by) && !assignedExamIds.has(e.id)
      );
    }

    // Fetch student's completed attempts
    const { data: attempts } = await db
      .from("test_attempts")
      .select("exam_id, score, total_marks, percentage")
      .eq("student_id", user.id)
      .eq("status", "submitted");

    // Build attempted exams map
    const attemptedExams: Record<string, any> = {};
    if (attempts) {
      for (const a of attempts) {
        attemptedExams[a.exam_id] = {
          score: a.score,
          totalMarks: a.total_marks,
          percentage: a.percentage,
        };
      }
    }

    return res.json({ instituteExams, platformExams, attemptedExams });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/student/tests/:id — fetch test details
router.get("/tests/:id", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;
    const { id } = req.params;

    // Fetch exam
    const exams = await neonQuery(
      `SELECT id, title, description, exam_type, question_mode, duration_minutes, total_marks, status
       FROM public.exams WHERE id = $1 AND status = 'published' LIMIT 1;`,
      [id]
    );

    if (!exams || exams.length === 0) {
      return res.status(404).json({ error: "Test not found or not published" });
    }
    const exam = exams[0];

    // Fetch questions
    const { data: questions } = await db
      .from("questions")
      .select("id, question_text, question_type, marks, options, order_index, subject_id")
      .eq("exam_id", id)
      .order("order_index", { ascending: true });

    // Fetch subjects
    const { data: subjects } = await db
      .from("subjects")
      .select("id, name")
      .eq("exam_id", id)
      .order("order_index", { ascending: true });

    // Fetch languages available
    const questionIds = (questions || []).map((q: any) => q.id);
    let availableLanguages: string[] = [];
    if (questionIds.length > 0) {
      const { data: translationRows } = await db
        .from("question_translations")
        .select("language")
        .in("question_id", questionIds);
      if (translationRows) {
        availableLanguages = [...new Set(translationRows.map((r: any) => r.language))] as string[];
      }
    }

    // Fetch previous attempt
    const prevAttempts = await neonQuery(
      `SELECT score, total_marks, percentage FROM public.test_attempts
       WHERE exam_id = $1 AND student_id = $2 AND status = 'submitted'
       ORDER BY submitted_at DESC LIMIT 1;`,
      [id, user.id]
    );

    const existingAttempt = prevAttempts && prevAttempts.length > 0 ? prevAttempts[0] : null;

    return res.json({
      exam,
      questions: questions || [],
      subjects: subjects || [],
      availableLanguages,
      attempt: existingAttempt || null,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/student/tests/:id — submit test attempt
router.post("/tests/:id", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;
    const { id } = req.params;
    const { answers, timeTakenSeconds } = req.body;

    // Fetch exam + questions to calculate score
    const { data: exam } = await db.from("exams").select("total_marks").eq("id", id).single();
    const { data: questions } = await db
      .from("questions")
      .select("id, question_type, marks, options, correct_answer")
      .eq("exam_id", id);

    let score = 0;
    const totalMarks = exam?.total_marks || 0;

    if (questions && answers) {
      for (const q of questions) {
        const studentAnswer = answers[q.id];
        if (studentAnswer === undefined || studentAnswer === null || studentAnswer === "") continue;

        if (q.question_type === "mcq") {
          const opts = (q.options || []) as { text: string; is_correct: boolean }[];
          const correctIndex = opts.findIndex((o) => o.is_correct);
          if (parseInt(String(studentAnswer)) === correctIndex) {
            score += q.marks;
          }
        } else {
          if (q.correct_answer && String(studentAnswer).trim().toLowerCase() === q.correct_answer.trim().toLowerCase()) {
            score += q.marks;
          }
        }
      }
    }

    const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 10000) / 100 : 0;

    // Save the attempt
    const { data: attempt, error } = await db
      .from("test_attempts")
      .insert({
        exam_id: id,
        student_id: user.id,
        answers,
        score,
        total_marks: totalMarks,
        percentage,
        time_taken_seconds: timeTakenSeconds || 0,
        status: "submitted",
        submitted_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ attempt, score, totalMarks, percentage });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/student/profile
router.get("/profile", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;

    const { data: profile } = await db
      .from("profiles")
      .select("full_name, email, phone, avatar_url, institute_id, created_at")
      .eq("id", user.id)
      .single();

    let institute = null;
    if (profile?.institute_id) {
      const { data: inst } = await db
        .from("profiles")
        .select("full_name")
        .eq("id", profile.institute_id)
        .single();
      institute = inst;
    }

    return res.json({ profile, institute });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PATCH /api/student/profile
router.patch("/profile", requireAuth, async (req: any, res) => {
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
      .select("full_name, email, phone, avatar_url, institute_id, created_at")
      .single();

    if (error) return res.status(500).json({ error: error.message });

    return res.json({ profile });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// In-memory bookmark fallback store
const inMemoryBookmarks = new Map<string, Set<string>>();

// GET /api/student/bookmarks — get student's bookmarked tests
router.get("/bookmarks", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;

    let bookmarkedExamIds: string[] = [];

    // Try fetching from Neon table
    const { data: dbBookmarks, error } = await db
      .from("test_bookmarks")
      .select("exam_id")
      .eq("student_id", user.id);

    if (!error && dbBookmarks) {
      bookmarkedExamIds = dbBookmarks.map((b: any) => b.exam_id);
    } else {
      // Fallback to in-memory store
      const set = inMemoryBookmarks.get(user.id);
      bookmarkedExamIds = set ? Array.from(set) : [];
    }

    if (bookmarkedExamIds.length === 0) {
      return res.json({ bookmarks: [], bookmarkedExamIds: [] });
    }

    // Fetch details of bookmarked exams
    const { data: exams, error: examsErr } = await db
      .from("exams")
      .select("id, title, description, exam_type, question_mode, duration_minutes, total_marks, is_paid, price, created_at")
      .in("id", bookmarkedExamIds);

    if (examsErr) return res.status(500).json({ error: examsErr.message });

    return res.json({ bookmarks: exams || [], bookmarkedExamIds });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/student/bookmarks — save bookmark(s)
router.post("/bookmarks", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;
    const { examIds, examId } = req.body;

    const idsToBookmark = Array.isArray(examIds) ? examIds : [examId].filter(Boolean);

    if (!idsToBookmark.length) {
      return res.status(400).json({ error: "No exam IDs provided" });
    }

    // Insert into Neon
    const rows = idsToBookmark.map((id: string) => ({
      student_id: user.id,
      exam_id: id,
    }));

    await db.from("test_bookmarks").upsert(rows, { onConflict: "student_id,exam_id" });

    // Update in-memory store
    if (!inMemoryBookmarks.has(user.id)) {
      inMemoryBookmarks.set(user.id, new Set());
    }
    const studentSet = inMemoryBookmarks.get(user.id)!;
    idsToBookmark.forEach((id) => studentSet.add(id));

    return res.json({ success: true, message: "Bookmarks saved", bookmarkedExamIds: Array.from(studentSet) });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/student/bookmarks/:examId — remove bookmark
router.delete("/bookmarks/:examId", requireAuth, async (req: any, res) => {
  try {
    const user = req.user;
    const { examId } = req.params;

    // Neon delete
    await db.from("test_bookmarks").delete().eq("student_id", user.id).eq("exam_id", examId);

    // In-memory delete
    const studentSet = inMemoryBookmarks.get(user.id);
    if (studentSet) {
      studentSet.delete(examId);
    }

    return res.json({ success: true, message: "Bookmark removed" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/student/study-material — list study materials & notes
router.get("/study-material", requireAuth, async (req: any, res) => {
  try {
    const materials = [
      {
        id: "sm-1",
        title: "Complete Quantitative Aptitude Formula Sheet 2026",
        description: "Comprehensive quick-reference formula book covering Speed, Distance, Time, Profit & Loss, Percentages, and Algebra.",
        category: "Mathematics",
        file_type: "PDF",
        file_size: "3.2 MB",
        downloads: 1420,
        published_at: "2026-08-01",
        download_url: "#",
        is_featured: true,
      },
      {
        id: "sm-2",
        title: "Logical Reasoning & Analytical Puzzles Handbook",
        description: "Step-by-step solved shortcuts for seating arrangements, blood relations, syllogisms, and coding-decoding.",
        category: "Reasoning",
        file_type: "PDF",
        file_size: "4.8 MB",
        downloads: 980,
        published_at: "2026-08-05",
        download_url: "#",
        is_featured: true,
      },
      {
        id: "sm-3",
        title: "Current Affairs & Static GK Quarterly Compendium",
        description: "Handpicked national and international affairs, government schemes, awards, and sports highlights.",
        category: "General Knowledge",
        file_type: "PDF",
        file_size: "5.5 MB",
        downloads: 2150,
        published_at: "2026-08-10",
        download_url: "#",
        is_featured: false,
      },
      {
        id: "sm-4",
        title: "English Grammar Rules & Error Spotting Cheat Sheet",
        description: "100 crucial grammar rules for error detection, active-passive voice, direct-indirect speech, and sentence improvement.",
        category: "English",
        file_type: "PDF",
        file_size: "2.1 MB",
        downloads: 870,
        published_at: "2026-08-08",
        download_url: "#",
        is_featured: false,
      },
      {
        id: "sm-5",
        title: "SSC GD & State Exam Practice Paper Set (With Solutions)",
        description: "Full-length mock question papers with detailed step-by-step explanatory answers and shortcut techniques.",
        category: "Mock Papers",
        file_type: "PDF",
        file_size: "6.2 MB",
        downloads: 3100,
        published_at: "2026-08-12",
        download_url: "#",
        is_featured: true,
      },
    ];

    return res.json({ materials });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

export default router;
