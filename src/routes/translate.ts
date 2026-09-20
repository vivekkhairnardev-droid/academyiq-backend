import { Router } from "express";
import { requireAuth, optionalAuth } from "../middleware/auth.js";
import { translateTexts } from "../lib/translate.js";
import { geminiTranslate } from "../lib/gemini-translate.js";
import { db, neonQuery } from "../lib/db.js";

const router = Router();

// POST /api/translate/questions
router.post("/questions", requireAuth, async (req: any, res) => {
  try {
    const { questionIds, language } = req.body;

    if (!questionIds?.length || !language) {
      return res.status(400).json({ error: "questionIds and language are required" });
    }

    // 1. Check cache for existing translations
    const { data: cached } = await db
      .from("question_translations")
      .select("question_id, question_text, options")
      .in("question_id", questionIds)
      .eq("language", language);

    const cachedMap: Record<string, { question_text: string; options: { text: string }[] }> = {};
    if (cached) {
      for (const c of cached) {
        cachedMap[c.question_id] = {
          question_text: c.question_text,
          options: c.options as { text: string }[],
        };
      }
    }

    // 2. Find which questions need translation
    const needTranslation = questionIds.filter((id: string) => !cachedMap[id]);

    if (needTranslation.length > 0) {
      // Fetch the original questions
      const { data: questions } = await db
        .from("questions")
        .select("id, question_text, options")
        .in("id", needTranslation);

      if (questions && questions.length > 0) {
        // Build a flat list of all texts to translate in one batch call
        const textsToTranslate: string[] = [];
        const questionMeta: { id: string; optionCount: number }[] = [];

        for (const q of questions) {
          textsToTranslate.push(q.question_text);
          const opts = (q.options as { text: string }[]) || [];
          for (const opt of opts) {
            textsToTranslate.push(opt.text);
          }
          questionMeta.push({ id: q.id, optionCount: opts.length });
        }

        try {
          // Translate all texts in one API call
          const translated = await translateTexts(textsToTranslate, language);

          // Map translated texts back to questions
          let idx = 0;
          const inserts: { question_id: string; language: string; question_text: string; options: { text: string }[] }[] = [];

          for (const meta of questionMeta) {
            const translatedQuestionText = translated[idx];
            idx++;

            const translatedOptions: { text: string }[] = [];
            for (let j = 0; j < meta.optionCount; j++) {
              translatedOptions.push({ text: translated[idx] });
              idx++;
            }

            cachedMap[meta.id] = {
              question_text: translatedQuestionText,
              options: translatedOptions,
            };

            inserts.push({
              question_id: meta.id,
              language,
              question_text: translatedQuestionText,
              options: translatedOptions,
            });
          }

          // Cache translations using Neon
          if (inserts.length > 0) {
            await db.from("question_translations").upsert(inserts, {
              onConflict: "question_id,language",
            });
          }
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : "Translation failed";
          // If translation fails, return what we have from cache + empty for the rest
          return res.json({
            translations: cachedMap,
            warning: message,
            partial: true,
          });
        }
      }
    }

    return res.json({ translations: cachedMap });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/translate/save
router.post("/save", optionalAuth, async (req: any, res) => {
  try {
    const { translations } = req.body;
    if (!translations || !Array.isArray(translations) || translations.length === 0) {
      return res.status(400).json({ error: "translations array is required" });
    }

    // Prepare rows for upsert
    const rows = translations.map((t: {
      question_id: string;
      language: string;
      question_text: string;
      options?: { text: string }[];
      correct_answer?: string;
      explanation?: string;
    }) => ({
      question_id: t.question_id,
      language: t.language,
      question_text: t.question_text,
      options: t.options || [],
      correct_answer: t.correct_answer || "",
      explanation: t.explanation || "",
    }));

    const { error } = await db
      .from("question_translations")
      .upsert(rows, { onConflict: "question_id,language" });

    if (error) {
      console.error("[Save Translation Error]", error);
      return res.status(500).json({ error: error.message });
    }

    return res.json({ saved: rows.length });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// POST /api/translate/gemini
router.post("/gemini", optionalAuth, async (req: any, res) => {
  try {
    const { texts, language } = req.body;

    if (!texts || !Array.isArray(texts) || texts.length === 0) {
      return res.status(400).json({ error: "texts array is required" });
    }

    if (!language || !["hindi", "marathi"].includes(language)) {
      return res.status(400).json({ error: 'language must be "hindi" or "marathi"' });
    }

    const translations = await geminiTranslate(texts, language);
    return res.json({ translations });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Translation failed";
    console.error("[Gemini Translate Error]", message);
    
    if (message.toLowerCase().includes("quota") || message.includes("429") || message.toLowerCase().includes("exhausted")) {
      return res.status(429).json({ 
        error: "Gemini API Daily Quota Exceeded (Free Tier limit: 20/day). Please upgrade your Gemini API key to the Pay-As-You-Go tier in Google AI Studio to remove this limit." 
      });
    }
    
    return res.status(500).json({ error: message });
  }
});

export default router;
