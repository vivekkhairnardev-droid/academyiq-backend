import { GoogleGenAI } from "@google/genai";

const LANG_NAMES: Record<string, string> = {
  hindi: "Hindi",
  marathi: "Marathi",
  hi: "Hindi",
  mr: "Marathi",
};

/**
 * Translate an array of text strings using Google Gemini API.
 * Returns translated strings in the same order.
 */
export async function geminiTranslate(
  texts: string[],
  targetLang: string
): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in environment variables");
  }

  if (!texts.length) return [];

  // Filter out empty strings, track their positions
  const nonEmptyIndices: number[] = [];
  const nonEmptyTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (texts[i].trim()) {
      nonEmptyIndices.push(i);
      nonEmptyTexts.push(texts[i]);
    }
  }

  if (nonEmptyTexts.length === 0) return texts.map(() => "");

  const langName = LANG_NAMES[targetLang] || targetLang;

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `You are a precise translator for educational exam content. Translate the following ${nonEmptyTexts.length} text(s) from English to ${langName}.
  
  Return a JSON array of translated strings, in the exact same order.
  Do NOT add any extra text or wrapper key. Just return a string array.

  Input texts (JSON array):
  ${JSON.stringify(nonEmptyTexts)}`;

  let lastError: any = null;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: prompt,
        config: {
          responseMimeType: "application/json",
        },
      });

      const responseText = response.text?.trim() || "";

      // Parse JSON from response
      let translated: string[];
      try {
        translated = JSON.parse(responseText);
      } catch {
        throw new Error(`Failed to parse Gemini response as JSON: ${responseText.substring(0, 200)}`);
      }

      if (!Array.isArray(translated) || translated.length !== nonEmptyTexts.length) {
        throw new Error(
          `Gemini returned ${Array.isArray(translated) ? translated.length : "non-array"} items, expected ${nonEmptyTexts.length}`
        );
      }

      // Reconstruct full array with empty strings in original positions
      const result: string[] = texts.map(() => "");
      for (let i = 0; i < nonEmptyIndices.length; i++) {
        result[nonEmptyIndices[i]] = translated[i];
      }

      return result;
    } catch (err: any) {
      lastError = err;
      console.warn(`[Gemini Translate] Attempt ${attempt} failed: ${err.message || err}`);
      if (attempt < maxRetries) {
        const delay = attempt * 800; // wait 800ms, then 1600ms
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error("Translation failed after maximum retries");
}
