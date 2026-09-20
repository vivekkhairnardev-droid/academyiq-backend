import https from "https";
import dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: "../.env" });
dotenv.config({ path: "../.env.local" });

export async function neonQuery<T = any>(queryText: string, params: any[] = []): Promise<T[]> {
  const connStr = process.env.DATABASE_URL || process.env.NEON_DATABASE_URL;
  if (!connStr) {
    throw new Error("DATABASE_URL is not defined in environment variables.");
  }

  const matches = connStr.match(/@([^/]+)\//);
  if (!matches || !matches[1]) {
    throw new Error("Invalid DATABASE_URL format.");
  }
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
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              const json = JSON.parse(body);
              resolve(json.rows as T[]);
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
