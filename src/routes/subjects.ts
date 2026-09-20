import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { db, neonQuery } from "../lib/db.js";

const router = Router();

// Lazy schema migration runner to ensure tables and columns exist
let isSchemaInitialized = false;
async function ensureSchema() {
  if (isSchemaInitialized) return;
  try {
    // 1. Make exam_id nullable so subjects can exist at category/global level
    await neonQuery(`ALTER TABLE public.subjects ALTER COLUMN exam_id DROP NOT NULL;`).catch((e) => {
      console.warn("[Subjects API] Note on altering exam_id:", e.message);
    });

    // 2. Ensure subjects table has necessary columns
    await neonQuery(`
      ALTER TABLE public.subjects 
      ADD COLUMN IF NOT EXISTS description TEXT,
      ADD COLUMN IF NOT EXISTS code VARCHAR(50),
      ADD COLUMN IF NOT EXISTS category_id UUID REFERENCES public.exam_categories(id) ON DELETE SET NULL,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();
    `).catch((e) => {
      console.warn("[Subjects API] Note on adding columns to subjects:", e.message);
    });

    // 3. Ensure subject_topics table exists
    await neonQuery(`
      CREATE TABLE IF NOT EXISTS public.subject_topics (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_id UUID NOT NULL REFERENCES public.subjects(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        order_index INT DEFAULT 0,
        importance VARCHAR(50) DEFAULT 'medium',
        subtopics JSONB DEFAULT '[]'::jsonb,
        estimated_hours NUMERIC(4,1) DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `).catch((e) => {
      console.warn("[Subjects API] Note on subject_topics table:", e.message);
    });

    // 4. Ensure questions table has topic_id
    await neonQuery(`
      ALTER TABLE public.questions 
      ADD COLUMN IF NOT EXISTS topic_id UUID REFERENCES public.subject_topics(id) ON DELETE SET NULL;
    `).catch((e) => {
      console.warn("[Subjects API] Note on questions topic_id:", e.message);
    });

    isSchemaInitialized = true;
  } catch (err) {
    console.error("[Subjects API] Failed to initialize schema:", err);
  }
}

// GET /api/subjects — List all subjects with aggregated counts and category name
router.get("/", optionalAuth, async (req: any, res) => {
  try {
    await ensureSchema();

    const { category_id, q } = req.query;

    let sql = `
      SELECT 
        s.id,
        s.name,
        s.description,
        s.code,
        s.category_id,
        s.created_at,
        ec.name AS category_name,
        COUNT(DISTINCT st.id)::int AS topics_count,
        COUNT(DISTINCT q.id)::int AS questions_count
      FROM public.subjects s
      LEFT JOIN public.exam_categories ec ON s.category_id = ec.id
      LEFT JOIN public.subject_topics st ON st.subject_id = s.id
      LEFT JOIN public.questions q ON q.subject_id = s.id
      WHERE 1=1
    `;

    const params: any[] = [];
    if (category_id && category_id !== "all") {
      params.push(category_id);
      sql += ` AND s.category_id = $${params.length}`;
    }

    if (q) {
      params.push(`%${q}%`);
      sql += ` AND (s.name ILIKE $${params.length} OR s.description ILIKE $${params.length} OR s.code ILIKE $${params.length})`;
    }

    sql += ` GROUP BY s.id, ec.name ORDER BY s.name ASC;`;

    const subjects = await neonQuery(sql, params);

    // Also return list of categories for filter dropdowns
    const categories = await neonQuery(
      `SELECT id, name FROM public.exam_categories ORDER BY name ASC;`
    );

    return res.json({ subjects, categories });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch subjects" });
  }
});

// POST /api/subjects — Create new subject
router.post("/", requireAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { name, description, code, category_id } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Subject name is required" });
    }

    const sql = `
      INSERT INTO public.subjects (name, description, code, category_id)
      VALUES ($1, $2, $3, $4)
      RETURNING *;
    `;
    const rows = await neonQuery(sql, [
      name.trim(),
      description?.trim() || "",
      code?.trim() || null,
      category_id || null,
    ]);

    return res.status(201).json({ subject: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to create subject" });
  }
});

// GET /api/subjects/:id — Get subject details along with all chapters/topics
router.get("/:id", optionalAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;

    const subjectSql = `
      SELECT 
        s.id,
        s.name,
        s.description,
        s.code,
        s.category_id,
        s.created_at,
        ec.name AS category_name,
        COUNT(DISTINCT q.id)::int AS questions_count
      FROM public.subjects s
      LEFT JOIN public.exam_categories ec ON s.category_id = ec.id
      LEFT JOIN public.questions q ON q.subject_id = s.id
      WHERE s.id = $1
      GROUP BY s.id, ec.name;
    `;
    const subjectRows = await neonQuery(subjectSql, [id]);
    if (!subjectRows.length) {
      return res.status(404).json({ error: "Subject not found" });
    }

    const topicsSql = `
      SELECT *
      FROM public.subject_topics
      WHERE subject_id = $1
      ORDER BY order_index ASC, created_at ASC;
    `;
    const topics = await neonQuery(topicsSql, [id]);

    return res.json({
      subject: subjectRows[0],
      topics: topics.map((t) => ({
        ...t,
        subtopics: Array.isArray(t.subtopics) ? t.subtopics : [],
      })),
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch subject" });
  }
});

// GET /api/subjects/:id/topics — List all chapters/topics for a specific subject
router.get("/:id/topics", optionalAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const topics = await neonQuery(
      `SELECT id, subject_id, title, description, order_index, importance, subtopics, estimated_hours
       FROM public.subject_topics 
       WHERE subject_id = $1 
       ORDER BY order_index ASC, created_at ASC;`,
      [id]
    );
    return res.json({ topics: topics || [] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to fetch topics" });
  }
});

// PUT /api/subjects/:id — Update subject metadata
router.put("/:id", requireAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const { name, description, code, category_id } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Subject name is required" });
    }

    const sql = `
      UPDATE public.subjects
      SET name = $1, description = $2, code = $3, category_id = $4
      WHERE id = $5
      RETURNING *;
    `;
    const rows = await neonQuery(sql, [
      name.trim(),
      description !== undefined ? description.trim() : "",
      code !== undefined ? code.trim() || null : null,
      category_id || null,
      id,
    ]);

    if (!rows.length) {
      return res.status(404).json({ error: "Subject not found" });
    }

    return res.json({ subject: rows[0] });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to update subject" });
  }
});

// DELETE /api/subjects/:id — Delete subject
router.delete("/:id", requireAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;

    await neonQuery(`DELETE FROM public.subject_topics WHERE subject_id = $1;`, [id]);
    await neonQuery(`DELETE FROM public.subjects WHERE id = $1;`, [id]);

    return res.json({ message: "Subject deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to delete subject" });
  }
});

// POST /api/subjects/:id/topics — Add a new chapter / topic to subject
router.post("/:id/topics", requireAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const { title, description, importance, subtopics, estimated_hours, order_index } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: "Topic title is required" });
    }

    // Auto-calculate order_index if not supplied
    let order = order_index;
    if (order === undefined || order === null) {
      const maxOrder = await neonQuery(
        `SELECT COALESCE(MAX(order_index), -1) + 1 AS next_order FROM public.subject_topics WHERE subject_id = $1;`,
        [id]
      );
      order = maxOrder[0]?.next_order ?? 0;
    }

    const cleanSubtopics = Array.isArray(subtopics)
      ? subtopics.map((s: string) => s.trim()).filter(Boolean)
      : [];

    const sql = `
      INSERT INTO public.subject_topics (subject_id, title, description, importance, subtopics, estimated_hours, order_index)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
      RETURNING *;
    `;
    const rows = await neonQuery(sql, [
      id,
      title.trim(),
      description?.trim() || "",
      importance || "medium",
      JSON.stringify(cleanSubtopics),
      Number(estimated_hours) || 0,
      order,
    ]);

    return res.status(201).json({
      topic: {
        ...rows[0],
        subtopics: cleanSubtopics,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to create topic" });
  }
});

// PUT /api/subjects/:id/topics/:topicId — Update topic
router.put("/:id/topics/:topicId", requireAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { id, topicId } = req.params;
    const { title, description, importance, subtopics, estimated_hours, order_index } = req.body;

    if (!title?.trim()) {
      return res.status(400).json({ error: "Topic title is required" });
    }

    const cleanSubtopics = Array.isArray(subtopics)
      ? subtopics.map((s: string) => s.trim()).filter(Boolean)
      : [];

    const sql = `
      UPDATE public.subject_topics
      SET title = $1,
          description = $2,
          importance = $3,
          subtopics = $4::jsonb,
          estimated_hours = $5,
          order_index = COALESCE($6, order_index),
          updated_at = NOW()
      WHERE id = $7 AND subject_id = $8
      RETURNING *;
    `;
    const rows = await neonQuery(sql, [
      title.trim(),
      description !== undefined ? description.trim() : "",
      importance || "medium",
      JSON.stringify(cleanSubtopics),
      Number(estimated_hours) || 0,
      order_index !== undefined ? order_index : null,
      topicId,
      id,
    ]);

    if (!rows.length) {
      return res.status(404).json({ error: "Topic not found" });
    }

    return res.json({
      topic: {
        ...rows[0],
        subtopics: cleanSubtopics,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to update topic" });
  }
});

// DELETE /api/subjects/:id/topics/:topicId — Delete topic
router.delete("/:id/topics/:topicId", requireAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { id, topicId } = req.params;

    await neonQuery(`DELETE FROM public.subject_topics WHERE id = $1 AND subject_id = $2;`, [
      topicId,
      id,
    ]);

    return res.json({ message: "Topic deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to delete topic" });
  }
});

// POST /api/subjects/:id/topics/reorder — Reorder topics
router.post("/:id/topics/reorder", requireAuth, async (req: any, res) => {
  try {
    await ensureSchema();
    const { id } = req.params;
    const { topicIds } = req.body; // Array of topic IDs in new order

    if (!Array.isArray(topicIds)) {
      return res.status(400).json({ error: "topicIds array is required" });
    }

    for (let index = 0; index < topicIds.length; index++) {
      await neonQuery(
        `UPDATE public.subject_topics SET order_index = $1 WHERE id = $2 AND subject_id = $3;`,
        [index, topicIds[index], id]
      );
    }

    return res.json({ message: "Topics reordered successfully" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "Failed to reorder topics" });
  }
});

export default router;
