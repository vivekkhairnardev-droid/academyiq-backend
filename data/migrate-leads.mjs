import https from "https";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: "../.env" });
dotenv.config({ path: "../.env.local" });

function neonQuery(queryText, params = []) {
  const connStr = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
  if (!connStr) throw new Error("DATABASE_URL is not defined");

  const matches = connStr.match(/@([^/]+)\//);
  if (!matches || !matches[1]) throw new Error("Invalid DATABASE_URL format");
  const host = matches[1];

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ query: queryText, params });
    const req = https.request(
      `https://${host}/sql`,
      {
        method: "POST",
        family: 4,
        headers: {
          "Content-Type": "application/json",
          "Neon-Connection-String": connStr,
          "Content-Length": Buffer.byteLength(postData),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = JSON.parse(body);
              resolve(json.rows);
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`Neon DB Error (${res.statusCode}): ${body}`));
          }
        });
      }
    );
    req.on("error", (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

async function migrate() {
  try {
    await neonQuery(`
      CREATE TABLE IF NOT EXISTS public.leads (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        organization TEXT,
        source TEXT DEFAULT 'manual',
        stage TEXT DEFAULT 'new',
        priority TEXT DEFAULT 'medium',
        value NUMERIC DEFAULT 0,
        notes TEXT,
        assigned_to UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
        next_follow_up TIMESTAMPTZ,
        tags TEXT[] DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ leads table created successfully");
  } catch (err) {
    console.error("❌ Failed to create leads table:", err);
    process.exit(1);
  }
}

migrate();
