const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

require("dotenv").config();
const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const cloudinary = require("cloudinary").v2;
const multer = require("multer");
const { Bot, Keyboard } = require("grammy");

const app = express();
app.use(express.json());
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
    const attempts = await quizAttemptsCollection.find({ telegramId, grade }).toArray();
    const completedSubjects = [...new Set(attempts.map(a => a.subject))];
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

// ===================== TELEGRAM BOT =====================

const bot = new Bot(process.env.BOT_TOKEN);

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
  const existingStudent = await studentsCollection.findOne({ telegramId });

  if (existingStudent) {
    await ctx.reply(`Welcome back to Qubee Tutorial Quiz!`);
    return showLandingMenu(ctx);
  }

  const keyboard = new Keyboard()
    .requestContact("📱 Share my phone number")
    .resized();

  await ctx.reply(
    "Welcome to Qubee Tutorial Quiz!\n\nTo continue, please share your phone number.",
    { reply_markup: keyboard }
  );
});

bot.on("message:contact", async (ctx) => {
  const phoneNumber = ctx.message.contact.phone_number;
  const telegramId = ctx.from.id;
  const name = ctx.from.first_name;

  await studentsCollection.updateOne(
    { telegramId },
    { $set: { telegramId, name, phoneNumber } },
    { upsert: true }
  );

  console.log(`Saved student: ${name}, ID: ${telegramId}`);

  await ctx.reply(`Thanks ${name}! You're all set.`);
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