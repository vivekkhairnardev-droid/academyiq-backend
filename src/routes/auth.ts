import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { db, neonQuery } from "../lib/db.js";
import { JWT_SECRET, requireAuth, type AuthenticatedRequest } from "../middleware/auth.js";

const router = Router();

const SALT_ROUNDS = 10;
const TOKEN_EXPIRY = "7d";

function generateToken(user: { id: string; email: string; role: string }): string {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, JWT_SECRET, {
    expiresIn: TOKEN_EXPIRY,
  });
}

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    // Look up the user by email
    const users = await neonQuery(
      `SELECT id, email, encrypted_password, full_name FROM public.profiles WHERE email = $1 LIMIT 1;`,
      [email.toLowerCase().trim()]
    );

    if (!users || users.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const user = users[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.encrypted_password || "");
    if (!validPassword) {
      return res.status(401).json({ error: "Invalid email or password" });
    }

    // Get role
    let role = "student";
    try {
      const profiles = await neonQuery(
        `SELECT role_name FROM public.profiles_with_roles WHERE id = $1 LIMIT 1;`,
        [user.id]
      );
      if (profiles && profiles.length > 0 && profiles[0].role_name) {
        role = profiles[0].role_name;
      }
    } catch {
      // keep default role
    }

    const token = generateToken({ id: user.id, email: user.email, role });

    // Set token as cookie for browser clients
    res.cookie("access_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    return res.json({
      user: { id: user.id, email: user.email, user_metadata: { full_name: user.full_name, role } },
      session: { access_token: token },
      role,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred during login." });
  }
});

// POST /api/auth/logout
router.post("/logout", async (req, res) => {
  try {
    res.clearCookie("access_token");
    return res.json({ message: "Logged out successfully" });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred during logout." });
  }
});

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  try {
    const { email, password, fullName } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email and password are required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Check if email already exists
    const existing = await neonQuery(
      `SELECT id FROM public.profiles WHERE email = $1 LIMIT 1;`,
      [normalizedEmail]
    );

    if (existing && existing.length > 0) {
      return res.status(400).json({ error: "A user with this email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS);

    // Get the default student role_id
    let roleId: string | null = null;
    try {
      const roles = await neonQuery(
        `SELECT id FROM public.roles WHERE name = 'student' LIMIT 1;`
      );
      if (roles && roles.length > 0) {
        roleId = roles[0].id;
      }
    } catch {
      // Role table might not exist yet
    }

    // Create user profile
    const newUserId = crypto.randomUUID();
    await neonQuery(
      `INSERT INTO public.profiles (id, email, full_name, encrypted_password, role_id, created_at) 
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [newUserId, normalizedEmail, fullName || "", hashedPassword, roleId]
    );

    const token = generateToken({ id: newUserId, email: normalizedEmail, role: "student" });

    // Set token as cookie
    res.cookie("access_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({
      user: { id: newUserId, email: normalizedEmail, user_metadata: { full_name: fullName || "", role: "student" } },
      session: { access_token: token },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred during signup." });
  }
});

// POST /api/auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    // In a production app you'd send a reset email here.
    // For now, acknowledge the request.
    return res.json({ message: "If an account with that email exists, a password reset link has been sent." });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

// GET /api/auth/me — resolve the current user's role (works even for old tokens without role)
router.get("/me", requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    // Look up role from DB (in case JWT doesn't have it or it changed)
    let role = "student";
    try {
      const profiles = await neonQuery(
        `SELECT role_name FROM public.profiles_with_roles WHERE id = $1 LIMIT 1;`,
        [user.id]
      );
      if (profiles && profiles.length > 0 && profiles[0].role_name) {
        role = profiles[0].role_name;
      }
    } catch {
      // keep default role
    }

    return res.json({ id: user.id, email: user.email, role });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || "An error occurred." });
  }
});

export default router;
