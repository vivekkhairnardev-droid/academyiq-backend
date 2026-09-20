import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../lib/db.js";

const router = Router();

// GET /api/daily-tips
router.get("/", requireAuth, async (req: any, res) => {
  try {
    const { data, error } = await db
      .from("daily_tips")
      .select("*")
      .order("active_date", { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ tips: data });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/daily-tips
router.post("/", requireAuth, async (req: any, res) => {
  try {
    const { tipText, activeDate } = req.body;

    if (!tipText || !activeDate) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { error } = await db
      .from("daily_tips")
      .insert({
        tip_text: tipText,
        active_date: activeDate,
        created_by: req.user.id,
      });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(201).json({ message: "Tip created successfully" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// DELETE /api/daily-tips/:id
router.delete("/:id", requireAuth, async (req: any, res) => {
  try {
    const { id } = req.params;

    const { error } = await db
      .from("daily_tips")
      .delete()
      .eq("id", id);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.json({ message: "Tip deleted successfully" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

export default router;
