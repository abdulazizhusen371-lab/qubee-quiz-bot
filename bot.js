const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

require("dotenv").config();
const { Bot, Keyboard } = require("grammy");
const { MongoClient } = require("mongodb");

const bot = new Bot(process.env.BOT_TOKEN);

const client = new MongoClient(process.env.MONGO_URI);
let studentsCollection;

async function connectDB() {
  await client.connect();
  const db = client.db("qubee_quiz");
  studentsCollection = db.collection("students");
  console.log("Connected to MongoDB");
}

// Reusable function to show the landing page buttons
function showLandingMenu(ctx) {
  const keyboard = new Keyboard()
    .text("📝 This Week's Quiz")
    .row() // .row() moves the next button to a new line
    .text("📚 All Quizzes")
    .row()
    .text("🎓 Model Exams")
    .resized();

  return ctx.reply("What would you like to do?", { reply_markup: keyboard });
}

bot.command("start", async (ctx) => {
  const telegramId = ctx.from.id;

  // Check if this student already shared their number before
  const existingStudent = await studentsCollection.findOne({ telegramId });

  if (existingStudent) {
    // Already registered — skip straight to the menu
    await ctx.reply(`Welcome back to Qubee Tutorial Quiz!`);
    return showLandingMenu(ctx);
  }

  // New student — ask for phone number
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

// Handle each of the 3 landing page buttons
bot.hears("📝 This Week's Quiz", async (ctx) => {
  await ctx.reply("Grade selection & weekly quiz coming soon — this is where we'll build the Mini App next.");
});

bot.hears("📚 All Quizzes", async (ctx) => {
  await ctx.reply("Quiz archive coming soon.");
});

bot.hears("🎓 Model Exams", async (ctx) => {
  await ctx.reply("No model exam yet.");
});

connectDB().then(() => {
  bot.start();
  console.log("Bot is running...");
});