const GOOGLE_TRANSLATE_API_URL = "https://translation.googleapis.com/language/translate/v2";

const LANG_CODES: Record<string, string> = {
  hindi: "hi",
  marathi: "mr",
  gujarati: "gu",
  tamil: "ta",
  telugu: "te",
  kannada: "kn",
};

/**
 * Translate an array of text strings to the target language using Google Translate API.
 * Returns the translated strings in the same order.
 */
export async function translateTexts(
  texts: string[],
  targetLang: string
): Promise<string[]> {
  const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
  if (!apiKey) {
    throw new Error("GOOGLE_TRANSLATE_API_KEY is not set");
  }

  const langCode = LANG_CODES[targetLang] || targetLang;

  // Google Translate API supports batch translation via multiple 'q' params
  const res = await fetch(`${GOOGLE_TRANSLATE_API_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      q: texts,
      source: "en",
      target: langCode,
      format: "text",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google Translate API error: ${err}`);
  }

  const data = (await res.json()) as any;
  const translations = data.data.translations as { translatedText: string }[];
  return translations.map((t) => t.translatedText);
}

/**
 * Get the ISO language code for a language name
 */
export function getLangCode(langName: string): string {
  return LANG_CODES[langName] || langName;
}
