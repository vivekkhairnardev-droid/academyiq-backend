import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import dotenv from "dotenv";

// Load environment variables (from root .env or backend .env)
dotenv.config();
dotenv.config({ path: "../.env" });
dotenv.config({ path: "../.env.local" });

// Import routes
import authRouter from "./routes/auth.js";
import examsRouter from "./routes/exams.js";
import adminRouter from "./routes/admin.js";
import studentRouter from "./routes/student.js";
import instituteRouter from "./routes/institute.js";
import dailyTipsRouter from "./routes/dailyTips.js";
import examCategoriesRouter from "./routes/examCategories.js";
import translateRouter from "./routes/translate.js";
import subjectsRouter from "./routes/subjects.js";

const app = express();
const port = process.env.PORT || 5000;

// Configure CORS - Allow frontend to pass credentials/cookies
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  "http://127.0.0.1:3000",
  process.env.FRONTEND_URL
].filter(Boolean) as string[];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl)
      if (!origin || allowedOrigins.includes(origin) || origin.startsWith("http://localhost:")) {
        callback(null, true);
      } else {
        callback(null, true); // Fallback to true in dev, or customize
      }
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(cookieParser());

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date() });
});

// Register routers
app.use("/api/auth", authRouter);
app.use("/api/exams", examsRouter);
app.use("/api/admin", adminRouter);
app.use("/api/student", studentRouter);
app.use("/api/institute", instituteRouter);
app.use("/api/daily-tips", dailyTipsRouter);
app.use("/api/exam-categories", examCategoriesRouter);
app.use("/api/translate", translateRouter);
app.use("/api/subjects", subjectsRouter);

// Start server
app.listen(port, () => {
  console.log(`[BatchIQ Backend] Server running on http://localhost:${port}`);
});
