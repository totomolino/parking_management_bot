const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const cors = require("cors");
const ngrok = require("@ngrok/ngrok");
const fs = require("fs"); // Import fs module for logging
const path = require("path");
const { DateTime } = require("luxon"); //for date manipulation
require("dotenv").config(); // Load environment variables from .env file
const csvParser = require("csv-parser");
const { createCanvas, loadImage } = require("canvas");
const { handle } = require("express/lib/application");
const { Pool } = require("pg"); // Import the pg Pool for database connection
const res = require("express/lib/response");
const { EsimProfilePage } = require("twilio/lib/rest/supersim/v1/esimProfile");
const { all, get } = require("axios");

// Create a new pool to interact with PostgreSQL
const pool = new Pool({
  user: "postgres", // Replace with your PostgreSQL username
  host: "localhost", // Replace with your host if needed
  database: "parking_database", // Your database name
  password: "mySecurePassword123", // Your PostgreSQL password
  port: 5432, // Default PostgreSQL port
});

const filePath = "./roster.csv"; // Path to your CSV file
const holidaysFilePath = "./holidays.csv"; // Path to your CSV file
// File path for persistence
const DATA_FILE_PATH = path.join(__dirname, "parking_data.json");
const yesterday_FILE_PATH = path.join(__dirname, "parking_data_yesterday.json");
const imagePath = "original_image.jpg";
const outputPath = "modified_image.jpg";

let csvData = []; // In-memory storage for CSV data
let holidaysData = []; // In-memory storage for Holidays data
const maxRetries = 3;

// Function to read CSV file and populate csvData
async function readCSV() {
  try {
    const result = await pool.query(
      "SELECT name, phone, date_of_hire, priority FROM roster"
    );
    csvData = result.rows.map((row) => ({
      name: row.name,
      phone: row.phone,
      date_of_hire: row.date_of_hire,
      priority: row.priority,
    }));
    console.log("Roster table successfully read from database");
  } catch (error) {
    console.error("Error reading roster table from database:", error);
  }
}

readCSV();

// Get permanent slot assignments from the DB (returns data, doesn't modify parkingSlots)
async function loadPermanentSlots() {
  try {
    const result = await pool.query(`
      SELECT ps.slot_number, r.name, r.phone
      FROM permanent_slots ps
      JOIN roster r ON r.id = ps.user_id
    `);
    console.log(`Permanent slots found: ${result.rows.length} assignment(s).`);
    return result.rows;
  } catch (err) {
    console.error("Error loading permanent slots:", err);
    return [];
  }
}

// Permanent slots are loaded from DB at startup and reapplied after daily /excel-data reset.

// Configuration for image generation
const cellWidth = 70; // Width of each cell in pixels
const cellHeight = 22; // Height of each cell in pixels

// Function to modify parking slot image
async function generateParkingImage() {
  try {
    const image = await loadImage(imagePath);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(image, 0, 0);
    ctx.font = "15px Liberation Mono";
    ctx.fillStyle = "black";

    const textPositions = {};

    // First pack of slots (C3 to C11)
    parkingSlots.slice(0, 9).forEach((slot, i) => {
      const row = 4 + i;
      const position = `${2 * cellWidth + 5},${row * cellHeight - 5}`;
      textPositions[position] = slot.assignedTo || "";
    });

    // Second pack of slots (C17 to C34)
    parkingSlots.slice(9).forEach((slot, i) => {
      const row = 17 + i;
      const position = `${2 * cellWidth + 5},${row * cellHeight - 5}`;
      textPositions[position] = slot.assignedTo || "";
    });

    // Waiting list (Column H, starting from row 25)
    waitingList.forEach((person, i) => {
      if (i < 18) {
        // Limit to 18 waiting list entries
        const row = 25 + i;
        const position = `${7 * cellWidth + 5},${row * cellHeight - 5}`;
        textPositions[position] = person.name;
      }
    });

    // Draw all text positions
    for (const [position, text] of Object.entries(textPositions)) {
      const [x, y] = position.split(",").map(Number);
      ctx.fillText(text, x, y);
    }

    const buffer = canvas.toBuffer("image/jpeg");
    fs.writeFileSync(outputPath, buffer);
    return outputPath;
  } catch (error) {
    console.error("Error generating parking image:", error);
    throw error;
  }
}

// Function to write CSV data to file
function writeCSV(data, res) {
  // Add headers to CSV
  const headers = "name,phone,date_of_hire,priority\n";
  const updatedCSV =
    headers +
    data
      .map(
        (row) => `${row.name},${row.phone},${row.date_of_hire},${row.priority}`
      )
      .join("\n");
  fs.writeFile(filePath, updatedCSV, (err) => {
    if (err) {
      console.error("Error writing CSV file:", err);
      return res.status(500).json({ message: "Failed to update CSV file." });
    }
    res.status(200).json({ message: "CSV file updated successfully." });
  });
}

// Function to write CSV data to file
// function saveHolidays(data, res) {
//   // Add headers to CSV
//   const headers = "date,description\n";
//   const updatedCSV = headers + data.map((row) => `${row.date},${row.description}`).join('\n');
//   fs.writeFile(holidaysFilePath, updatedCSV, (err) => {
//     if (err) {
//       console.error("Error writing holidays CSV file:", err);
//       return res.status(500).json({ message: "Failed to update holidays CSV file." });
//     }
//     res.status(200).json({ message: "holidays CSV file updated successfully." });
//   });
// }

// Save holidays into the database
async function saveHolidays(data, res) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Clear existing holidays
    await client.query("DELETE FROM holidays");

    // Insert new holidays
    const insertPromises = data.map((row) => {
      const [day, month, year] = row.date.split("/"); // split "24/03/2025"
      const formattedDate = `${year}-${month}-${day}`; // "2025-03-24"

      return client.query(
        "INSERT INTO holidays (date, description) VALUES ($1, $2)",
        [formattedDate, row.description]
      );
    });

    await Promise.all(insertPromises);

    await client.query("COMMIT");
    res.status(200).json({ message: "Holidays updated successfully." });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Error updating holidays in DB:", err);
    res.status(500).json({ message: "Failed to update holidays." });
  } finally {
    client.release();
  }
}

const app = express();
const port = 3000; // HTTP port
const twilioNumber = "whatsapp:+12023351857";

// Middleware setup
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); // Middleware to parse JSON body
// Enable CORS for all routes
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "ngrok-skip-browser-warning"],
  })
);

// Path to the log file
const LOG_FILE = "bot_actions.log";

// Function to log actions to a text file
function logAction(userPhone, userName, action) {
  const timestamp = getLocalTime();
  const logEntry = `${timestamp}|${userPhone.replace(
    "whatsapp:",
    ""
  )}|${userName}|${action}\n`;
  fs.appendFile(LOG_FILE, logEntry, (err) => {
    if (err) {
      console.error("Error logging action:", err);
    }
  });
  logActionToDB(userPhone, action); // Log to database as well
}

// Async function to search for user ID
async function searchUserId(userPhone) {
  const query = "SELECT id FROM roster WHERE phone = $1";
  const values = [userPhone.replace("whatsapp:", "")]; // Remove "whatsapp:" prefix

  try {
    const result = await pool.query(query, values);
    if (result.rows.length > 0) {
      return result.rows[0].id;
    } else {
      return null;
    }
  } catch (err) {
    console.error("Error searching user ID:", err);
    throw err;
  }
}

// Function to save reservation to the database
async function saveReservation(userId, timestamp) {
  const query = `
    INSERT INTO reservations (user_id, reservation_timestamp)
      VALUES ($1, $2)
    ON CONFLICT (user_id, reservation_date)
    DO UPDATE SET reservation_timestamp = EXCLUDED.reservation_timestamp
    RETURNING id, user_id, reservation_timestamp;
  `;
  const values = [userId, timestamp];

  try {
    const result = await pool.query(query, values);
    return result.rows[0].id;
  } catch (err) {
    console.error("Error saving reservation:", err);
    throw err;
  }
}

// Check if user has a reservation for tomorrow, but only if assignment hasn't happened
async function hasReservation(user_id) {
  const assigned = assignmentFlag(); // Returns true if assignment is done

  if (assigned) {
    return false; // Don't allow cancel/check if the assignment has been made
  }

  const query = `
    SELECT id 
    FROM reservations 
    WHERE user_id = $1 
      AND reservation_date = CURRENT_DATE
  `;
  const values = [Number(user_id)];

  try {
    const result = await pool.query(query, values);
    return result.rows.length > 0 ? true : false;
  } catch (err) {
    console.error("Error checking reservation:", err);
    throw err;
  }
}

// Async function to log action into database
async function logActionToDB(userPhone, action) {
  try {
    const userId = await searchUserId(userPhone);
    if (!userId) {
      console.error(`User with phone ${userPhone} not found.`);
      return;
    }

    const logTime = DateTime.now()
      .setZone("America/Argentina/Buenos_Aires")
      .toISO();
    const query =
      "INSERT INTO logs (user_id, action, log_time) VALUES ($1, $2, $3)";
    const values = [userId, action, logTime];

    await pool.query(query, values);
    console.log("Logged action successfully!");
  } catch (err) {
    console.error("Error logging to DB:", err);
  }
}

// Log admin actions to admin_actions table
async function logAdminActionToDB(actionType, description, details = null) {
  try {
    const logTime = DateTime.now()
      .setZone("America/Argentina/Buenos_Aires")
      .toISO();
    const query =
      "INSERT INTO admin_actions (action_type, description, details, action_time) VALUES ($1, $2, $3, $4)";
    const values = [actionType, description, details ? JSON.stringify(details) : null, logTime];

    await pool.query(query, values);
    console.log(`[ADMIN_LOG] ${actionType}: ${description}`);
  } catch (err) {
    console.error("Error logging admin action to DB:", err);
  }
}

// Initial Parking Slots Configuration
const initialSlots = [
  // --- 4º SUB (800s) ---
  814, 815, 816, 817, 839, 840, 841, 832, 834, 835, 836, 837, 838,

  // --- 3º SUB (500s) ---
  616, 585, 586, 587, 588, 589, 590, 591, 592, 593, 594, 596, 597, 598, 569,
  570, 571, 572, 573, 574, 575, 576, 579, 580, 581, 582,
].map((slotNumber) => ({
  number: slotNumber,
  status: "available", // possible statuses: 'available', 'pending', 'assigned'
  assignedTo: null,
  phone: null,
  timeoutHandle: null, // To store the timeout reference
  timeoutDate: null,
}));

// Permanent assignments are loaded from the permanent_slots DB table at startup and reapplied after each daily reset.

// Function to load data from file
function loadParkingData() {
  if (fs.existsSync(DATA_FILE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE_PATH, "utf-8"));
      console.log("Data loaded successfully from file.");
      return data;
    } catch (error) {
      console.error("Error reading parking data file:", error);
    }
  }
  console.log("No data file found, using default values.");
  return { parkingSlots: initialSlots, waitingList: [] };
}

// Function to save data to file
function saveParkingData(filePath) {
  // Preprocess parkingSlots to handle timeoutHandle as null
  const processedParkingSlots = parkingSlots.map((slot) => ({
    ...slot,
    timeoutHandle: null, // Set timeoutHandle as null for saving
  }));

  // Create the data object
  const data = {
    parkingSlots: processedParkingSlots,
    waitingList,
    parkingDate,
  };

  // Save data to file
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    console.log("Data saved successfully to file.");
  } catch (error) {
    console.error("Failed to save data:", error);
  }
}

// Restore data on startup
// Restore parkingSlots from file to preserve slot assignment state across restarts
// Then loadPermanentSlots() will update permanent assignments from DB
const restoredData = loadParkingData();
let parkingSlots = restoredData?.parkingSlots || initialSlots.map(slot => ({...slot}));
let waitingList = restoredData?.waitingList || [];
let parkingDate =
  restoredData?.parkingDate || getLocalTime().toFormat("dd/MM/yyyy");

console.log(`[STARTUP] parkingSlots loaded: ${parkingSlots.length} slots`);
console.log(`[STARTUP] Slot numbers: ${parkingSlots.map(s => s.number).join(', ')}`);
console.log(`[STARTUP] parkingDate: ${parkingDate}`);

// Health check endpoint
app.get("/health", (_, res) => {
  res.send("OK");
});

// Wake endpoint to log the current time
app.get("/wake", (_, res) => {
  const date = new Date();
  date.setHours(date.getHours() + 3);
  console.log("Wake App Server: ", date);
  res.send("OK");
});

// Function to generate the parking slot table
function generateParkingSlotTable() {
  const parkingSlotWidth = 6; // Width for Parking Slot column
  const personWidth = 20; // Width for Person column

  // Header for parking slot table
  let table =
    "Slot".padEnd(parkingSlotWidth) +
    "| " +
    "Person".padEnd(personWidth) +
    "\n";
  table += "-".repeat(parkingSlotWidth + personWidth + 2) + "\n"; // Separator line

  // Add data rows for parking slot list
  parkingSlots.forEach((item) => {
    const parkingSlotString = item.number.toString();
    const parkingSlotPadding = parkingSlotWidth - parkingSlotString.length;
    const parkingSlot =
      " ".repeat(Math.floor(parkingSlotPadding / 2)) +
      parkingSlotString +
      " ".repeat(Math.ceil(parkingSlotPadding / 2));

    const person = item.assignedTo
      ? item.assignedTo.padEnd(personWidth)
      : "Available".padEnd(personWidth);
    table += `${parkingSlot}| ${person}\n`;
  });

  return table;
}

// Function to generate the waiting list table
function generateWaitingListTable() {
  const indexWidth = 5; // Width for index column
  const personWidth = 20; // Width for Person column

  // Header for waiting list table
  let table =
    "No.".padEnd(indexWidth) + "| " + "Person".padEnd(personWidth) + "\n";
  table += "-".repeat(indexWidth + personWidth + 2) + "\n"; // Separator line

  // Add data rows for waiting list
  waitingList.forEach((item, index) => {
    const indexString = (index + 1).toString().padEnd(indexWidth);
    const person = item.name.padEnd(personWidth);
    table += `${indexString}| ${person}\n`;
  });

  return table;
}

// Function to generate both lists in the same message
function generateFullTable() {
  const parkingTable = generateParkingSlotTable();
  const waitingTable = generateWaitingListTable();

  // Combine both tables with a separator
  return parkingTable + "\n" + "Waiting List:\n" + waitingTable;
}

// Handle incoming WhatsApp messages
app.post("/whatsapp", async (req, res) => {
  const messageBody = req.body.Body.trim().toLowerCase();
  const sender = req.body.From; // WhatsApp number
  // const name = req.body.ProfileName;

  const entry = csvData.find(
    (row) => row.phone === sender.replace("whatsapp:", "")
  ); //TODO CHANGE TO READ DB INSTEAD OF FILE.

  const name = entry ? entry.name : sender;

  // Check if the sender is not found in csvData
  const loginMessage = `*Hi! First things first, let’s get you set up with parking access and the bot* 🚗🤖

1️⃣ *Register your plate →* [https://forms.office.com/r/V8GPjRKtTY]
_Note: Access may take up to 24 hours to be activated. You will not receive a confirmation email. If your information was submitted correctly, you will be able to access the building once it is activated._

2️⃣ *Register your mobile phone with the bot →* [https://forms.office.com/r/0scGm4w6s9]
_Note: Both forms must be completed using a ZS laptop or Edge mobile with your ZS account._
Once both steps are completed, you can start booking your daily spot directly on WhatsApp. Type “*help*” to see the available commands.

🤔 *Still can’t interact with the bot?*
If you completed the first two forms and waited 2 hours but still cannot interact with the bot, we may be missing some information from you. In that case, please complete this additional form:
👉 [https://forms.office.com/r/Wtim5YsCa9]
After submitting it, wait about 2 hours and then type “*help*” again.

If you receive the instructions, it means you’re all set and can interact with the bot.
If you continue to experience issues after this, please reach out to someone from the *Support Services team!*`;
  if (!entry) {
    sendWhatsAppMessage(sender, loginMessage);
    return res.status(200).end();
  }

  // ── Location share (user shares WhatsApp location) ──────────────────────────
  if (req.body.Latitude && req.body.Longitude) {
    console.log(`[LOCATION_RECEIVED] Raw message from ${sender}:`, req.body);

    // Reject manual/pinned locations (they have Address or Label fields)
    // Only accept current/live locations (no Address/Label = live GPS)
    if (req.body.Address || req.body.Label) {
      await sendWhatsAppMessage(
        sender,
        `❌ Please share your *current live location* from your phone, not a pinned address.\n\nTap 📎 → Location → Send current location.`
      );
      return res.status(200).end();
    }

    await handleLocationCheckIn(
      sender,
      name,
      parseFloat(req.body.Latitude),
      parseFloat(req.body.Longitude)
    );
    saveParkingData(DATA_FILE_PATH);
    return res.status(200).end();
  }

  switch (true) {
    case messageBody === "checkin":
      logActionToDB(sender, "COMMAND_CHECKIN");
      // Check if user has a slot assigned before asking for location
      const assignedSlot = parkingSlots.find(
        (s) => s.phone === sender && s.status !== "available"
      );
      if (!assignedSlot) {
        await sendWhatsAppMessage(
          sender,
          `❌ You don't have a parking slot assigned for today. Please use the *add me* command to request a spot.`
        );
        break;
      }

      // Check if already checked in today (mandatory only)
      const userId = await searchUserId(sender);
      if (userId) {
        const existing = await pool.query(
          `SELECT id FROM check_ins WHERE user_id = $1 AND check_in_date = CURRENT_DATE AND check_in_type = 'mandatory'`,
          [userId]
        );
        if (existing.rows.length > 0) {
          await sendWhatsAppMessage(
            sender,
            `✅ You've already checked in for today (slot ${assignedSlot.number}).`
          );
          break;
        }
      }

      sendWhatsAppMessage(
        sender,
        null,
        'HXb62f0781132f522b6b10317ecdb7bf44'
      );
      break;
    case messageBody === "add me":
      logActionToDB(sender, "COMMAND_ADD_ME");
      handleAddMe(sender, name);
      break;
    case messageBody === "show all":
      logActionToDB(sender, "COMMAND_SHOW_ALL");
      handleShowAll(sender);
      break;
    case messageBody === "show image":
      logActionToDB(sender, "COMMAND_SHOW_IMAGE");
      handleShowImage(sender);
      break;
    case messageBody === "show parking":
      logActionToDB(sender, "COMMAND_SHOW_PARKING");
      handleShowParking(sender);
      break;
    case messageBody === "show timeouts":
      logActionToDB(sender, "COMMAND_SHOW_TIMEOUTS");
      handleShowTimeouts(sender);
      break;
    case messageBody === "show waiting list":
      logActionToDB(sender, "COMMAND_SHOW_WAITING_LIST");
      handleShowWaitingList(sender);
      break;
    case messageBody === "cancel":
      logActionToDB(sender, "COMMAND_CANCEL");
      handleCancelList(sender, name);
      break;
    case messageBody.startsWith("release"):
      logActionToDB(sender, "COMMAND_RELEASE");
      handleCancel(sender, name);
      break;
    case messageBody === "cancel reserve" ||
      messageBody === "cancel tomorrow reserve":
      logActionToDB(sender, "COMMAND_CANCEL_RESERVE");
      handleCancelReserve(sender);
      break;
    case messageBody === "accept":
      logActionToDB(sender, "COMMAND_ACCEPT");
      handleSlotAccept(sender, name);
      break;
    case messageBody === "decline":
      logActionToDB(sender, "COMMAND_DECLINE");
      handleSlotDecline(sender, name);
      break;
    case messageBody === "ping":
      logActionToDB(sender, "COMMAND_PING");
      handleSlotPing(sender, name);
      break;
    case messageBody === "reserve":
      logActionToDB(sender, "COMMAND_RESERVE");
      const { isWorkday, localTime } = await isTodayWorkday();
      if (isWorkday && localTime.hour >= 8 && localTime.hour < 17) {
        handleReserve(req.body.MessageSid, sender, name);
      } else {
        sendWhatsAppMessage(
          sender,
          `You can only reserve on workdays from 9am to 5pm. Use command "Add me" for WL.`
        );
      }
      break;
    case messageBody === "score":
      logActionToDB(sender, "COMMAND_SCORE");
      handleScore(sender); //TODO
      break;
    case messageBody === "test_new":
      // sendReminder(sender)+
      sendWhatsAppMessage(sender, loginMessage);
      break;
    case messageBody === "daycheck":
      const todaytest = (await getNextWorkday()).toString();
      sendWhatsAppMessage(
        sender,
        `Next bussines day is: ${todaytest}, today is holiday? ${await isTodayHoliday()}`
      );
      break;
    case messageBody === "help":
      const maxPermitido = await getMaxPermitido();
      const infoMessage1 = `
🚗 *License Plate Registration*
To access the parking floors, your license plate must be registered with the building.
Complete this form. _Registration may take up to 24 hours to be processed_:
👉 Register your license plate: https://forms.office.com/r/V8GPjRKtTY
📍 *Location*
ZS parking is located at *Juana Azurduy 1584*, floors *3SS and 4SS* of the building.
`;
      const infoMessage2 = `
Here’s how the parking bot works:

📅  You must request your reservation one day in advance.

🕘  The bot works on weekdays from 9am to 5pm.

📤  Assignments are sent at 5:10pm. You have 2 hours to accept or cancel — after that, your spot is released.

⏳  Waitlist users have 10 minutes to respond.

😴  The bot is inactive from 10pm to 7am due to timeout (10 minutes timeout will resume at 7 am).

🏖️  For holidays, make your request the previous business day.

❌  *Cancellations*:

🕰️  Any cancellation *after 8:00 AM* will count toward your monthly score, so please try to avoid last-minute changes whenever possible.

2️⃣  You have *${maxPermitido} free late cancellations per month*. If you go over that, your score and prioritization for the next month will be affected.
      👉 _Example: If you cancel *${
        maxPermitido + 1
      } times* in a month, you’ll lose prioritization and start the next month with only *${
        maxPermitido - 1
      } free cancellation*._
      👉 _Example: If you cancel *${
        maxPermitido + 2
      } times*, you’ll lose prioritization and start the next month with *no free cancellations*._
      
✅  Your score resets every month with good usage.

Commands:
🔹 *reserve* – book your spot
🔹 *cancel* – cancel today’s or tomorrow’s reservation
🔹 *add me* – join today’s waitlist
🔹 *show all* – see all today’s bookings
🔹 *ping* – notify shared spot users
🔹 *score* – check your current score and month cancellations.
      `;
      await sendWhatsAppMessage(sender, infoMessage1);

      await sendWhatsAppMessage(sender, infoMessage2);

      break;
    default:
      sendWhatsAppMessage(
        sender,
        "Unknown command. Please use 'Add me', 'Show all', 'Show parking', 'Show waiting list', 'Cancel', 'Accept', or 'Decline'."
      );
  }
  saveParkingData(DATA_FILE_PATH);
  res.status(200).end(); // Respond to Twilio immediately
});

function handleTestNew(sender, name) {
  sendCancelList(sender, "836");
}

async function handleScore(sender) {
  //Retrieve user ID
  const userId = await searchUserId(sender);

  //Bring Score from DB using Roster table
  const query = `
  select roster.score, coalesce(b.cancellation_count,0) as cancellations
  from roster
  left join (select * from monthly_cancellations where EXTRACT(month FROM cancellation_month) = EXTRACT(month FROM current_date) AND EXTRACT(year FROM cancellation_month) = EXTRACT(year FROM current_date)) b on roster.id = b.user_id
  where roster.id = $1;
  `;
  const values = [userId];
  try {
    const result = await pool.query(query, values);

    if (result.rows.length > 0) {
      const score = result.rows[0].score;
      const cancellations = result.rows[0].cancellations;
      const month = getLocalTime().toFormat("MMMM");
      const message = `Your score for ${month} is: ${score}.\nYou have made ${cancellations} cancellations this month.`;
      await sendWhatsAppMessage(sender, message);
    } else {
      await sendWhatsAppMessage(sender, "No score found for you.");
    }
  } catch (err) {
    console.error("Error fetching score:", err);
    await sendWhatsAppMessage(sender, "Error fetching your score.");
  }
}

async function getArgentinaTimestamp(messageSid) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  let retries = 0;
  let message = null;
  while (retries < 3) {
    try {
      message = await client.messages(messageSid).fetch();
      if (message && message.dateSent) {
        return DateTime.fromJSDate(new Date(message.dateSent))
          .setZone("America/Argentina/Buenos_Aires")
          .toFormat("yyyy-MM-dd HH:mm:ss");
      }
    } catch (err) {
      console.error(
        `Failed to get Twilio timestamp (attempt ${retries + 1}), retrying...`,
        err
      );
    }
    retries++;
    // Small delay before retrying
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log("Invalid dateSent from Twilio, using fallback.");
  return DateTime.now()
    .setZone("America/Argentina/Buenos_Aires")
    .toFormat("yyyy-MM-dd HH:mm:ss");
}

async function handleReserve(MessageSid, sender, name) {
  try {
    const timestamp = await getArgentinaTimestamp(MessageSid); // Luxon formatted timestamp
    const userId = await searchUserId(sender);

    // Save reservation
    const reservationId = await saveReservation(userId, timestamp);

    // Parse timestamp to Luxon DateTime for comparison
    const reservationTime = DateTime.fromFormat(
      timestamp,
      "yyyy-MM-dd HH:mm:ss",
      { zone: "America/Argentina/Buenos_Aires" }
    );

    let message = `Reservation submitted.`;

    // Check if time is before 9:00 AM
    if (reservationTime.hour < 9) {
      message += ` *Your reservation was made before 9:00 AM, You will get least priority.*`;
    }

    await sendWhatsAppMessage(sender, message);
  } catch (err) {
    console.error("Error handling reservation:", err);
    await sendWhatsAppMessage(
      sender,
      `Sorry ${name}, there was an issue processing your reservation.`
    );
  }
}

//TODO : ADD ORDER FUNCTION TO ASSIGN WITH ENDPOINT

// Function to get the assignments for the slots
async function getAssignments() {
  const now = getLocalTime();
  const hour = now.hour;
  let query = `SELECT * FROM today_assignments`;
  const values = [];

  try {
    if (hour >= 17 || hour < 8) {
      // Refresh the materialized view if after 17:00 Argentina time
      await pool.query(`SELECT conditional_refresh_mv('today_assignments_mv')`);
      query = `SELECT * FROM today_assignments_mv`;
    }

    const result = await pool.query(query, values);
    return result.rows;
  } catch (err) {
    console.error("Error fetching assignments:", err);
    return [];
  }
}

async function orderAssignements(res, force_flag = false) {
  let query = `SELECT conditional_refresh_mv('today_assignments_mv')`;
  if (force_flag) {
    query = `SELECT conditional_refresh_mv('today_assignments_mv', TRUE)`;
  }
  const values = [];

  try {
    const result = await pool.query(query, values);
    if (!result.rows || result.rows.length === 0) {
      res
        .status(500)
        .json({ message: "No assignments were ordered. Operation failed." });
      return [];
    }
    res.status(200).json({
      message: "Assignments ordered successfully.",
      data: result.rows,
    });
  } catch (err) {
    console.error("Error ordering the assignments:", err);
    res.status(500).json({ message: "Error ordering the assignments." });
    return [];
  }
}

//Function to get any view from db
async function getViews(view) {
  let query = `SELECT * FROM ${view}`;
  const values = [];

  try {
    const result = await pool.query(query, values);
    return result.rows;
  } catch (err) {
    console.error("Error fetching assignments:", err);
    return [];
  }
}

//Function to get any view from db
async function getQuery(query) {
  const values = [];

  try {
    const result = await pool.query(query, values);
    return result.rows;
  } catch (err) {
    console.error("Error fetching assignments:", err);
    return [];
  }
}

async function getMaxPermitido() {
  const result = await getQuery(`
    SELECT
      MAX(value)::int AS maxpermitido
    FROM parking_config
    WHERE key = 'maxPermitido'
  `);
  return result[0].maxpermitido || 0;
}

//Function to order reservations and assign slots
async function assignSlots(all_flag = false) {
  // Get assignments from DB (includes permanent + daily)
  const assignments = await getAssignments();

  // Get permanent slots info (doesn't modify parkingSlots, just returns data)
  const permanentSlots = await loadPermanentSlots();
  const permanentNames = new Set(permanentSlots.map(p => p.name));
  const permanentSlotNumbers = new Set(permanentSlots.map(p => p.slot_number));

  // Split assignments into permanent and daily
  const permanentAssignments = assignments.filter(a => permanentNames.has(a.name));
  const dailyAssignments = assignments.filter(a => !permanentNames.has(a.name));

  // Get all slot numbers, but exclude permanent slots for mapping
  const allSlotNumbers = initialSlots.map(s => s.number);
  const availableSlotNumbers = allSlotNumbers.filter(n => !permanentSlotNumbers.has(n));

  console.log(`[DEBUG] Total slots: ${allSlotNumbers.length}`);
  console.log(`[DEBUG] Permanent slots: ${permanentSlots.length}`);
  console.log(`[DEBUG] Available slots for daily: ${availableSlotNumbers.length}`);
  console.log(`[DEBUG] Total assignments from DB: ${assignments.length}`);
  console.log(`[DEBUG] Permanent assignments: ${permanentAssignments.length}`);
  console.log(`[DEBUG] Daily assignments (to be mapped): ${dailyAssignments.length}`);

  // Map permanent assignments to their permanent slots
  const mappedPermanent = permanentAssignments.map((assignment) => {
    const permSlot = permanentSlots.find(p => p.name === assignment.name);
    return all_flag
      ? { ...assignment, slot: permSlot?.slot_number ?? "WL" }
      : {
          name: assignment.name,
          phone: assignment.phone,
          slot: permSlot?.slot_number ?? "WL",
        };
  });

  // Map daily assignments to available slots by index (skip permanent slots)
  const mappedDaily = dailyAssignments.map((assignment, index) => {
    return all_flag
      ? { ...assignment, slot: availableSlotNumbers[index] ?? "WL" }
      : {
          name: assignment.name,
          phone: assignment.phone,
          slot: availableSlotNumbers[index] ?? "WL",
        };
  });

  // Return both permanent and daily assignments combined
  return [...mappedPermanent, ...mappedDaily];
}

function getLocalTime() {
  // Get current time in Buenos Aires timezone
  const localTime = DateTime.now().setZone("America/Argentina/Buenos_Aires");
  return localTime;
}

function calculateTimeoutDuration(timeoutDuration) {
  const localTime = getLocalTime(); // Luxon DateTime

  let finalDelay = timeoutDuration;

  const currentHour = localTime.hour;

  if (currentHour >= 22 || currentHour < 7) {
    let nextDay7am = localTime;
    // Set time to 7:10 AM
    nextDay7am = nextDay7am.set({
      hour: 7,
      minute: 10,
      second: 0,
      millisecond: 0,
    });

    // If it's after 10 PM, move to the next day
    if (currentHour >= 22) {
      nextDay7am = nextDay7am.plus({ days: 1 });
    }

    // Calculate the delay
    finalDelay = nextDay7am.toMillis() - localTime.toMillis();
  }

  // console.log(`Current Time: ${localTime.toISO()}`);
  // console.log(`Next 7:10 AM: ${localTime.set({ hour: 7, minute: 10 }).toISO()}`);
  // console.log(`Overnight Delay: ${finalDelay}`);

  return finalDelay;
}

// Generic function to assign a slot to a user with a timeout
function assignSlotToUser(
  slot,
  user,
  timeoutDuration,
  message = `A parking slot is available!\nPlease confirm in the next 10 minutes if you want parking slot *${slot.number}*.`
) {
  slot.status = "pending";
  slot.assignedTo = `${user.name} (Pending)`;
  slot.phone = user.phone;

  // Notify the user with interactive buttons
  if (message === "BS") {
    sendMessageWithButtonsFromBusiness(user.phone, slot);
  } else {
    sendMessageWithButtons(user.phone, slot);
  }

  // Calculate adjusted timeout duration
  const adjustedTimeout = calculateTimeoutDuration(timeoutDuration);

  // Save the timeout date as a string in ISO format using Luxon
  const localTime = getLocalTime(); // Get Luxon DateTime object
  const timeoutDate = localTime.plus({ milliseconds: adjustedTimeout }); // Adjust the time with the calculated delay
  slot.timeoutDate = timeoutDate.toISO(); // Save as ISO string

  // Set up the timeout
  slot.timeoutHandle = setTimeout(() => {
    // Check if the slot is still pending
    if (slot.status === "pending" && slot.phone === user.phone) {
      // console.log(
      //   `User ${user.phone} did not respond in time. Releasing slot ${slot.number}.`
      // );
      logActionToDB(user.phone, `Timeout for slot ${slot.number}`);

      // Release the slot
      slot.status = "available";
      slot.assignedTo = null;
      slot.phone = null;
      slot.timeoutHandle = null;
      slot.timeoutDate = null;

      // Notify the user about timeout (optional)
      sendTimeoutMessage(user.phone, slot);

      // Assign to the next user in the waiting list
      assignNextSlot();
    }
    // console.log(slot);
  }, adjustedTimeout);
}

// Function to assign the next available slot to the first person in the waiting list
function assignNextSlot(timeoutDuration = 10 * 60 * 1000) {
  // Default 10 minutes
  if (waitingList.length === 0) return;

  // Find the first available slot
  const availableSlot = parkingSlots.find(
    (slot) => slot.status === "available"
  );
  if (!availableSlot) {
    console.log("No available slots at the moment.");
    return;
  }

  // Assign the slot to the first person in the waiting list
  const nextPerson = waitingList[0];
  waitingList.splice(0, 1); // Remove the first from waiting list

  logActionToDB(
    nextPerson.phone,
    `The slot ${availableSlot.number} was free and given to first on WL`
  );

  assignSlotToUser(availableSlot, nextPerson, timeoutDuration);
}

// Function to handle the 'add me' command
function handleAddMe(sender, name) {
  const userInSlots = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status !== "available"
  );
  const userInWaiting = waitingList.find((user) => user.phone === sender);

  if (userInSlots) {
    const slot = parkingSlots.find((slot) => slot.phone === sender);
    sendWhatsAppMessage(
      sender,
      `You already have parking slot ${slot.number}.`
    );
    logActionToDB(
      sender,
      `Attempted to add but already has slot ${slot.number}`
    );
    return;
  }

  if (userInWaiting) {
    sendWhatsAppMessage(
      sender,
      `You're already on the waiting list at position ${
        waitingList.indexOf(userInWaiting) + 1
      }.`
    );
    logActionToDB(
      sender,
      `Attempted to add but already on waiting list at position ${
        waitingList.indexOf(userInWaiting) + 1
      }`
    );
    return;
  }

  // Check for available slot
  const availableSlot = parkingSlots.find(
    (slot) => slot.status === "available"
  );
  if (availableSlot) {
    // Assign slot with 10 minutes timeout
    assignSlotToUser(
      availableSlot,
      { name, phone: sender },
      10 * 60 * 1000 // 10 minutes in milliseconds
    );
    logActionToDB(sender, `Added and assigned slot ${availableSlot.number}`);
  } else {
    // Add to waiting list
    waitingList.push({ name, phone: sender });
    sendWhatsAppMessage(
      sender,
      "No available parking slots at the moment. You've been added to the waiting list."
    );
    logActionToDB(sender, `Added to waiting list`);

    // Optionally notify the next slot availability
    assignNextSlot();
  }
}

function handleShowImage(sender) {
  sendParkingImage(sender);
}

// Function to handle the 'show all' command
async function handleShowAll(sender) {
  await handleShowParking(sender);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await handleShowWaitingList(sender);
}

// Function to handle the 'show parking' command
async function handleShowParking(sender) {
  const userInSlots = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status !== "available"
  );
  const userInWaiting = waitingList.find((user) => user.phone === sender);

  let message = `Valid for date ${parkingDate}\n`;

  if (userInSlots) {
    const slot = parkingSlots.find((slot) => slot.phone === sender);
    message += `You are assigned to parking slot ${slot.number}.\n`;
  }

  if (userInWaiting) {
    message += `You are on the waiting list at position ${
      waitingList.indexOf(userInWaiting) + 1
    }.\n`;
  }

  if (!userInSlots && !userInWaiting) {
    message +=
      "You are neither assigned a parking slot nor on the waiting list.";
  }

  message += `\n${generateParkingSlotTable()}`;

  await sendWhatsAppMessage(sender, message);
}

// Function to handle the 'show parking' command
function handleShowTimeouts(sender) {
  let message = `Valid for date ${parkingDate}\nSlot|Person|Timeout\n`;
  message += "-------------------\n";

  parkingSlots.forEach((item) => {
    const slot = item.number.toString();
    const person = item.assignedTo || "Available";
    const timeoutHandle = item.timeoutHandle
      ? `${Math.ceil(
          (item.timeoutHandle._idleStart +
            item.timeoutHandle._idleTimeout -
            Date.now()) /
            60000
        )} minutes`
      : "N/A";

    message += `${slot}|${person}|${timeoutHandle}\n`;
  });

  // Truncate message if it exceeds 1600 characters
  if (message.length > 1600) {
    message = message.slice(0, 1597) + "...";
  }

  sendWhatsAppMessage(sender, message);
}

// Function to handle the 'show waiting list' command
async function handleShowWaitingList(sender) {
  const userInWaiting = waitingList.find((user) => user.phone === sender);

  let message = `Valid for date ${parkingDate}\n`;

  if (userInWaiting) {
    message += `You are on the waiting list at position ${
      waitingList.indexOf(userInWaiting) + 1
    }.\n`;
  } else {
    message += "You are not on the waiting list.\n";
  }

  message += `\n${generateWaitingListTable()}`;

  await sendWhatsAppMessage(sender, message);
}

//Return the slot if the user has a assigned slot
function userHasSlot(sender) {
  return parkingSlots.find(
    (slot) => slot.phone === sender && slot.status !== "available"
  );
}

//Returns the index of the the user is in the waiting list
function userHasWL(sender) {
  return waitingList.findIndex((user) => user.phone === sender);
}

async function handleCancelList(sender) {
  //Check if the user has a reservation or a slot/waiting list
  const user_id = await searchUserId(sender);
  const reservationFlag = await hasReservation(user_id);
  const userInWaitingIndex = userHasWL(sender);
  const userInSlots = userHasSlot(sender);

  let messageNum = "0";
  if (userInSlots) {
    const slot = parkingSlots.find((slot) => slot.phone === sender);
    messageNum = `slot ${slot.number}`;
  } else if (userInWaitingIndex > -1) {
    messageNum = `WL ${userInWaitingIndex + 1}`;
  }

  // If the user has a reservation and has a slot/waiting list, cancel the reservation
  if (reservationFlag && (userInSlots || userInWaitingIndex > -1)) {
    sendCancelList(sender, messageNum);
  } else if (reservationFlag) {
    sendCancelReservation(sender);
  } else if (userInSlots || userInWaitingIndex > -1) {
    sendReleaseSlotWL(sender, messageNum);
  } else {
    sendWhatsAppMessage(
      sender,
      "You're neither on the waiting list nor assigned to any parking slot nor reserved for tomorrow."
    );
  }
}

// Function to handle the 'cancel' command
function handleCancel(sender, name) {
  const userInWaitingIndex = waitingList.findIndex(
    (user) => user.phone === sender
  );
  const userInSlots = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status !== "available"
  );

  if (userInWaitingIndex > -1) {
    waitingList.splice(userInWaitingIndex, 1);
    sendWhatsAppMessage(sender, "You've been removed from the waiting list.");
    logActionToDB(
      sender,
      `Canceled and removed from waiting list at position ${
        userInWaitingIndex + 1
      }`
    );
    assignNextSlot();
    return;
  }

  if (userInSlots) {
    const slot = parkingSlots.find((slot) => slot.phone === sender);

    // Clear the timeout if it's pending
    if (slot.timeoutHandle) {
      clearTimeout(slot.timeoutHandle);
      slot.timeoutHandle = null;
    }

    slot.status = "available";
    slot.assignedTo = null;
    slot.phone = null;
    slot.timeoutDate = null;
    sendWhatsAppMessage(sender, `You've released parking slot ${slot.number}.`);
    logActionToDB(sender, `Released_slot_${slot.number}`);
    assignNextSlot();
    return;
  }

  sendWhatsAppMessage(
    sender,
    "You're neither on the waiting list nor assigned to any parking slot."
  );
  logActionToDB(
    sender,
    `Attempted to cancel but not found in slots or waiting list`
  );
}

// Function to handle the 'cancel tomorrow reserve' command
async function handleCancelReserve(sender) {
  const userId = await searchUserId(sender);
  const reservationFlag = await hasReservation(userId);
  if (reservationFlag) {
    // Cancel the reservation in the database
    const query = `
      DELETE FROM reservations 
      WHERE user_id = $1 
        AND reservation_date = CURRENT_DATE
    `;
    const values = [Number(userId)];
    pool.query(query, values, (err, result) => {
      if (err) {
        console.error("Error canceling reservation:", err);
        sendWhatsAppMessage(sender, "Failed to cancel your reservation.");
      } else {
        sendWhatsAppMessage(sender, "Your reservation has been canceled.");
        logActionToDB(sender, `Canceled reservation`);
      }
    });
  } else {
    sendWhatsAppMessage(sender, "You don't have a reservation for tomorrow.");
    logActionToDB(sender, `Attempted to cancel but no reservation found`);
  }
}

// Function to handle acceptance of a parking slot
function handleSlotAccept(sender, name) {
  const slot = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status === "pending"
  );

  if (slot) {
    // Clear the timeout as the user has responded
    if (slot.timeoutHandle) {
      clearTimeout(slot.timeoutHandle);
      slot.timeoutHandle = null;
    }

    slot.status = "assigned";
    slot.assignedTo = slot.assignedTo.replace(" (Pending)", "") || name; //Assign name only if it's empty (waiting list)
    slot.timeoutDate = null;
    sendWhatsAppMessage(
      sender,
      `Congratulations! You've been assigned parking slot ${slot.number} for ${parkingDate}.`
    );
    waitingList = waitingList.filter((user) => user.phone !== sender);
    logActionToDB(sender, `Accepted and assigned slot ${slot.number}`);

    // Optionally, assign another slot if available
    assignNextSlot();
  } else {
    sendWhatsAppMessage(sender, "You don't have any pending slot assignments.");
    logActionToDB(sender, `Attempted to accept but no pending assignments`);
  }
}

// Function to handle declination of a parking slot
function handleSlotDecline(sender, name) {
  const slot = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status === "pending"
  );

  if (slot) {
    // Clear the timeout as the user has responded
    if (slot.timeoutHandle) {
      clearTimeout(slot.timeoutHandle);
      slot.timeoutHandle = null;
    }

    slot.status = "available";
    slot.assignedTo = null;
    slot.phone = null;
    slot.timeoutDate = null;
    sendWhatsAppMessage(
      sender,
      `You've declined parking slot ${slot.number}. The slot is now available for others.`
    );
    logActionToDB(sender, `Declined slot ${slot.number}`);
    assignNextSlot();
  } else {
    sendWhatsAppMessage(
      sender,
      "You don't have any pending slot assignments to decline."
    );
    logActionToDB(sender, `Attempted to decline but no pending assignments`);
  }
}

// Function to check if new assignment ran
function assignmentFlag() {
  const localTime = getLocalTime().toFormat("dd/MM/yyyy");

  return localTime !== parkingDate; //if they are the same, it means that /excel-data didn't run yet
}

// Function to handle ping to shared parking slots
function handleSlotPing(sender, name) {
  const localTime = getLocalTime().toFormat("dd/MM/yyyy");

  let slots = parkingSlots;

  const runFlag = assignmentFlag();

  if (runFlag) {
    //if they are the same, it means that /excel-data didn't run yet
    if (fs.existsSync(yesterday_FILE_PATH)) {
      try {
        const data = JSON.parse(fs.readFileSync(yesterday_FILE_PATH, "utf-8"));

        slots = data?.parkingSlots;
      } catch (error) {
        console.error("Error reading parking data file:", error);
      }
    }
  }

  const slot = slots.find(
    (slot) => slot.phone === sender && slot.status === "assigned"
  );

  if (slot) {
    // List of shared slots
    const sharedSlots = [
      569, 570, 571, 572, 573, 574, 575, 576, 579, 580, 581, 582,
    ];

    if (sharedSlots.includes(slot.number)) {
      // Determine the paired slot
      const pairSlotNumber =
        slot.number % 2 === 0 ? slot.number - 1 : slot.number + 1;

      const pairSlot = slots.find((slot) => slot.number === pairSlotNumber);

      sendWhatsAppMessage(
        sender,
        `We've notified ${pairSlot.assignedTo} to move their car.`
      );

      pingPair((to = pairSlot.phone), slot.assignedTo, slot.number);
      logActionToDB(
        sender,
        `Checked shared slot ${slot.number} (Pair: ${pairSlotNumber})`
      );
    } else {
      sendWhatsAppMessage(
        sender,
        `You are in slot ${slot.number}, which is not a shared slot.`
      );
      logActionToDB(sender, `Checked non-shared slot ${slot.number}`);
    }
  } else {
    sendWhatsAppMessage(sender, "You don't have any slot assigned.");
    logActionToDB(sender, "Attempted to check slot but has no assignment.");
  }
}

// Endpoint to configure parking slots via POST request
app.post("/test", (req, res) => {
  const receivedSlots = req.body;

  // Validate the input
  if (!Array.isArray(receivedSlots)) {
    return res
      .status(400)
      .json({ message: "Invalid input: expected an array of slot numbers" });
  }
  return res.status(200).json({ message: receivedSlots });
});

// Endpoint to refresh logs on excel
app.post("/refresh_logs", (req, res) => {
  const lineParam = req.body.line;

  if (!lineParam || isNaN(lineParam)) {
    return res
      .status(400)
      .json({ error: 'Missing or invalid "line" parameter' });
  }

  const startLine = parseInt(lineParam, 10);
  const filePath = path.join(__dirname, LOG_FILE);

  try {
    const allLines = fs.readFileSync(filePath, "utf8").split("\n");

    const totalLines = allLines.length;

    // Remove trailing blank line at end if present
    while (allLines.length && allLines[allLines.length - 1].trim() === "") {
      allLines.pop();
    }

    const validTotal = allLines.length;

    if (startLine >= validTotal) {
      return res.json({ newLines: [], nextLineNumber: validTotal });
    }

    const newLines = allLines
      .slice(startLine)
      .map((line, idx) => `${startLine + idx + 1}|${line}`);

    res.json({
      newLines,
      nextLineNumber: validTotal,
    });
  } catch (err) {
    res.status(500).json({ error: "Error reading the log file" });
  }
});

// Endpoint to configure parking slots via POST request
app.post("/parking_slots", (req, res) => {
  const receivedSlots = req.body;

  // Validate the input
  if (!Array.isArray(receivedSlots)) {
    return res
      .status(400)
      .json({ message: "Invalid input: expected an array of slot numbers" });
  }

  // Clear all existing timeouts
  parkingSlots.forEach((slot) => {
    if (slot.timeoutHandle) {
      clearTimeout(slot.timeoutHandle);
      slot.timeoutHandle = null;
    }
  });

  // Reset parking slots based on received data
  parkingSlots = receivedSlots.map((slotNumber) => ({
    number: slotNumber,
    status: "available",
    assignedTo: null,
    phone: null,
    timeoutHandle: null,
    timeoutDate: null,
  }));

  waitingList = []; // Reset waiting list

  console.log("The parking slots have been reset: ", parkingSlots);
  logActionToDB(
    "SYSTEM",
    "Parking slots have been reset via /parking_slots endpoint"
  );

  res.status(200).send("Parking slots have been reset successfully.");
});

// Read holiday dates from CSV
// function getHolidays() {
//   const filePath = path.resolve(holidaysFilePath);
//   const data = fs.readFileSync(filePath, 'utf8');
//   const lines = data.split('\n').slice(1); // Skip header
//   const holidays = lines.map(line => line.split(',')[0].trim()); // Extract dates
//   return new Set(holidays);
// }

// Read holidays from the database
async function getHolidays() {
  try {
    const result = await pool.query("SELECT date FROM holidays");
    const holidays = result.rows.map((row) => {
      return DateTime.fromJSDate(row.date).toFormat("dd/MM/yyyy");
    });
    return new Set(holidays);
  } catch (err) {
    console.error("Error fetching holidays from DB:", err);
    throw err;
  }
}

async function getNextWorkday() {
  const localTime = getLocalTime();
  let nextDay = localTime.plus({ days: 1 }); // Start from the next day

  const holidays = await getHolidays();

  while (
    nextDay.isWeekend ||
    holidays.has(nextDay.toFormat("dd/MM/yyyy")) // Check if it's a holiday
  ) {
    nextDay = nextDay.plus({ days: 1 }); // Move to the next day
  }

  return nextDay.toFormat("dd/MM/yyyy");
}

async function isTodayHoliday() {
  const today = getLocalTime().toFormat("dd/MM/yyyy");
  const holidays = await getHolidays();
  return holidays.has(today);
}

async function isTodayWorkday() {
  const localTime = getLocalTime();
  const isHoliday = await isTodayHoliday();

  const isWorkday =
    localTime.weekday !== 6 && localTime.weekday !== 0 && !isHoliday;

  return { isWorkday, localTime };
}

//Function to assign slots and comunicate
async function assignSlotsAndCommunicate(res) {
  let todayBool = false;
  try {
    todayBool = await isTodayHoliday();
  } catch (error) {
    console.error("Error checking if today is a holiday:", error);
    return res.status(500).send("Failed to check holiday status.");
  }
  if (!todayBool) {
    // Try up to 3 times to get non-empty assignments
    let receivedData = [];
    let attempts = 0;
    while (attempts < 3) {
      receivedData = await assignSlots(false);
      console.log("Assignments from db:", receivedData);
      if (Array.isArray(receivedData) && receivedData.length > 0) break;
      await orderAssignements(res, true); // Force refresh the assignments
      attempts++;
    }
    if (!Array.isArray(receivedData) || receivedData.length === 0) {
      return res.status(500).send("No assignments found. Aborting process.");
    }

    saveParkingData(yesterday_FILE_PATH); //saving today's file

    // Create a new Date object based on localTime and add one day
    parkingDate = await getNextWorkday(); //changing the date to tomorrow since new assignations are placed

    // Clear all existing timeouts and reset slots
    parkingSlots.forEach((slot) => {
      if (slot.timeoutHandle) {
        clearTimeout(slot.timeoutHandle);
        slot.timeoutHandle = null;
      }
      slot.status = "available";
      slot.assignedTo = null;
      slot.phone = null;
      slot.timeoutDate = null;
    });

    // Apply permanent slots from DB
    const permanentSlots = await loadPermanentSlots();
    permanentSlots.forEach((perm) => {
      const slot = parkingSlots.find((s) => s.number === perm.slot_number);
      if (slot) {
        slot.status = "assigned";
        slot.assignedTo = perm.name;
        slot.phone = `whatsapp:${perm.phone}`;
      }
    });

    waitingList = [];

    receivedData.forEach((item) => {
      const person = item.name;
      const slotNumber = item.slot === "WL" ? null : parseInt(item.slot, 10);
      const phone = `whatsapp:${item.phone}`;

      if (item.slot === "WL") {
        waitingList.push({ name: person, phone });
        console.log(`${person} is in the waiting list.`);
        logActionToDB(phone, "Added to waiting list via /excel-data");
      } else if (slotNumber) {
        const slot = parkingSlots.find((s) => s.number === slotNumber);
        // Only assign if slot is available (not a permanent slot)
        if (slot && slot.status === "available") {
          slot.status = "pending";
          slot.assignedTo = person;
          slot.phone = phone;
          console.log(`${person} has parking slot ${slot.number}.`);
          logActionToDB(phone, `Assigned slot ${slot.number} via /excel-data`);

          // Notify the assigned user with a 2-hour timeout
          assignSlotToUser(
            slot,
            { name: person, phone },
            2 * 60 * 60 * 1000, // 2 hours in milliseconds
            "BS"
          );
        }
      }
    });

    // Notify the next person in the waiting list
    assignNextSlot();

    // Create message for the waiting list
    if (waitingList.length > 0) {
      // Create a personalized message for each member in the waiting list
      waitingList.forEach((member, i) => {
        // Create a message that only contains the position of the member on the waiting list
        const waitingListMessage = `${i + 1}`;

        // Send a WhatsApp message to each waiting list member with their order
        sendWaitingListMessage(member.phone, waitingListMessage);
        logActionToDB(
          member.phone,
          `Notified waiting list position ${i + 1} via /excel-data`
        );
      });
    }
    saveParkingData(DATA_FILE_PATH);
    res.status(200).send("Excel data processed successfully.");
  } else {
    res.status(200).send("Skipping day, today is holiday");
  }
}

//Endpoint to assign slots and comunicate
app.post("/assign-slots", async (req, res) => {
  await assignSlotsAndCommunicate(res);
});

//Endpoint to order the assignements
app.post("/order-assignements", async (req, res) => {
  await orderAssignements(res);
});

//Endpoint to order the assignements
app.post("/send-reminder", async (req, res) => {
  try {
    const todayBool = await isTodayHoliday();

    if (todayBool) {
      return res
        .status(200)
        .json({ message: "Today is a holiday. No reminders sent." });
    }

    // Only send reminders to assigned slots that have a phone number
    const assignedSlots = parkingSlots
      .filter((slot) => slot.status === "assigned" && slot.phone)
      .map((slot) => ({ phone: slot.phone, number: slot.number }));

    if (assignedSlots.length === 0) {
      return res
        .status(200)
        .json({ message: "No assigned slots to send reminders." });
    }

    // Send reminders in parallel, passing both phone and slot number
    await Promise.all(
      assignedSlots.map(({ phone, number }) => sendReminder(phone, number))
    );

    res
      .status(200)
      .json({ message: `Reminders sent to ${assignedSlots.length} users.` });
  } catch (error) {
    console.error("Error sending reminders:", error);
    res.status(500).json({ message: "Failed to send reminders." });
  }
});

// Endpoint to receive data from Excel macro
app.post("/excel-data", async (req, res) => {
  const todayBool = await isTodayHoliday();
  if (!todayBool) {
    const receivedData = req.body;

    saveParkingData(yesterday_FILE_PATH); //saving today's file

    // Create a new Date object based on localTime and add one day
    parkingDate = await getNextWorkday(); //changing the date to tomorrow since new assignations are placed

    // Reset all slots to available
    parkingSlots.forEach((slot) => {
      if (slot.timeoutHandle) {
        clearTimeout(slot.timeoutHandle);
        slot.timeoutHandle = null;
      }
      slot.status = "available";
      slot.assignedTo = null;
      slot.phone = null;
      slot.timeoutDate = null;
    });

    // Apply permanent slots from DB
    const permanentSlots = await loadPermanentSlots();
    permanentSlots.forEach((perm) => {
      const slot = parkingSlots.find((s) => s.number === perm.slot_number);
      if (slot) {
        slot.status = "assigned";
        slot.assignedTo = perm.name;
        slot.phone = `whatsapp:${perm.phone}`;
      }
    });

    waitingList = [];

    receivedData.forEach((item) => {
      const person = item.Person;
      const slotNumber =
        item.Parking_slot === "WL" ? null : parseInt(item.Parking_slot, 10);
      const phone = `whatsapp:${item.Number}`;

      if (item.Parking_slot === "WL") {
        waitingList.push({ name: person, phone });
        console.log(`${person} is in the waiting list.`);
        logActionToDB(phone, "Added to waiting list via /excel-data");
      } else if (slotNumber) {
        const slot = parkingSlots.find((s) => s.number === slotNumber);
        if (slot && slot.status === "available") {
          // Skip slots already taken by a permanent assignment
          slot.status = "pending";
          slot.assignedTo = person;
          slot.phone = phone;
          console.log(`${person} has parking slot ${slot.number}.`);
          logActionToDB(phone, `Assigned slot ${slot.number} via /excel-data`);

          // Notify the assigned user with a 2-hour timeout
          assignSlotToUser(
            slot,
            { name: person, phone },
            2 * 60 * 60 * 1000, // 2 hours in milliseconds
            "BS"
          );
        }
      }
    });

    // Notify the next person in the waiting list
    assignNextSlot();

    // Create message for the waiting list
    if (waitingList.length > 0) {
      // Create a personalized message for each member in the waiting list
      waitingList.forEach((member, i) => {
        // Create a message that only contains the position of the member on the waiting list
        const waitingListMessage = `${i + 1}`;

        // Send a WhatsApp message to each waiting list member with their order
        sendWaitingListMessage(member.phone, waitingListMessage);
        logActionToDB(
          member.phone,
          `Notified waiting list position ${i + 1} via /excel-data`
        );
      });
    }
    saveParkingData(DATA_FILE_PATH);
    res.status(200).send("Excel data processed successfully.");
  } else {
    res.status(200).send("Skipping day, today is holiday");
  }
});

async function writeTable(users, res) {
  try {
    // Loop through each user and insert into the database
    for (const user of users) {
      const { name, phone, date_of_hire, priority, zs_id } = user;

      // Insert query to add the user into the "roster" table
      const query = `
        INSERT INTO roster (name, phone, date_of_hire, priority, zs_id)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (name) DO UPDATE 
        SET phone = EXCLUDED.phone, 
            date_of_hire = EXCLUDED.date_of_hire,
            priority = EXCLUDED.priority,
			zs_id = EXCLUDED.zs_id;
      `;

      // Execute the query
      await pool.query(query, [name, phone, date_of_hire, priority, zs_id]);
    }

    // Respond with a success message
    return res.status(200).json({ message: "Roster updated successfully." });
  } catch (error) {
    console.error("Error updating roster:", error);
    return res
      .status(500)
      .json({ message: "Failed to update roster.", error: error.message });
  }
}

// Add new endpoint to get parking image
app.get("/parking-image", async (req, res) => {
  try {
    await generateParkingImage();
    res.sendFile(outputPath, { root: __dirname });
  } catch (error) {
    console.error("Error serving parking image:", error);
    res.status(500).send("Error generating parking image");
  }
});

// Add new endpoint to get parking image
app.post("/save_location", async (req, res) => {
  try {
    // Extract query parameters from the URL
    const { user_id, latitude, longitude } = req.query;

    // Check if the required parameters are provided
    if (!user_id || !latitude || !longitude) {
      return res.status(400).json({
        message:
          "Missing required parameters: user_id, latitude, or longitude.",
      });
    }

    // For demonstration purposes, log the data
    console.log(
      `User ID: ${user_id}, Latitude: ${latitude}, Longitude: ${longitude}`
    );

    res.status(200).json({ message: "Location received successfully." });
  } catch (error) {
    console.error("Error saving parking data:", error);
    res.status(500).send("Error saving parking data");
  }
});

// API route to get data from PostgreSQL
app.get("/today_assignments", async (req, res) => {
  try {
    const assignments = await assignSlots(true);
    res.json(assignments);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// API route to get roster data from PostgreSQL
app.get("/roster", async (req, res) => {
  try {
    const cancellations = await getViews("roster");
    res.status(200).json(cancellations);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// API route to get roster data from PostgreSQL
app.get("/twilio-balance", async (req, res) => {
  try {
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;

    if (!accountSid || !authToken) {
      console.error("Twilio credentials missing");
      return res
        .status(500)
        .json({ error: "Twilio credentials not configured." });
    }

    // Initialize the Twilio client
    const client = twilio(accountSid, authToken);

    // Fetch the balance (returns { accountSid, balance, currency }) :contentReference[oaicite:0]{index=0}
    const data = await client.balance.fetch();

    // Return only the bits your React app needs
    res.status(200).json({ balance: `${data.balance} ${data.currency}` });
  } catch (err) {
    console.error("Error fetching Twilio balance:", err);
    res.status(500).json({ error: err.message });
  }
});

// API route to get last cancellations from PostgreSQL
app.get("/last_cancellations", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;

    // Query database directly with date filter (15 days) and limit — much faster
    const result = await pool.query(`
      SELECT * FROM last_cancellations
      WHERE cancellation_time >= NOW() - INTERVAL '15 days'
      ORDER BY cancellation_time DESC
      LIMIT $1
    `, [limit]);

    res.status(200).json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// API route to get top cancellers from PostgreSQL
app.get("/top_cancellers", async (req, res) => {
  try {
    const cancellations = await getViews("top_cancellers");
    res.status(200).json(cancellations);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// API route to get monthly cancellations from PostgreSQL
app.get("/monthly_cancellations", async (req, res) => {
  try {
    const cancellations = await getViews("monthly_cancellations");
    res.status(200).json(cancellations);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Endpoint: returns both today's and yesterday's parking data
app.get("/parking-data", async (req, res) => {
  try {
    // use your constants here
    const [todayRaw, yesterdayRaw] = await Promise.all([
      fs.readFileSync(DATA_FILE_PATH, "utf8"),
      fs.readFileSync(yesterday_FILE_PATH, "utf8"),
    ]);

    const today = JSON.parse(todayRaw);
    const yesterday = JSON.parse(yesterdayRaw);

    res.json({ today, yesterday });
  } catch (err) {
    console.error("Failed to load parking data:", err);
    res.status(500).json({ message: "Error loading parking data" });
  }
});

async function change_score(user) {
  const userId = user.user_id;
  const newScore = user.possible_new_score;

  // 1) Flag the user
  await getQuery(`SELECT flag_user(${userId}, ${newScore});`);

  // 2) Fetch their updated score
  const rows = await getQuery(`
    SELECT score
      FROM roster
     WHERE id = ${userId};
  `);

  // 3) Return the score (or 0 if undefined)
  return rows[0]?.score ?? 0;
}

async function restore_score(user) {
  const userId = user.user_id;

  // 1) Flag the user
  await getQuery(`SELECT unflag_user(${userId});`);

  // 2) Fetch their updated score
  const rows = await getQuery(`
    SELECT score
      FROM roster
     WHERE id = ${userId};
  `);

  // 3) Return the score (or 0 if undefined)
  return rows[0]?.score ?? 0;
}

async function getPhone(userId) {
  const rows = await getQuery(`
    SELECT phone
      FROM roster
     WHERE id = ${userId};
  `);
  // Return the phone number or null if not found
  //Formatting to send via twilio
  return rows[0]?.phone ? `whatsapp:${rows[0].phone}` : null;
}

// API route to calculate Cancellers, communicate, and return a pretty payload
app.post("/penalize", async (req, res) => {
  try {
    // 1) Load data
    const punished = await getViews("current_month_punished");
    let toDepenalizeRaw = await getViews("current_month_depenalized");
    const maxAllowed = await getMaxPermitido();

    // 2) Filter out punished users from depenalized list
    if (punished.length > 0) {
      const punishedIds = new Set(punished.map((u) => u.user_id));
      toDepenalizeRaw = toDepenalizeRaw.filter(
        (u) => !punishedIds.has(u.user_id)
      );
    }

    // 2) Process each user (penalize)
    const penalizedUsers = await Promise.all(
      punished.map(async (user) => {
        const { user_id, name, cancellation_month, cancellation_count } = user;

        // a) derive first name & penalty month name (cancellation_month +1)
        const firstName = name.split(" ")[0];
        const penaltyMonthName = DateTime.fromJSDate(
          new Date(cancellation_month),
          { zone: "utc" }
        )
          .plus({ months: 1 })
          .toFormat("LLLL");

        // b) compute & flag new score
        const newScore = await change_score(user);
        const phone = await getPhone(user_id);

        await comunicatePenalty(
          phone,
          firstName,
          penaltyMonthName,
          cancellation_count,
          maxAllowed,
          newScore
        );

        // d) return a “pretty” object
        return {
          user_id,
          name: firstName,
          month: penaltyMonthName,
          cancellations: Number(cancellation_count),
          max_allowed: maxAllowed,
          new_score: newScore,
        };
      })
    );

    // 3) Process each user (de-penalize)
    const depenalizedUsers = await Promise.all(
      toDepenalizeRaw.map(async (user) => {
        const { user_id, name, current_month, last_month_cancellation_count } =
          user;

        // a) derive first name & release month name (same month)
        const firstName = name.split(" ")[0];
        const releaseMonthName = DateTime.fromJSDate(new Date(current_month), {
          zone: "utc",
        }).toFormat("LLLL");

        // b) compute & flag new score
        const newScore = await restore_score(user);
        const phone = await getPhone(user_id);

        await comunicateDepenalize(
          phone,
          firstName,
          releaseMonthName,
          last_month_cancellation_count,
          maxAllowed,
          newScore
        );

        // d) return a “pretty” object
        return {
          user_id,
          name: firstName,
          month: releaseMonthName,
          new_score: newScore,
        };
      })
    );

    // 4) Respond
    res.status(200).json({
      max_allowed_cancellations_next_month: maxAllowed,
      penalized_users: penalizedUsers,
      depenalized_users: depenalizedUsers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Server Error");
  }
});

// Endpoint to update the user roster data
app.post("/update-roster", async (req, res) => {
  console.log("Received request to update roster");
  const users = req.body;

  if (!Array.isArray(users) || users.length === 0) {
    console.log("Invalid request: request body must contain a list of users.");
    return res
      .status(400)
      .json({ message: "Request body must contain a list of users." });
  }

  csvData = users.map((user) => ({
    name: user.name || "",
    phone: user.phone || "",
    date_of_hire: user.date_of_hire || "",
    priority: user.priority || "",
    zs_id: user.zs_id || "",
  }));

  await writeTable(csvData, res);
});

// Endpoint to update the holidays
app.post("/update-holidays", (req, res) => {
  console.log("Received request to update the holidays list");
  const holidays = req.body;

  if (!Array.isArray(holidays) || holidays.length === 0) {
    console.log(
      "Invalid request: request body must contain a list of holidays."
    );
    return res
      .status(400)
      .json({ message: "Request body must contain a list of holidays." });
  }

  holidaysData = holidays.map((user) => ({
    date: user.date || "",
    description: user.description || "",
  }));

  saveHolidays(holidaysData, res);
});

// Twilio send message helper - supports both regular messages and templates
async function sendWhatsAppMessage(to, message, templateId = null, variables = []) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  try {
    if (templateId) {
      // Send template message
      const messageConfig = {
        contentSid: templateId,
        from: twilioNumber,
        to: to,
      };
      // Only include contentVariables if there are variables
      if (variables && variables.length > 0) {
        messageConfig.contentVariables = JSON.stringify(variables);
      }
      await client.messages.create(messageConfig);
    } else {
      // Send regular text message
      await client.messages.create({
        body: message,
        from: twilioNumber,
        to: to,
      });
    }
  } catch (error) {
    console.error("Error sending message:", error);
  }
}

async function comunicatePenalty(
  phone,
  firstName,
  penaltyMonthName,
  cancellationCount,
  maxAllowed,
  newScore
) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX433b179a721b295adb750c8f84db0b5e";

  const variables = {
    1: String(firstName),
    2: String(cancellationCount),
    3: String(maxAllowed),
    4: String(penaltyMonthName),
    5: String(newScore),
  };
  const variablesJson = JSON.stringify(variables);
  try {
    await client.messages.create({
      from: twilioNumber,
      to: phone,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    });
    console.log(`Penalty notification sent to ${firstName} (${phone})`);
  } catch (error) {
    console.error(
      `Error sending penalty notification to ${firstName} (${phone}):`,
      error
    );
  }
}

async function comunicateDepenalize(
  phone,
  firstName,
  penaltyMonthName,
  cancellationCount,
  maxAllowed,
  newScore
) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX482c98c4cdcf806a50a3ad0db1223a34";

  const variables = {
    1: String(firstName),
    2: String(cancellationCount),
    3: String(maxAllowed),
    4: String(penaltyMonthName),
    5: String(newScore),
  };
  const variablesJson = JSON.stringify(variables);
  try {
    await client.messages.create({
      from: twilioNumber,
      to: phone,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    });
    console.log(`De-Penalty notification sent to ${firstName} (${phone})`);
  } catch (error) {
    console.error(
      `Error sending de-penalty notification to ${firstName} (${phone}):`,
      error
    );
  }
}

async function sendReminder(to, slotNumber) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX897b5d5c9fa344f048119f103810d0c2";

  //retrieving first in waiting list
  const waitingListUser =
    waitingList.length > 0 ? waitingList[0].name : "someone";

  const variables = { 1: String(slotNumber), 2: waitingListUser };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

function sendTimeoutMessage(to, slot) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX29b032532782ba9d68f850c4261aa409"; // Ensure this template ID is correct and approved

  const variables = { 1: `${slot.number}` };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

function sendWaitingListMessage(to, message) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HXe8c2d1da777fa3642c87553e1b978212";

  const variables = { 1: message };
  const variablesJson = JSON.stringify(variables);
  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

function pingPair(to, assignedTo, number) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX782c2ad7292677c969d75720ed1e3d69";
  const variables = { 1: assignedTo, 2: String(number) };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

// Twilio send message helper with interactive buttons (using template messages)
function sendMessageWithButtons(to, slot) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX91de7066a15f37fa8e76250dfc3153b0"; // Ensure this template ID is correct and approved

  const variables = { 1: `${slot.number}` };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

function sendMessageWithButtonsFromBusiness(to, slot) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  console.log("Sending with busines initiated message");
  const template_id = "HX1d2fbc51c4b8e5ba8612845e810b0bb6"; // Ensure this template ID is correct and approved

  const variables = { 1: `${slot.number}` };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

function sendCancelList(to, messageNum) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX6fcb1c24463e88d8005b3951f555fc97"; // Ensure this template ID is correct and approved

  const variables = { 1: `${messageNum}` };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

function sendCancelReservation(to) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX289043a2a4bac985d4d78a828cd2220e"; // Ensure this template ID is correct and approved

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

function sendReleaseSlotWL(to, messageNum) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX6316afb1e5e94c230c4d6ed86b9b9c15"; // Ensure this template ID is correct and approved

  const variables = { 1: `${messageNum}` };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) => console.error("Error sending message:", error));
}

function sendParkingImage(to) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  // Get current date in mm/dd/yyyy format
  const today = new Date();
  const date = `${(today.getMonth() + 1).toString().padStart(2, "0")}/${today
    .getDate()
    .toString()
    .padStart(2, "0")}/${today.getFullYear()}`;

  const template_id = "HX302373474c5815892d054e92aec7e64b";
  const variables = { 1: date };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000,
    })
    .catch((error) =>
      console.error("Error sending date template message:", error)
    );
}

// ─────────────────────────────────────────────────────────────────────────────
// CHECK-IN HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Reads office config from parking_config.
// Coordinates are stored * 1,000,000 to fit the INTEGER column.
async function getOfficeConfig() {
  const keys = [
    "office_lat",
    "office_lng",
    "checkin_radius_m",
    "checkin_open_hour",
    "checkin_open_min",
    "checkin_deadline_hour",
    "checkin_deadline_min",
    "enable_noshow_penalty",
  ];
  const result = await pool.query(
    `SELECT key, value FROM parking_config WHERE key = ANY($1)`,
    [keys]
  );
  const map = Object.fromEntries(
    result.rows.map((r) => [r.key, Number(r.value)])
  );
  return {
    lat: (map.office_lat || -34581400) / 1_000_000,
    lng: (map.office_lng || -58422600) / 1_000_000,
    radiusM: map.checkin_radius_m ?? 400,
    openHour: map.checkin_open_hour ?? 10,
    openMin: map.checkin_open_min ?? 0,
    deadlineHour: map.checkin_deadline_hour ?? 11,
    deadlineMin: map.checkin_deadline_min ?? 30,
    enableNoshowPenalty: map.enable_noshow_penalty ?? 1,
  };
}

// Haversine distance in meters between two lat/lng points.
function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

// Insert a check-in row (allows multiple check-ins per user per day for spot checks).
async function saveCheckIn(userId, slotNumber, lat, lng, distanceM, isValid, checkInType = 'mandatory') {
  const now = getLocalTime().toISO();
  await pool.query(
    `
    INSERT INTO check_ins (user_id, slot_number, check_in_time, latitude, longitude, distance_m, is_valid, check_in_type)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  `,
    [userId, slotNumber, now, lat, lng, distanceM, isValid, checkInType]
  );
}

// Returns today's check-in status for every currently assigned slot.
async function getTodayCheckIns() {
  const assigned = parkingSlots.filter(
    (s) => s.status !== "available" && s.phone
  );
  if (!assigned.length) return [];

  const phones = assigned.map((s) => s.phone.replace("whatsapp:", ""));

  const [rosterRes, checkInRes] = await Promise.all([
    pool.query("SELECT id, name, phone FROM roster WHERE phone = ANY($1)", [
      phones,
    ]),
    pool.query("SELECT * FROM check_ins WHERE check_in_date = CURRENT_DATE"),
  ]);

  const rosterMap = Object.fromEntries(rosterRes.rows.map((r) => [r.phone, r]));

  // Separate mandatory and spot check maps
  const mandatoryMap = {};
  const spotCheckMap = {};

  checkInRes.rows.forEach((r) => {
    if (r.check_in_type === 'spot_check') {
      // Keep the latest spot check per user
      if (!spotCheckMap[r.user_id] || r.check_in_time > spotCheckMap[r.user_id].check_in_time) {
        spotCheckMap[r.user_id] = r;
      }
    } else {
      // Only one mandatory per day (due to partial unique index)
      mandatoryMap[r.user_id] = r;
    }
  });

  const config = await getOfficeConfig();
  const now = getLocalTime();
  const nowMins = now.hour * 60 + now.minute;
  const openMins = config.openHour * 60 + config.openMin;
  const deadlineMins = config.deadlineHour * 60 + config.deadlineMin;

  return assigned
    .map((s) => {
      const phone = s.phone.replace("whatsapp:", "");
      const user = rosterMap[phone];
      if (!user) return null;

      const mandatoryCheckIn = mandatoryMap[user.id];
      const spotCheck = spotCheckMap[user.id];

      // Status is determined only from mandatory check-ins
      let status;
      if (mandatoryCheckIn) {
        status = mandatoryCheckIn.is_valid ? "checked_in" : "wrong_location";
      } else if (nowMins > deadlineMins) {
        status = "noshow";
      } else {
        status = "pending";
      }

      // Convert mandatory check-in time to Argentina timezone
      let checkInTime = null;
      if (mandatoryCheckIn?.check_in_time) {
        const utcTime = DateTime.fromISO(mandatoryCheckIn.check_in_time, { zone: 'utc' });
        checkInTime = utcTime.setZone('America/Argentina/Buenos_Aires').toISO();
      }

      // Convert spot check time to Argentina timezone
      let spotCheckTime = null;
      if (spotCheck?.check_in_time) {
        const utcTime = DateTime.fromISO(spotCheck.check_in_time, { zone: 'utc' });
        spotCheckTime = utcTime.setZone('America/Argentina/Buenos_Aires').toISO();
      }

      return {
        slot_number: s.number,
        user_id: user.id,
        name: s.assignedTo?.replace(" (Pending)", "") || user.name,
        phone,
        slot_status: s.status,
        status,
        check_in_time: checkInTime,
        distance_m: mandatoryCheckIn?.distance_m || null,
        is_valid: mandatoryCheckIn?.is_valid ?? null,
        spot_check_time: spotCheckTime,
        spot_check_distance_m: spotCheck?.distance_m || null,
        spot_check_valid: spotCheck?.is_valid ?? null,
      };
    })
    .filter(Boolean);
}

// Handles an incoming WhatsApp location share and records a check-in.
async function handleLocationCheckIn(sender, name, lat, lng) {
  const config = await getOfficeConfig();
  const now = getLocalTime();
  const nowMins = now.hour * 60 + now.minute;
  const openMins = config.openHour * 60 + config.openMin;
  const deadlineMins = config.deadlineHour * 60 + config.deadlineMin;

  // Infer check-in type from time — no rejection for spot checks
  const withinWindow = nowMins >= openMins && nowMins <= deadlineMins;
  const checkInType = withinWindow ? 'mandatory' : 'spot_check';

  // Find user's assigned slot
  const slot = parkingSlots.find(
    (s) => s.phone === sender && s.status !== "available"
  );
  if (!slot) {
    await sendWhatsAppMessage(
      sender,
      `You don't have a parking slot assigned for today.`
    );
    return;
  }

  const userId = await searchUserId(sender);
  if (!userId) return;

  // Calculate distance
  const distanceM = haversineDistance(lat, lng, config.lat, config.lng);
  const isValid = distanceM <= config.radiusM;

  // Record the check-in with type (allows multiple per day for spot checks)
  await saveCheckIn(userId, slot.number, lat, lng, distanceM, isValid, checkInType);
  logActionToDB(
    sender,
    `Check-in [${checkInType}] for slot ${slot.number} — ${distanceM}m from office — ${
      isValid ? "VALID" : "INVALID"
    }`
  );

  if (isValid) {
    await sendWhatsAppMessage(
      sender,
      `✅ Check-in confirmed for slot *${slot.number}*!`
    );
  } else {
    await sendWhatsAppMessage(
      sender,
      `📍 Your location is *${distanceM}m* from the office.\nPlease share your location from the office`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ADMIN ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// GET /admin/live-slots — real-time in-memory state (not from file)
app.get("/admin/live-slots", (req, res) => {
  const slots = parkingSlots.map((s) => ({
    number: s.number,
    status: s.status,
    assignedTo: s.assignedTo,
    phone: s.phone,
    timeoutDate: s.timeoutDate,
  }));
  res.json({ slots, waitingList, parkingDate });
});

// POST /admin/assign — force-assign a roster user to a slot (skips pending flow)
// Body: { slotNumber: number, userId: number, notify: boolean }
app.post("/admin/assign", async (req, res) => {
  const { slotNumber, userId, notify = false } = req.body;

  if (!slotNumber || !userId) {
    return res
      .status(400)
      .json({ message: "slotNumber and userId are required." });
  }

  // Look up user from roster
  let userRow;
  try {
    const result = await pool.query(
      "SELECT name, phone FROM roster WHERE id = $1",
      [userId]
    );
    if (!result.rows.length)
      return res.status(404).json({ message: "User not found in roster." });
    userRow = result.rows[0];
  } catch (err) {
    return res
      .status(500)
      .json({ message: "DB error looking up user.", error: err.message });
  }

  const slot = parkingSlots.find((s) => s.number === Number(slotNumber));
  if (!slot)
    return res.status(404).json({ message: `Slot ${slotNumber} not found.` });

  // Clear any existing timeout on this slot
  if (slot.timeoutHandle) {
    clearTimeout(slot.timeoutHandle);
    slot.timeoutHandle = null;
  }

  slot.status = "assigned";
  slot.assignedTo = userRow.name;
  slot.phone = `whatsapp:${userRow.phone}`;
  slot.timeoutDate = null;

  if (notify) {
    sendWhatsAppMessage(
      slot.phone,
      `Hi ${
        userRow.name.split(" ")[0]
      }! You have been manually assigned parking slot *${
        slot.number
      }* for ${parkingDate} by an administrator.`
    );
  }

  saveParkingData(DATA_FILE_PATH);
  res.json({
    message: "Slot assigned.",
    slot: {
      number: slot.number,
      status: slot.status,
      assignedTo: slot.assignedTo,
    },
  });
});

// POST /admin/release — free a slot by number
// Body: { slotNumber: number, notify: boolean }
app.post("/admin/release", (req, res) => {
  const { slotNumber, notify = false } = req.body;

  if (!slotNumber)
    return res.status(400).json({ message: "slotNumber is required." });

  const slot = parkingSlots.find((s) => s.number === Number(slotNumber));
  if (!slot)
    return res.status(404).json({ message: `Slot ${slotNumber} not found.` });
  if (slot.status === "available")
    return res.status(400).json({ message: "Slot is already available." });

  if (notify && slot.phone) {
    sendWhatsAppMessage(
      slot.phone,
      `Hi ${(slot.assignedTo || "").split(" ")[0]}! Your parking slot *${
        slot.number
      }* for ${parkingDate} has been released by an administrator.`
    );
  }

  if (slot.timeoutHandle) {
    clearTimeout(slot.timeoutHandle);
    slot.timeoutHandle = null;
  }

  slot.status = "available";
  slot.assignedTo = null;
  slot.phone = null;
  slot.timeoutDate = null;

  assignNextSlot();
  saveParkingData(DATA_FILE_PATH);
  res.json({ message: "Slot released.", slotNumber });
});

// POST /admin/swap — swap occupants between two slots
// Body: { slotA: number, slotB: number }
app.post("/admin/swap", (req, res) => {
  const { slotA, slotB } = req.body;

  if (!slotA || !slotB)
    return res.status(400).json({ message: "slotA and slotB are required." });
  if (slotA === slotB)
    return res.status(400).json({ message: "Cannot swap a slot with itself." });

  const a = parkingSlots.find((s) => s.number === Number(slotA));
  const b = parkingSlots.find((s) => s.number === Number(slotB));

  if (!a) return res.status(404).json({ message: `Slot ${slotA} not found.` });
  if (!b) return res.status(404).json({ message: `Slot ${slotB} not found.` });

  // Clear both timeouts — after a swap the old timeouts are stale
  if (a.timeoutHandle) {
    clearTimeout(a.timeoutHandle);
    a.timeoutHandle = null;
  }
  if (b.timeoutHandle) {
    clearTimeout(b.timeoutHandle);
    b.timeoutHandle = null;
  }

  // Swap fields
  [a.status, b.status] = [b.status, a.status];
  [a.assignedTo, b.assignedTo] = [b.assignedTo, a.assignedTo];
  [a.phone, b.phone] = [b.phone, a.phone];
  a.timeoutDate = null;
  b.timeoutDate = null;

  saveParkingData(DATA_FILE_PATH);
  res.json({
    message: "Slots swapped.",
    slotA: { number: a.number, status: a.status, assignedTo: a.assignedTo },
    slotB: { number: b.number, status: b.status, assignedTo: b.assignedTo },
  });
});

// POST /admin/wl-remove — remove a person from the waiting list by phone
// Body: { phone: string }
app.post("/admin/wl-remove", (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ message: "phone is required." });

  const normalised = phone.startsWith("whatsapp:")
    ? phone
    : `whatsapp:${phone}`;
  const before = waitingList.length;
  waitingList = waitingList.filter((u) => u.phone !== normalised);

  if (waitingList.length === before) {
    return res
      .status(404)
      .json({ message: "Person not found in waiting list." });
  }

  saveParkingData(DATA_FILE_PATH);
  res.json({ message: "Removed from waiting list.", waitingList });
});

// POST /admin/wl-add — add a roster user to the waiting list
// Body: { userId: number, position: number (optional, 0-indexed, default = end) }
app.post("/admin/wl-add", async (req, res) => {
  const { userId, position } = req.body;
  if (!userId) return res.status(400).json({ message: "userId is required." });

  let userRow;
  try {
    const result = await pool.query(
      "SELECT name, phone FROM roster WHERE id = $1",
      [userId]
    );
    if (!result.rows.length)
      return res.status(404).json({ message: "User not found in roster." });
    userRow = result.rows[0];
  } catch (err) {
    return res.status(500).json({ message: "DB error.", error: err.message });
  }

  const phone = `whatsapp:${userRow.phone}`;

  // Guard: already in a slot or WL
  const alreadyInSlot = parkingSlots.find(
    (s) => s.phone === phone && s.status !== "available"
  );
  if (alreadyInSlot)
    return res
      .status(400)
      .json({
        message: `${userRow.name} already has slot ${alreadyInSlot.number}.`,
      });

  const alreadyInWL = waitingList.find((u) => u.phone === phone);
  if (alreadyInWL)
    return res
      .status(400)
      .json({ message: `${userRow.name} is already on the waiting list.` });

  const entry = { name: userRow.name, phone };
  const pos =
    position !== undefined && position !== null
      ? Number(position)
      : waitingList.length;
  waitingList.splice(pos, 0, entry);

  saveParkingData(DATA_FILE_PATH);
  res.json({ message: "Added to waiting list.", position: pos, waitingList });
});

// GET /admin/office-config — return current office location + check-in window
app.get("/admin/office-config", async (_, res) => {
  try {
    const config = await getOfficeConfig();
    res.json(config);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to load office config.", error: err.message });
  }
});

// POST /admin/office-config — save office location + check-in window + penalties
// Body: { lat, lng, radiusM, openHour, openMin, deadlineHour, deadlineMin, enableNoshowPenalty }
app.post("/admin/office-config", async (req, res) => {
  const { lat, lng, radiusM, openHour, openMin, deadlineHour, deadlineMin, enableNoshowPenalty } =
    req.body;
  if (lat === undefined || lng === undefined) {
    return res.status(400).json({ message: "lat and lng are required." });
  }
  try {
    const upsert = (key, value) =>
      pool.query(
        `INSERT INTO parking_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, value]
      );
    await Promise.all([
      upsert("office_lat", Math.round(parseFloat(lat) * 1_000_000)),
      upsert("office_lng", Math.round(parseFloat(lng) * 1_000_000)),
      upsert("checkin_radius_m", Number(radiusM) ?? 400),
      upsert("checkin_open_hour", Number(openHour) ?? 10),
      upsert("checkin_open_min", Number(openMin) ?? 0),
      upsert("checkin_deadline_hour", Number(deadlineHour) ?? 11),
      upsert("checkin_deadline_min", Number(deadlineMin) ?? 30),
      upsert("enable_noshow_penalty", enableNoshowPenalty ? 1 : 0),
    ]);
    res.json({ message: "Office config saved." });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to save office config.", error: err.message });
  }
});

// GET /admin/checkins-today — live check-in status for all assigned slots
app.get("/admin/checkins-today", async (_, res) => {
  try {
    const data = await getTodayCheckIns();
    res.json(data);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to load check-ins.", error: err.message });
  }
});

// POST /admin/manual-checkin — admin marks a user as checked in
// Body: { userId, slotNumber }
app.post("/admin/manual-checkin", async (req, res) => {
  const { userId, slotNumber } = req.body;
  if (!userId || !slotNumber) {
    return res
      .status(400)
      .json({ message: "userId and slotNumber are required." });
  }
  try {
    const existing = await pool.query(
      `SELECT id FROM check_ins WHERE user_id = $1 AND check_in_date = CURRENT_DATE`,
      [userId]
    );
    if (existing.rows.length > 0) {
      return res
        .status(400)
        .json({ message: "User already checked in today." });
    }
    await saveCheckIn(
      Number(userId),
      Number(slotNumber),
      null,
      null,
      null,
      true
    );
    // Log manual check-in to admin_actions table
    logAdminActionToDB(
      'MANUAL_CHECKIN',
      `Manual check-in for user ${userId} (slot ${slotNumber})`,
      { userId, slotNumber }
    );
    console.log(`[MANUAL_CHECKIN] User ${userId} checked in to slot ${slotNumber}`);
    res.json({ message: "Manual check-in recorded." });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to record check-in.", error: err.message });
  }
});

// POST /send-checkin-request — send WhatsApp location request to assigned users
// Body: { targets: 'all' | [userId, ...] }
app.post("/send-checkin-request", async (req, res) => {
  const { targets = "all" } = req.body;
  const config = await getOfficeConfig();
  const deadline = `${config.deadlineHour}:${String(
    config.deadlineMin
  ).padStart(2, "0")} AM`;

  const toNotify = parkingSlots.filter((s) => {
    if (s.status === "available" || !s.phone) return false;
    if (targets === "all") return true;
    // targets is array of userId — match by phone lookup (handled below)
    return true;
  });

  let sent = 0,
    skipped = 0;
  const details = [];

  for (const slot of toNotify) {
    const name = slot.assignedTo?.replace(" (Pending)", "") || "there";
    const firstName = name.split(" ")[0];
    const msg = `🅿️ Hi ${firstName}! Time to check in for slot *${slot.number}*.\n\nPlease share your *current location* in this chat to confirm you're at the office.\nDeadline: *${deadline}*\n\nTap 📎 → Location → Send current location.`;
    try {
      await sendWhatsAppMessage(slot.phone, msg);
      logActionToDB(
        slot.phone,
        `Check-in request sent for slot ${slot.number}`
      );
      sent++;
      details.push({ slot: slot.number, name, status: "sent" });
    } catch (err) {
      skipped++;
      details.push({
        slot: slot.number,
        name,
        status: "failed",
        error: err.message,
      });
    }
  }

  res.json({ sent, skipped, details });
});

// POST /admin/send-checkin-to-user — send check-in request to a specific user
// Body: { userId }
app.post("/admin/send-checkin-to-user", async (req, res) => {
  const { userId } = req.body;
  if (!userId) {
    return res.status(400).json({ message: "userId is required." });
  }

  try {
    const config = await getOfficeConfig();
    const deadline = `${config.deadlineHour}:${String(
      config.deadlineMin
    ).padStart(2, "0")} AM`;

    // Find user in roster to get phone
    const userRes = await pool.query(
      "SELECT phone, name FROM roster WHERE id = $1",
      [userId]
    );

    if (!userRes.rows.length) {
      return res.status(400).json({ message: "User not found." });
    }

    const user = userRes.rows[0];
    const userSlot = parkingSlots.find(
      (s) => s.phone.replace("whatsapp:", "") === user.phone && s.status !== "available"
    );

    if (!userSlot) {
      return res.status(400).json({ message: "User does not have an assigned slot." });
    }

    const name = userSlot.assignedTo?.replace(" (Pending)", "") || user.name;
    const firstName = name.split(" ")[0];
    const msg = `🅿️ Hi ${firstName}! Time to check in for slot *${userSlot.number}*.\n\nPlease share your *current location* in this chat to confirm you're at the office.\nDeadline: *${deadline}*\n\nTap 📎 → Location → Send current location.`;

    await sendWhatsAppMessage(userSlot.phone, msg);
    logActionToDB(
      userSlot.phone,
      `Manual check-in request sent for slot ${userSlot.number}`
    );
    logAdminActionToDB(
      'SEND_CHECKIN_REQUEST',
      `Sent check-in request to user ${userId} (slot ${userSlot.number})`,
      { userId, slotNumber: userSlot.number }
    );

    res.json({ message: `Check-in request sent to ${name}` });
  } catch (err) {
    res.status(500).json({
      message: "Failed to send check-in request.",
      error: err.message,
    });
  }
});

// POST /process-noshow — penalise users who didn't check in (2x bad cancellation)
// Slot is NOT released. Penalty = 2 log entries matching the scoring pattern.
// Penalty is only applied if enable_noshow_penalty flag is enabled.
app.post("/process-noshow", async (_, res) => {
  try {
    const config = await getOfficeConfig();
    const checkIns = await getTodayCheckIns();
    const noShows = checkIns.filter((c) => c.status === "noshow");

    if (!noShows.length) {
      return res.json({ message: "No no-shows found.", processed: [] });
    }

    // Check if penalty is enabled
    if (!config.enableNoshowPenalty) {
      return res.json({
        message: `Found ${noShows.length} no-show(s) but penalty is disabled.`,
        processed: noShows.map((u) => ({
          user_id: u.user_id,
          name: u.name,
          slot: u.slot_number,
          penalty: "Skipped (penalty disabled)",
        })),
      });
    }

    // Use 11:30 today (Argentina time) as the log timestamp so scoring picks it up
    const logTime = getLocalTime()
      .set({
        hour: 11,
        minute: 30,
        second: 0,
        millisecond: 0,
      })
      .toISO();

    const processed = [];

    for (const user of noShows) {
      try {
        // Insert 2 log entries = 2x bad cancellation penalty
        await pool.query(
          `INSERT INTO logs (user_id, action, log_time) VALUES
            ($1, $2, $3),
            ($1, $2, $3)`,
          [user.user_id, `Released_slot_${user.slot_number}_noshow`, logTime]
        );

        // Notify user with template
        const firstName = user.name.split(" ")[0];
        await sendWhatsAppMessage(
          `whatsapp:${user.phone}`,
          null,
          'HX6b0f23f08bab02ca6fb3797487411f1e',
          [firstName, user.slot_number]
        );

        processed.push({
          user_id: user.user_id,
          name: user.name,
          slot: user.slot_number,
          penalty: "2x bad cancellation",
        });
      } catch (err) {
        console.error(
          `Error processing no-show for user ${user.user_id}:`,
          err
        );
      }
    }

    res.json({
      message: `Processed ${processed.length} no-show(s).`,
      processed,
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to process no-shows.", error: err.message });
  }
});

// GET /admin/permanent-slots — list all permanent assignments
app.get("/admin/permanent-slots", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT ps.slot_number, ps.user_id, r.name, r.phone
      FROM permanent_slots ps
      JOIN roster r ON r.id = ps.user_id
      ORDER BY ps.slot_number
    `);
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "DB error.", error: err.message });
  }
});

// POST /admin/permanent-slots — add a permanent assignment and apply immediately
// Body: { slotNumber, userId }
app.post("/admin/permanent-slots", async (req, res) => {
  const { slotNumber, userId } = req.body;
  if (!slotNumber || !userId) {
    return res
      .status(400)
      .json({ message: "slotNumber and userId are required." });
  }

  let userRow;
  try {
    const r = await pool.query("SELECT name, phone FROM roster WHERE id = $1", [
      userId,
    ]);
    if (!r.rows.length)
      return res.status(404).json({ message: "User not found." });
    userRow = r.rows[0];
  } catch (err) {
    return res.status(500).json({ message: "DB error.", error: err.message });
  }

  try {
    await pool.query(
      `INSERT INTO permanent_slots (slot_number, user_id)
       VALUES ($1, $2)
       ON CONFLICT (slot_number) DO UPDATE SET user_id = EXCLUDED.user_id`,
      [Number(slotNumber), Number(userId)]
    );
  } catch (err) {
    return res
      .status(500)
      .json({ message: "Failed to save permanent slot.", error: err.message });
  }

  res.json({
    message:
      "Permanent assignment saved. Will take effect on next daily reset.",
    slotNumber,
    name: userRow.name,
  });
});

// DELETE /admin/permanent-slots/:slotNumber — remove a permanent assignment
// The slot stays assigned for the rest of the day; it will just behave normally on next reset.
app.delete("/admin/permanent-slots/:slotNumber", async (req, res) => {
  const slotNumber = parseInt(req.params.slotNumber, 10);
  if (isNaN(slotNumber))
    return res.status(400).json({ message: "Invalid slot number." });

  try {
    const result = await pool.query(
      "DELETE FROM permanent_slots WHERE slot_number = $1 RETURNING slot_number",
      [slotNumber]
    );
    if (!result.rowCount) {
      return res
        .status(404)
        .json({ message: `No permanent assignment for slot ${slotNumber}.` });
    }
    res.json({
      message: `Permanent assignment for slot ${slotNumber} removed. It stays assigned today but will be released on next reset.`,
    });
  } catch (err) {
    res.status(500).json({ message: "DB error.", error: err.message });
  }
});

// Start the server and ngrok
// app.listen(port, () =>
//   console.log(`Node.js web server at http://localhost:${port} is running...`)
// );

app.listen(port, "0.0.0.0", () =>
  console.log(`Node.js web server at http://localhost:${port} is running...`)
);

// Get your endpoint online with ngrok
ngrok
  .connect({
    addr: port,
    authtoken: process.env.NGROK_AUTHTOKEN,
    domain: "brief-stable-penguin.ngrok-free.app",
  })
  .then((listener) => {
    console.log(`Ingress established at: ${listener.url()}`);
    // Here you can set up your Twilio webhook URL with the ngrok URL
  })
  .catch((error) => {
    console.error("Error connecting ngrok:", error);
  });
