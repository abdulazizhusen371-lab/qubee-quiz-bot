const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

require("dotenv").config();
const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { Bot, Keyboard } = require("grammy");
const crypto = require("crypto");

const app = express();
app.use(express.json());

// Lightweight endpoint for uptime monitoring — just confirms the server is awake
app.get("/ping", (req, res) => {
  res.status(200).send("OK");
});
// Serve most files normally (like weekly-quiz.html, quiz.html, etc.)
app.use(express.static(path.join(__dirname, "public"), {
  index: false, // don't auto-serve index.html
}));

// Simple password gate specifically for admin.html
app.get("/admin.html", (req, res) => {
  const providedPassword = req.query.password;

  if (providedPassword === process.env.ADMIN_PASSWORD) {
    res.sendFile(path.join(__dirname, "public", "admin.html"));
  } else {
    res.send(`
      <html>
        <body style="font-family: Arial; text-align:center; padding-top: 100px;">
          <h2>Admin Login</h2>
          <form method="GET" action="/admin.html">
            <input type="password" name="password" placeholder="Enter admin password" style="padding:10px; font-size:16px;">
            <button type="submit" style="padding:10px 20px; font-size:16px;">Login</button>
          </form>
        </body>
      </html>
    `);
  }
});

const client = new MongoClient(process.env.MONGO_URI);
let questionsCollection;
let quizAttemptsCollection;
let currentWeekCollection;
let studentsCollection;
let channelQuizAttemptsCollection;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const upload = multer({ storage: multer.memoryStorage() });

async function connectDB() {
  await client.connect();
  const db = client.db("qubee_quiz");
  questionsCollection = db.collection("questions");
  quizAttemptsCollection = db.collection("quizAttempts");
  currentWeekCollection = db.collection("currentWeek");
  channelQuizAttemptsCollection = db.collection("channelQuizAttempts");
  studentsCollection = db.collection("students");
  console.log("Connected to MongoDB (server)");
}

// ===================== ADMIN / QUESTION API ROUTES =====================

app.post("/api/upload-image", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No image file received." });
    }
    const base64Image = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;
    const result = await cloudinary.uploader.upload(base64Image, {
      folder: "qubee_quiz_questions",
    });
    res.json({ success: true, imageUrl: result.secure_url });
  } catch (err) {
    console.error("Error uploading image:", err);
    res.status(500).json({ error: "Server error while uploading image." });
  }
});
app.post("/api/questions/cleanup-numbering", async (req, res) => {
  try {
    const allQuestions = await questionsCollection.find({}).toArray();
    let modifiedCount = 0;

    for (const q of allQuestions) {
      const cleaned = q.questionText.replace(/^\d+[\.\)]\s*/, "");
      if (cleaned !== q.questionText) {
        await questionsCollection.updateOne({ _id: q._id }, { $set: { questionText: cleaned } });
        modifiedCount++;
      }
    }

    res.json({ success: true, modifiedCount });
  } catch (err) {
    console.error("Error cleaning up numbering:", err);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/questions/save", async (req, res) => {
  try {
    const { grade, subject, unit, week, questions } = req.body;
    if (!grade || !subject || !unit || !week) {
      return res.status(400).json({ error: "Missing grade, subject, unit, or week." });
    }
    if (!questions || questions.length === 0) {
      return res.status(400).json({ error: "No questions to save." });
    }
    const documentsToInsert = questions.map((q) => ({
      grade, subject, unit, week,
      questionText: q.questionText,
      choices: q.choices,
      imageUrl: q.imageUrl || null,
      createdAt: new Date(),
    }));
    const result = await questionsCollection.insertMany(documentsToInsert);
    res.json({ success: true, insertedCount: result.insertedCount });
  } catch (err) {
    console.error("Error saving questions:", err);
    res.status(500).json({ error: "Server error while saving questions." });
  }
});

app.get("/api/questions", async (req, res) => {
  try {
    const { grade, subject, unit, week } = req.query;
    if (!grade || !subject || !unit || !week) {
      return res.status(400).json({ error: "Missing grade, subject, unit, or week." });
    }
    const questions = await questionsCollection
      .find({ grade, subject, unit, week })
      .sort({ createdAt: 1 })
      .toArray();
    res.json({ success: true, questions });
  } catch (err) {
    console.error("Error fetching questions:", err);
    res.status(500).json({ error: "Server error while fetching questions." });
  }
});

app.get("/api/quiz-questions", async (req, res) => {
  try {
    const { grade, subject, week } = req.query;
    if (!grade || !subject || !week) {
      return res.status(400).json({ error: "Missing grade, subject, or week." });
    }
    const questions = await questionsCollection
      .find({ grade, subject, week })
      .sort({ createdAt: 1 })
      .toArray();
    res.json({ success: true, questions });
  } catch (err) {
    console.error("Error fetching quiz questions:", err);
    res.status(500).json({ error: "Server error while fetching quiz questions." });
  }
});
// API endpoint: fetch all questions for a grade/subject/unit (archive view — combines all weeks)
app.get("/api/archive-questions", async (req, res) => {
  try {
    const { grade, subject, unit } = req.query;

    if (!grade || !subject || !unit) {
      return res.status(400).json({ error: "Missing grade, subject, or unit." });
    }

    const questions = await questionsCollection
      .find({ grade, subject, unit })
      .sort({ createdAt: 1 })
      .toArray();

    res.json({ success: true, questions });
  } catch (err) {
    console.error("Error fetching archive questions:", err);
    res.status(500).json({ error: "Server error while fetching archive questions." });
  }
});
// API endpoint: analytics — student counts by grade
app.get("/api/analytics/students-by-grade", async (req, res) => {
  try {
    const students = await studentsCollection.find({}).toArray();
    // Note: students collection doesn't store grade directly yet —
    // so this counts total registered students for now
    res.json({ success: true, totalStudents: students.length });
  } catch (err) {
    console.error("Error fetching student analytics:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// API endpoint: analytics — top scorers for a specific grade/subject/week
app.get("/api/analytics/top-scorers", async (req, res) => {
  try {
    const { grade, subject, week } = req.query;

    if (!grade || !subject || !week) {
      return res.status(400).json({ error: "Missing grade, subject, or week." });
    }

    const filter = { grade, week };
    if (subject !== "all") filter.subject = subject;

    const attempts = await quizAttemptsCollection
      .find(filter)
      .sort({ score: -1 })
      .limit(3)
      .toArray();

    // Look up each student's name from their telegramId
    const results = await Promise.all(
      attempts.map(async (attempt) => {
        const student = await studentsCollection.findOne({ telegramId: attempt.telegramId });
        return {
          name: student ? student.name : "Unknown",
          score: attempt.score,
          totalQuestions: attempt.totalQuestions,
        };
      })
    );

    res.json({ success: true, topScorers: results });
  } catch (err) {
    console.error("Error fetching top scorers:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// API endpoint: analytics — how many students took a specific grade/subject/week quiz
app.get("/api/analytics/attempt-count", async (req, res) => {
  try {
    const { grade, subject, week } = req.query;

    if (!grade || !subject || !week) {
      return res.status(400).json({ error: "Missing grade, subject, or week." });
    }

    const filter = { grade, week };
if (subject !== "all") filter.subject = subject;
const count = await quizAttemptsCollection.countDocuments(filter);

    res.json({ success: true, count });
  } catch (err) {
    console.error("Error fetching attempt count:", err);
    res.status(500).json({ error: "Server error." });
  }
});
// Average score for a grade/subject/week
app.get("/api/analytics/average-score", async (req, res) => {
  try {
    const { grade, subject, week } = req.query;
    if (!grade || !subject || !week) {
      return res.status(400).json({ error: "Missing grade, subject, or week." });
    }

    const filter = { grade, week };
    if (subject !== "all") filter.subject = subject;

    const attempts = await quizAttemptsCollection.find(filter).toArray();

    if (attempts.length === 0) {
      return res.json({ success: true, averagePercent: null, attemptCount: 0 });
    }

    const totalPercent = attempts.reduce((sum, a) => sum + (a.score / a.totalQuestions) * 100, 0);
    const averagePercent = totalPercent / attempts.length;

    res.json({ success: true, averagePercent: Math.round(averagePercent), attemptCount: attempts.length });
  } catch (err) {
    console.error("Error calculating average score:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Participation rate: how many registered students attempted vs total
app.get("/api/analytics/participation", async (req, res) => {
  try {
    const { grade, subject, week } = req.query;
    if (!grade || !subject || !week) {
      return res.status(400).json({ error: "Missing grade, subject, or week." });
    }

    const totalStudents = await studentsCollection.countDocuments({});

    const filter = { grade, week };
    if (subject !== "all") filter.subject = subject;
    const attemptedCount = (await quizAttemptsCollection.distinct("telegramId", filter)).length;

    res.json({ success: true, attemptedCount, totalStudents });
  } catch (err) {
    console.error("Error calculating participation:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// Per-subject breakdown: attempt counts for all 4 subjects at once, for one grade/week
app.get("/api/analytics/subject-breakdown", async (req, res) => {
  try {
    const { grade, week } = req.query;
    if (!grade || !week) {
      return res.status(400).json({ error: "Missing grade or week." });
    }

    const subjects = ["bio", "math", "chem", "phys"];
    const breakdown = {};

    for (const subject of subjects) {
      breakdown[subject] = await quizAttemptsCollection.countDocuments({ grade, subject, week });
    }

    res.json({ success: true, breakdown });
  } catch (err) {
    console.error("Error calculating subject breakdown:", err);
    res.status(500).json({ error: "Server error." });
  }
});
// API endpoint: check if a student already has an attempt for this grade/subject/week
app.get("/api/quiz-attempts/single", async (req, res) => {
  try {
    const { telegramId, grade, subject, week } = req.query;

    if (!telegramId || !grade || !subject || !week) {
      return res.status(400).json({ error: "Missing required parameters." });
    }

    const attempt = await quizAttemptsCollection.findOne({ telegramId, grade, subject, week });

    res.json({ success: true, attempt: attempt || null });
  } catch (err) {
    console.error("Error fetching single attempt:", err);
    res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/quiz-attempts", async (req, res) => {
  try {
    const { telegramId, grade, subject, week, score, totalQuestions, answers } = req.body;
    if (!telegramId || !grade || !subject || !week) {
      return res.status(400).json({ error: "Missing required attempt data." });
    }
    await quizAttemptsCollection.insertOne({
      telegramId, grade, subject, week, score, totalQuestions, answers,
      completedAt: new Date(),
    });
    res.json({ success: true });
  } catch (err) {
    console.error("Error saving quiz attempt:", err);
    res.status(500).json({ error: "Server error while saving quiz attempt." });
  }
});

app.get("/api/quiz-attempts/completed", async (req, res) => {
  try {
    const { telegramId, grade } = req.query;

    if (!telegramId || !grade) {
      return res.status(400).json({ error: "Missing telegramId or grade." });
    }

    const subjects = ["bio", "math", "chem", "phys"];
    const completedSubjects = [];

    for (const subject of subjects) {
      // Find this subject's current live week
      const currentWeekRecord = await currentWeekCollection.findOne({ grade, subject });
      const currentWeek = currentWeekRecord ? currentWeekRecord.week : "1";

      // Only count it as completed if the attempt matches THIS specific week
      const attempt = await quizAttemptsCollection.findOne({ telegramId, grade, subject, week: currentWeek });
      if (attempt) {
        completedSubjects.push(subject);
      }
    }

    res.json({ success: true, completedSubjects });
  } catch (err) {
    console.error("Error fetching completed subjects:", err);
    res.status(500).json({ error: "Server error while fetching completed subjects." });
  }
});

app.post("/api/current-week", async (req, res) => {
  try {
    const { grade, subject, week } = req.body;
    if (!grade || !subject || !week) {
      return res.status(400).json({ error: "Missing grade, subject, or week." });
    }
    await currentWeekCollection.updateOne(
      { grade, subject },
      { $set: { grade, subject, week, updatedAt: new Date() } },
      { upsert: true }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error setting current week:", err);
    res.status(500).json({ error: "Server error while setting current week." });
  }
});

app.get("/api/current-week", async (req, res) => {
  try {
    const { grade, subject } = req.query;
    if (!grade || !subject) {
      return res.status(400).json({ error: "Missing grade or subject." });
    }
    const record = await currentWeekCollection.findOne({ grade, subject });
    const week = record ? record.week : "1";
    res.json({ success: true, week });
  } catch (err) {
    console.error("Error fetching current week:", err);
    res.status(500).json({ error: "Server error while fetching current week." });
  }
});

app.get("/api/current-week-check", async (req, res) => {
  try {
    const { grade, subject, week } = req.query;
    if (!grade || !subject || !week) {
      return res.status(400).json({ error: "Missing grade, subject, or week." });
    }
    const count = await questionsCollection.countDocuments({ grade, subject, week });
    res.json({ success: true, count });
  } catch (err) {
    console.error("Error checking question count:", err);
    res.status(500).json({ error: "Server error while checking question count." });
  }
});

app.put("/api/questions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { questionText, choices } = req.body;
    if (!questionText || !choices || choices.length === 0) {
      return res.status(400).json({ error: "Question text and choices are required." });
    }
    const correctCount = choices.filter(c => c.isCorrect).length;
    if (correctCount !== 1) {
      return res.status(400).json({ error: "Exactly one choice must be marked correct." });
    }
    await questionsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { questionText, choices } }
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error updating question:", err);
    res.status(500).json({ error: "Server error while updating question." });
  }
});

app.delete("/api/questions/:id", async (req, res) => {
  try {
    const { id } = req.params;
    await questionsCollection.deleteOne({ _id: new ObjectId(id) });
    res.json({ success: true });
  } catch (err) {
    console.error("Error deleting question:", err);
    res.status(500).json({ error: "Server error while deleting question." });
  }
});
// Records a finished attempt of a quiz opened from the channel button
app.post("/api/channel-quiz/attempt", async (req, res) => {
  try {
    const { telegramId, name, username, grade, subject, unit, score, totalQuestions } = req.body;

    if (!telegramId || !grade || !subject || !unit || score === undefined || !totalQuestions) {
      return res.status(400).json({ error: "Missing required data." });
    }

    await channelQuizAttemptsCollection.insertOne({
      telegramId: String(telegramId),
      name: name || "Student",
      username: username || null,
      grade: String(grade),
      subject,
      unit: String(unit),
      score: Number(score),
      totalQuestions: Number(totalQuestions),
      completedAt: new Date(),
    });

    res.json({ success: true });
  } catch (err) {
    console.error("Error saving channel quiz attempt:", err);
    res.status(500).json({ error: "Server error." });
  }
});
// Checks that a Telegram Mini App really opened for a real Telegram user
function getTelegramUserFromInitData(initData) {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secretKey = crypto.createHmac("sha256", "WebAppData").update(process.env.BOT_TOKEN).digest();
  const computed = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (computed !== hash) return null;

  try {
    return JSON.parse(params.get("user"));
  } catch (e) {
    return null;
  }
}

// Admin-only: everyone who took a channel quiz, ranked by best score
app.get("/api/channel-quiz/participants", async (req, res) => {
  try {
    const user = getTelegramUserFromInitData(req.headers["x-telegram-init-data"]);
    const adminIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map((id) => Number(id.trim()));
    if (!user || !adminIds.includes(Number(user.id))) {
      return res.status(403).json({ error: "Admins only." });
    }

    const { grade, subject, unit } = req.query;
    if (!grade || !subject || !unit) {
      return res.status(400).json({ error: "Missing grade, subject, or unit." });
    }

    const rows = await channelQuizAttemptsCollection
      .aggregate([
        { $match: { grade, subject, unit } },
        { $sort: { completedAt: 1 } },
        {
          $group: {
            _id: "$telegramId",
            name: { $last: "$name" },
            username: { $last: "$username" },
            bestScore: { $max: "$score" },
            totalQuestions: { $last: "$totalQuestions" },
            attempts: { $sum: 1 },
            lastAttempt: { $last: "$completedAt" },
          },
        },
        { $sort: { bestScore: -1, lastAttempt: 1 } },
      ])
      .toArray();

    const participants = rows.map((r) => ({
      name: r.name,
      username: /^[A-Za-z0-9_]{3,32}$/.test(r.username || "") ? r.username : null,
      bestScore: r.bestScore,
      totalQuestions: r.totalQuestions,
      attempts: r.attempts,
      lastAttempt: r.lastAttempt,
    }));

    res.json({ success: true, participants });
  } catch (err) {
    console.error("Error fetching participants:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// ===================== TELEGRAM BOT =====================

const bot = new Bot(process.env.BOT_TOKEN);
const subjectNames = { bio: "Biology", math: "Math", chem: "Chemistry", phys: "Physics" };
const quizCodePattern = /^g(\d+)(bio|math|chem|phys)_u(\d+)$/;

function showLandingMenu(ctx) {
  const keyboard = new Keyboard()
    .text("📝 This Week's Quiz")
    .row()
    .text("📚 All Quizzes")
    .row()
    .text("🎓 Model Exams")
    .resized();

  return ctx.reply("What would you like to do?", { reply_markup: keyboard });
}

bot.command("start", async (ctx) => {
  const telegramId = ctx.from.id;
  const name = ctx.from.first_name;
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";

  const existingStudent = await studentsCollection.findOne({ telegramId });

  if (!existingStudent) {
    await studentsCollection.updateOne(
      { telegramId },
      { $set: { telegramId, name } },
      { upsert: true }
    );
    console.log(`Saved student: ${name}, ID: ${telegramId}`);
  }

  // Opened from a channel button, e.g. /start g9bio_u1
  const quizMatch = quizCodePattern.exec((ctx.match || "").trim());
  if (quizMatch) {
    const [, grade, subject, unit] = quizMatch;
    await ctx.reply(
      `📘 Grade ${grade} ${subjectNames[subject]} — Unit ${unit} Quiz\n\nTap below to start:`,
      {
        reply_markup: {
          inline_keyboard: [[
            {
              text: "📝 Start Quiz",
              web_app: { url: `${baseUrl}/archive-view.html?grade=${grade}&subject=${subject}&unit=${unit}&track=1` },
            },
          ]],
        },
      }
    );
    if (!existingStudent) await showLandingMenu(ctx);
    return;
  }

  await ctx.reply(
    existingStudent ? "Welcome back to Qubee Tutorial Quiz!" : `Welcome to Qubee Tutorial Quiz, ${name}!`
  );
  await showLandingMenu(ctx);
});

bot.hears("📝 This Week's Quiz", async (ctx) => {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  await ctx.reply("Tap below to start this week's quiz:", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "📝 Open Quiz",
            web_app: { url: `${baseUrl}/weekly-quiz.html` },
          },
        ],
      ],
    },
  });
});

bot.hears("📚 All Quizzes", async (ctx) => {
  const baseUrl = process.env.BASE_URL || "http://localhost:3000";
  await ctx.reply("Browse quizzes by grade, subject, and unit:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📚 Browse All Quizzes", web_app: { url: `${baseUrl}/archive-grade.html` } }],
      ],
    },
  });
});

bot.hears("🎓 Model Exams", async (ctx) => {
  await ctx.reply("No model exam yet.");
});
bot.command("admin", async (ctx) => {
  const telegramId = ctx.from.id;
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(id => Number(id.trim()));

  if (!adminIds.includes(telegramId)) {
    return; // silently ignore — don't reveal that an admin command exists
  }

  const baseUrl = process.env.BASE_URL || "http://localhost:3000";

  await ctx.reply("Admin tools:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "🛠 Admin Dashboard", web_app: { url: `${baseUrl}/admin.html` } }],
        [{ text: "📊 Analytics Dashboard", web_app: { url: `${baseUrl}/analytics.html` } }],
      ],
    },
  });
});
bot.command("postquiz", async (ctx) => {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(id => Number(id.trim()));
  if (!adminIds.includes(ctx.from.id)) return;

  const code = (ctx.match || "").trim();
  const parsed = quizCodePattern.exec(code);
  if (!parsed) {
    return ctx.reply("Usage: /postquiz g9bio_u1");
  }
  if (!process.env.CHANNEL_ID) {
    return ctx.reply("CHANNEL_ID is not set on the server.");
  }

  const [, grade, subject, unit] = parsed;
  try {
    await ctx.api.sendMessage(
      process.env.CHANNEL_ID,
      `📘 Grade ${grade} ${subjectNames[subject]} — Unit ${unit} Quiz\n\nTest yourself now 👇`,
      {
        reply_markup: {
          inline_keyboard: [[{ text: "📝 Qormaata Jalqabi", url: `https://t.me/${ctx.me.username}?start=${code}` }]],
        },
      }
    );
    await ctx.reply("Posted to the channel ✅");
  } catch (err) {
    console.error("postquiz failed:", err.message);
    await ctx.reply("Couldn't post to the channel. Check that the bot is a channel admin with permission to post, and that CHANNEL_ID is correct.");
  }
});
// Admin sends a poster photo to the bot with a caption like:
//   /postquiz g9bio_u1
//   (your caption text on the next lines)
bot.on("message:photo", async (ctx) => {
  const rawCaption = (ctx.message.caption || "").trim();
  const match = /^\/postquiz(?:@\w+)?\s+(\S+)\s*([\s\S]*)$/.exec(rawCaption);
  if (!match) return; // not a postquiz photo, ignore it

  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || "").split(",").map(id => Number(id.trim()));
  if (!adminIds.includes(ctx.from.id)) return;

  const code = match[1];
  const captionText = match[2].trim();

  const parsed = quizCodePattern.exec(code);
  if (!parsed) {
    return ctx.reply("Caption must start like this: /postquiz g9bio_u1");
  }
  if (!process.env.CHANNEL_ID) {
    return ctx.reply("CHANNEL_ID is not set on the server.");
  }

  const [, grade, subject, unit] = parsed;
  const finalCaption =
    captionText || `📘 Grade ${grade} ${subjectNames[subject]} — Unit ${unit} Quiz\n\nTest yourself now 👇`;

  // Telegram gives several sizes of the same photo; the last one is the largest
  const photo = ctx.message.photo[ctx.message.photo.length - 1].file_id;

  try {
    await ctx.api.sendPhoto(process.env.CHANNEL_ID, photo, {
      caption: finalCaption,
      reply_markup: {
        inline_keyboard: [[{ text: "📝 Start Quiz", url: `https://t.me/${ctx.me.username}?start=${code}` }]],
      },
    });
    await ctx.reply("Posted to the channel ✅");
  } catch (err) {
    console.error("postquiz photo failed:", err.message);
    await ctx.reply("Couldn't post to the channel. Check that the bot is a channel admin with permission to post, and that CHANNEL_ID is correct.");
  }
});
// Catch-all: responds to any other text message that isn't a recognized command/button
bot.on("message:text", async (ctx) => {
  await ctx.reply("To start the quiz, please write /start");
});

// ===================== START EVERYTHING =====================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Admin dashboard running at http://localhost:${PORT}/admin.html`);
});

connectDB()
  .then(() => {
    console.log("MongoDB connected successfully");
    bot.start();
    console.log("Bot is running...");
  })
  .catch((err) => {
    console.error("MongoDB connection failed:", err.message);
  });