import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { db } from "../lib/db.js";

const JWT_SECRET = process.env.JWT_SECRET || "batchiq-secret-key-change-in-production";

export interface AuthenticatedRequest extends Request {
  user?: any;
}

/**
 * Extract and verify JWT token from Authorization header or cookies.
 */
function extractUser(req: Request): { id: string; email: string } | null {
  let token: string | undefined;

  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7);
  }

  // Fallback to cookie
  if (!token && req.cookies?.access_token) {
    token = req.cookies.access_token;
  }

  if (!token) return null;

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { id: string; email: string };
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Middleware that requires a valid JWT token.
 * Attaches req.user with { id, email } from the token.
 */
export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const user = extractUser(req);

    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    req.user = user;
    next();
  } catch (error: any) {
    return res.status(401).json({ error: error.message || "Unauthorized" });
  }
}

/**
 * Middleware that optionally attaches user if a valid JWT is present.
 * Does NOT reject unauthenticated requests.
 */
export async function optionalAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const user = extractUser(req);
    req.user = user || null;
    next();
  } catch {
    req.user = null;
    next();
  }
}

export { JWT_SECRET };
