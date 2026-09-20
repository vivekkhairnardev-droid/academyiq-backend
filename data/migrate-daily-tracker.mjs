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
            try { resolve(JSON.parse(body).rows); } catch (err) { reject(err); }
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
    console.log("Creating daily_calls table...");
    await neonQuery(`
      CREATE TABLE IF NOT EXISTS public.daily_calls (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        call_date DATE NOT NULL DEFAULT CURRENT_DATE,
        institute_name TEXT NOT NULL,
        person_name TEXT,
        phone TEXT NOT NULL,
        outcome TEXT DEFAULT 'interested',
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ daily_calls table created or exists");

    console.log("Creating daily_visits table...");
    await neonQuery(`
      CREATE TABLE IF NOT EXISTS public.daily_visits (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        visit_date DATE NOT NULL DEFAULT CURRENT_DATE,
        academy_name TEXT NOT NULL,
        person_name TEXT NOT NULL,
        role_title TEXT,
        phone TEXT NOT NULL,
        address TEXT NOT NULL,
        location_coords TEXT,
        selfie_url TEXT,
        outcome TEXT DEFAULT 'demo_given',
        follow_up_date DATE,
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log("✅ daily_visits table created or exists");

    // Indexes for high performance querying by date
    await neonQuery(`CREATE INDEX IF NOT EXISTS idx_daily_calls_date ON public.daily_calls(call_date);`);
    await neonQuery(`CREATE INDEX IF NOT EXISTS idx_daily_visits_date ON public.daily_visits(visit_date);`);
    console.log("✅ Indexes created");

    console.log("Migration finished successfully!");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

migrate();
