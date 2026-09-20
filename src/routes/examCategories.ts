import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";

const router = Router();

// GET /api/exam-categories
router.get("/", optionalAuth, async (req: any, res) => {
  try {
    const { data: categories, error } = await db
      .from("exam_categories")
      .select("*")
      .order("name", { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ categories });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/exam-categories
router.post("/", requireAuth, async (req: any, res) => {
  try {
    const { name, description } = req.body;

    if (!name?.trim()) {
      return res.status(400).json({ error: "Category name is required" });
    }

    const { data: category, error } = await db
      .from("exam_categories")
      .insert({ name: name.trim(), description: description || "" })
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.status(201).json({ category });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// PUT /api/exam-categories/:id
router.put("/:id", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;
    const { name, description } = req.body;

    const { data: category, error } = await db
      .from("exam_categories")
      .update({ name, description: description ?? "" })
      .eq("id", id)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ category });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/exam-categories/:id
router.delete("/:id", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;

    const { error } = await db.from("exam_categories").delete().eq("id", id);
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ message: "Deleted" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

export default router;
