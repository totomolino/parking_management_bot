const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const cors = require("cors");
const ngrok = require("@ngrok/ngrok");
const fs = require("fs"); // Import fs module for logging
const path = require('path');
const { DateTime } = require('luxon');//for date manipulation
require("dotenv").config(); // Load environment variables from .env file
const csvParser = require('csv-parser');
const { createCanvas, loadImage } = require('canvas');
const { handle } = require("express/lib/application");
const { Pool } = require('pg'); // Import the pg Pool for database connection
const res = require("express/lib/response");
const { EsimProfilePage } = require("twilio/lib/rest/supersim/v1/esimProfile");
const { all, get } = require("axios");

// Create a new pool to interact with PostgreSQL
const pool = new Pool({
  user: 'postgres',       // Replace with your PostgreSQL username
  host: 'localhost',      // Replace with your host if needed
  database: 'parking_database', // Your database name
  password: 'mySecurePassword123', // Your PostgreSQL password
  port: 5432,             // Default PostgreSQL port
});

const filePath = './roster.csv'; // Path to your CSV file
const holidaysFilePath = './holidays.csv'; // Path to your CSV file
// File path for persistence
const DATA_FILE_PATH = path.join(__dirname, 'parking_data.json');
const yesterday_FILE_PATH = path.join(__dirname, 'parking_data_yesterday.json');
const imagePath = 'original_image.jpg';
const outputPath = 'modified_image.jpg';

let csvData = []; // In-memory storage for CSV data
let holidaysData = []; // In-memory storage for Holidays data
const maxRetries = 3;

// Function to read CSV file and populate csvData
async function readCSV() {
  try {
    const result = await pool.query('SELECT name, phone, date_of_hire, priority FROM roster');
    csvData = result.rows.map(row => ({
      name: row.name,
      phone: row.phone,
      date_of_hire: row.date_of_hire,
      priority: row.priority
    }));
    console.log('Roster table successfully read from database');
  } catch (error) {
    console.error('Error reading roster table from database:', error);
  }
}

readCSV();

// Configuration for image generation
const cellWidth = 70;  // Width of each cell in pixels
const cellHeight = 22; // Height of each cell in pixels

// Function to modify parking slot image
async function generateParkingImage() {
    try {
        const image = await loadImage(imagePath);
        const canvas = createCanvas(image.width, image.height);
        const ctx = canvas.getContext('2d');

        ctx.drawImage(image, 0, 0);
        ctx.font = '15px Liberation Mono';
        ctx.fillStyle = 'black';

        const textPositions = {};

        // First pack of slots (C3 to C11)
        parkingSlots.slice(0, 9).forEach((slot, i) => {
            const row = 4 + i;
            const position = `${(2 * cellWidth) + 5},${(row * cellHeight) - 5}`;
            textPositions[position] = slot.assignedTo || '';
        });

        // Second pack of slots (C17 to C34)
        parkingSlots.slice(9).forEach((slot, i) => {
            const row = 17 + i;
            const position = `${(2 * cellWidth) + 5},${(row * cellHeight) - 5}`;
            textPositions[position] = slot.assignedTo || '';
        });

        // Waiting list (Column H, starting from row 25)
        waitingList.forEach((person, i) => {
            if (i < 18) { // Limit to 18 waiting list entries
                const row = 25 + i;
                const position = `${(7 * cellWidth) + 5},${(row * cellHeight) - 5}`;
                textPositions[position] = person.name;
            }
        });

        // Draw all text positions
        for (const [position, text] of Object.entries(textPositions)) {
            const [x, y] = position.split(',').map(Number);
            ctx.fillText(text, x, y);
        }

        const buffer = canvas.toBuffer('image/jpeg');
        fs.writeFileSync(outputPath, buffer);
        return outputPath;
    } catch (error) {
        console.error('Error generating parking image:', error);
        throw error;
    }
}

// Function to write CSV data to file
function writeCSV(data, res) {
  // Add headers to CSV
  const headers = "name,phone,date_of_hire,priority\n";
  const updatedCSV = headers + data.map((row) => `${row.name},${row.phone},${row.date_of_hire},${row.priority}`).join('\n');
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
    await client.query('BEGIN');
    
    // Clear existing holidays
    await client.query('DELETE FROM holidays');

    // Insert new holidays
    const insertPromises = data.map(row => {
      const [day, month, year] = row.date.split('/'); // split "24/03/2025"
      const formattedDate = `${year}-${month}-${day}`; // "2025-03-24"

      return client.query(
        'INSERT INTO holidays (date, description) VALUES ($1, $2)',
        [formattedDate, row.description]
      );
    });

    await Promise.all(insertPromises);

    await client.query('COMMIT');
    res.status(200).json({ message: 'Holidays updated successfully.' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error updating holidays in DB:', err);
    res.status(500).json({ message: 'Failed to update holidays.' });
  } finally {
    client.release();
  }
}

const app = express();
const port = 3000;  // HTTP port
const twilioNumber = "whatsapp:+12023351857"

// Middleware setup
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); // Middleware to parse JSON body
// Enable CORS for all routes
app.use(cors({
    origin: '*',
    methods: ['GET','POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'ngrok-skip-browser-warning']
}));

// Path to the log file
const LOG_FILE = "bot_actions.log";

// Function to log actions to a text file
function logAction(userPhone, userName, action) {
  const timestamp = getLocalTime();
  const logEntry = `${timestamp}|${userPhone.replace("whatsapp:","")}|${userName}|${action}\n`;
  fs.appendFile(LOG_FILE, logEntry, (err) => {
    if (err) {
      console.error("Error logging action:", err);
    }
  });
  logActionToDB(userPhone, action); // Log to database as well
}

// Async function to search for user ID
async function searchUserId(userPhone) {
  const query = 'SELECT id FROM roster WHERE phone = $1';
  const values = [userPhone.replace("whatsapp:","")]; // Remove "whatsapp:" prefix

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

    const logTime = DateTime.now().setZone('America/Argentina/Buenos_Aires').toISO();
    const query = 'INSERT INTO logs (user_id, action, log_time) VALUES ($1, $2, $3)';
    const values = [userId, action, logTime];

    await pool.query(query, values);
    console.log("Logged action successfully!");
  } catch (err) {
    console.error("Error logging to DB:", err);
  }
}

// Initial Parking Slots Configuration
const initialSlots = [
  832,
  834,
  835,
  836,
  837,
  838,
  839,
  840,
  841,
  ...Array.from({ length: 10 }, (_, i) => 585 + i), // 585 to 594
  ...Array.from({ length: 8 }, (_, i) => 569 + i), // 569 to 576
].map((slotNumber) => ({
  number: slotNumber,
  status: "available", // possible statuses: 'available', 'pending', 'assigned'
  assignedTo: null,
  phone: null,
  timeoutHandle: null, // To store the timeout reference
  timeoutDate: null,
}));

// Add slot 60 with pre-assigned values
initialSlots.push({
  number: 60,
  status: "assigned",
  assignedTo: "Ramses de la Rosa",
  phone: "whatsapp:+5491169691511",
  timeoutHandle: null,
  timeoutDate: null,
});

// Function to load data from file
function loadParkingData() {
  if (fs.existsSync(DATA_FILE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE_PATH, 'utf-8'));
      console.log('Data loaded successfully from file.');
      return data;
    } catch (error) {
      console.error('Error reading parking data file:', error);
    }
  }
  console.log('No data file found, using default values.');
  return { parkingSlots: initialSlots, waitingList: [] };
}

// Function to save data to file
function saveParkingData(filePath) {
  // Preprocess parkingSlots to handle timeoutHandle as null
  const processedParkingSlots = parkingSlots.map(slot => ({
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
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log('Data saved successfully to file.');
  } catch (error) {
    console.error('Failed to save data:', error);
  }
};

// Restore data on startup
const restoredData = loadParkingData();
let parkingSlots = restoredData?.parkingSlots || initialSlots;
let waitingList = restoredData?.waitingList || [];
let parkingDate = restoredData?.parkingDate || getLocalTime().toFormat('dd/MM/yyyy');


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
  
  const entry = csvData.find((row) => row.phone ===  sender.replace("whatsapp:", "")); //TODO CHANGE TO READ DB INSTEAD OF FILE.

  const name = entry ? entry.name : sender;

  // Check if the sender is not found in csvData
  if (!entry) {
    const loginMessage = `Hi! Here’s how to start using the building’s parking:
    
1️⃣ Register your plate → [https://forms.office.com/r/V8GPjRKtTY]
_Note: access may take up to 24 hours to be activated._
 
2️⃣ Register your mobile phone with the bot → [https://forms.office.com/r/0scGm4w6s9]
 
_Note: Both forms are only allowed on ZS laptop or Edge mobile with ZS account._
 
Once both steps are completed, you can start booking your daily spot directly on WhatsApp! You can type *help* to see more info about each command!`
    sendWhatsAppMessage(
      sender,
      loginMessage
    );
    return res.status(200).end();
  }
  
  switch (true) {
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
    case messageBody === "cancel reserve" || messageBody === "cancel tomorrow reserve":
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
      if(isWorkday && localTime.hour >= 8 && localTime.hour < 17){
        handleReserve(req.body.MessageSid, sender,name);
      }else{
        sendWhatsAppMessage(sender, `You can only reserve on workdays from 9am to 5pm. Use command "Add me" for WL.`);
      }
      break;
    case messageBody === "score":
      logActionToDB(sender, "COMMAND_SCORE");
      handleScore(sender); //TODO
      break;
    case messageBody === "test_new":
      // handleTestNew(sender, name);
      // handleCancelList(sender);
      assignSlots();
      break;
    case messageBody === "daycheck":
      const todaytest = (await getNextWorkday()).toString();
      sendWhatsAppMessage(
        sender,
        `Next bussines day is: ${todaytest}, today is holiday? ${await isTodayHoliday()}`
      );
      break;
    case messageBody === "help":
      const infoMessage = `
Here’s how the parking bot works:

📅  You must request your reservation one day in advance.

🕘  The bot works on weekdays from 9am to 5pm.

📤  Assignments are sent at 5:10pm. You have 2 hours to accept or cancel — after that, your spot is released.

⏳  Waitlist users have 10 minutes to respond.

😴  The bot is inactive from 10pm to 7am due to timeout (10 minutes timeout will resume at 7 am).

🏖️  For holidays, make your request the previous business day.

❌  *Cancellations after 8:00 AM* will now count against your usage. *Three or more in a month = temporary loss of prioritization*. Prioritization resets monthly with good usage.


Commands:
🔹 *reserve* – book your spot
🔹 *cancel* – cancel today’s or tomorrow’s reservation
🔹 *add me* – join today’s waitlist
🔹 *show all* – see all today’s bookings
🔹 *ping* – notify shared spot users
🔹 *score* – check your current score and month cancellations.
      `
      sendWhatsAppMessage(
        sender,
        infoMessage
      );
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
  sendCancelList(sender,"836");
};

async function handleScore(sender) {
  //Retrieve user ID
  const userId = await searchUserId(sender);

  //Bring Score from DB using Roster table
  const query = `
  select roster.score, coalesce(b.cancellation_count,0) as cancellations
  from roster
  left join (select * from monthly_cancellations where EXTRACT(month FROM cancellation_month) = EXTRACT(month FROM current_date)) b on roster.id = b.user_id
  where roster.id = $1;
  `;
  const values = [userId];
  try {
    const result = await pool.query(query, values);

    if (result.rows.length > 0) {
      const score = result.rows[0].score;
      const cancellations = result.rows[0].cancellations;
      const month = getLocalTime().toFormat('MMMM');
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

  try {
    const message = await client.messages(messageSid).fetch();

    // Check if the dateSent is valid
    if (!message.dateSent) {
      console.log("Invalid dateSent from Twilio, using fallback.");
      return DateTime.now()
        .setZone('America/Argentina/Buenos_Aires')
        .toFormat('yyyy-MM-dd HH:mm:ss');
    }
    return DateTime.fromJSDate(new Date(message.dateSent))
      .setZone('America/Argentina/Buenos_Aires')
      .toFormat('yyyy-MM-dd HH:mm:ss');
  } catch (err) {
    console.error("Failed to get Twilio timestamp, using fallback", err);
    return DateTime.now()
      .setZone('America/Argentina/Buenos_Aires')
      .toFormat('yyyy-MM-dd HH:mm:ss');
  }
}

async function handleReserve(MessageSid, sender, name) {
  try {
    const timestamp = await getArgentinaTimestamp(MessageSid); // Luxon formatted timestamp
    const userId = await searchUserId(sender);

    // Save reservation
    const reservationId = await saveReservation(userId, timestamp);

    // Parse timestamp to Luxon DateTime for comparison
    const reservationTime = DateTime.fromFormat(timestamp, 'yyyy-MM-dd HH:mm:ss', { zone: 'America/Argentina/Buenos_Aires' });

    let message = `Reservation submitted.`;

    // Check if time is before 9:00 AM
    if (reservationTime.hour < 9) {
      message += ` *Your reservation was made before 9:00 AM, You will get least priority.*`;
    }

    await sendWhatsAppMessage(sender, message);

  } catch (err) {
    console.error("Error handling reservation:", err);
    await sendWhatsAppMessage(sender, `Sorry ${name}, there was an issue processing your reservation.`);
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

async function orderAssignements(res) {
  let query = `SELECT conditional_refresh_mv('today_assignments_mv')`;
  const values = [];

  try {
    const result = await pool.query(query, values);
    res.status(200).json({ message: "Assignments ordered successfully.", data: result.rows });
  } catch (err) {
    console.error("Error ordering the assignments:", err);
    res.status(500).json({ message: "Error ordering the assignments." });
    return [];
  }
}

//Function to get any view from db
async function getViews(view){
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




//Function to order reservations and assign slots
async function assignSlots(all_flag = false) {
  const slotNumbers = parkingSlots
    .filter(slot => slot.number !== 60)
    .map(slot => slot.number);

  const assignments = await getAssignments();
  
  let filteredAssignments = assignments.map((assignment, index) => {
    return all_flag
      ? { ...assignment, slot: slotNumbers[index] ?? 'WL' }
      : {
          name: assignment.name,
          phone: assignment.phone,
          slot: slotNumbers[index] ?? 'WL',
        };
  });

  filteredAssignments.forEach(a => {
    // logActionToDB(a.phone, `Assigned to slot ${a.slot}`); //TODO uncomment this line to log the assignment
  });

  return filteredAssignments;
}




function getLocalTime() {
  // Get current time in Buenos Aires timezone
  const localTime = DateTime.now().setZone('America/Argentina/Buenos_Aires');
  return localTime;
}



function calculateTimeoutDuration(timeoutDuration) {
  const localTime = getLocalTime(); // Luxon DateTime

  let finalDelay = timeoutDuration;

  const currentHour = localTime.hour;

  if (currentHour >= 22 || currentHour < 7) {
    let nextDay7am = localTime;
    // Set time to 7:10 AM
    nextDay7am = nextDay7am.set({ hour: 7, minute: 10, second: 0, millisecond: 0 });
    
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
  if(message === 'BS'){
    sendMessageWithButtonsFromBusiness(user.phone, slot)
  }else{
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
function  handleAddMe(sender, name) {
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
  sendParkingImage(sender)
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
      ? `${Math.ceil((item.timeoutHandle._idleStart + item.timeoutHandle._idleTimeout - Date.now()) / 60000)} minutes`
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
function userHasSlot(sender){
  return parkingSlots.find(
    (slot) => slot.phone === sender && slot.status !== "available"
  );
}

//Returns the index of the the user is in the waiting list
function userHasWL(sender){
  return (waitingList.findIndex(
    (user) => user.phone === sender
  ));
}



async function handleCancelList(sender){
  //Check if the user has a reservation or a slot/waiting list
  const user_id = await searchUserId(sender);
  const reservationFlag = await hasReservation(user_id);
  const userInWaitingIndex = userHasWL(sender);
  const userInSlots = userHasSlot(sender);

  let messageNum = "0";
  if(userInSlots){
    const slot = parkingSlots.find((slot) => slot.phone === sender);
    messageNum = `slot ${slot.number}`;
  }else if (userInWaitingIndex > -1){
    messageNum = `WL ${userInWaitingIndex + 1}`;
  }

  // If the user has a reservation and has a slot/waiting list, cancel the reservation
  if(reservationFlag && (userInSlots || userInWaitingIndex > -1)){

    sendCancelList(sender, messageNum);
  }else if(reservationFlag){
    sendCancelReservation(sender);
  }else if (userInSlots || userInWaitingIndex > -1){
    sendReleaseSlotWL(sender, messageNum);
  }else{
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
    sendWhatsAppMessage(
      sender,
      "You don't have a reservation for tomorrow."
    );
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
    slot.assignedTo = slot.assignedTo.replace(' (Pending)', '') || name; //Assign name only if it's empty (waiting list)
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
function assignmentFlag(){
  const localTime = getLocalTime().toFormat('dd/MM/yyyy');

  
  return localTime !== parkingDate //if they are the same, it means that /excel-data didn't run yet
}


// Function to handle ping to shared parking slots
function handleSlotPing(sender, name) {

  const localTime = getLocalTime().toFormat('dd/MM/yyyy');

  let slots = parkingSlots
  
  const runFlag = assignmentFlag();

  if(runFlag){ //if they are the same, it means that /excel-data didn't run yet
      if (fs.existsSync(yesterday_FILE_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(yesterday_FILE_PATH, 'utf-8'));
      
      slots = data?.parkingSlots
      
    } catch (error) {
      console.error('Error reading parking data file:', error);
    }
    }
  }

  const slot = slots.find(
    (slot) => slot.phone === sender && slot.status === "assigned"
  );  

  if (slot) {
    // List of shared slots
    const sharedSlots = [569, 570, 571, 572, 573, 574, 575, 576];
    
    if (sharedSlots.includes(slot.number)) {
      // Determine the paired slot
      const pairSlotNumber = slot.number % 2 === 0 ? slot.number - 1 : slot.number + 1;

      const pairSlot = slots.find(
        (slot) => slot.number === pairSlotNumber
      );

      sendWhatsAppMessage(sender, `We've notified ${pairSlot.assignedTo} to move their car.`);
      
      pingPair(to = pairSlot.phone, slot.assignedTo, slot.number);
      logActionToDB(sender,  `Checked shared slot ${slot.number} (Pair: ${pairSlotNumber})`);
    } else {
      sendWhatsAppMessage(sender, `You are in slot ${slot.number}, which is not a shared slot.`);
      logActionToDB(sender, `Checked non-shared slot ${slot.number}`);
    }
  } else {
    sendWhatsAppMessage(sender, "You don't have any slot assigned.");
    logActionToDB(sender,  "Attempted to check slot but has no assignment.");
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
  return res
  .status(200)
  .json({ message: receivedSlots });

});


// Endpoint to refresh logs on excel
app.post('/refresh_logs', (req, res) => {
  
  const lineParam = req.body.line;

  if (!lineParam || isNaN(lineParam)) {
    return res.status(400).json({ error: 'Missing or invalid "line" parameter' });
  }

  const startLine = parseInt(lineParam, 10);
  const filePath = path.join(__dirname, LOG_FILE);

  try {
    const allLines = fs.readFileSync(filePath, 'utf8').split('\n');

    const totalLines = allLines.length;
    
    // Remove trailing blank line at end if present
    while (allLines.length && allLines[allLines.length - 1].trim() === '') {
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
      nextLineNumber: validTotal
    });
  } catch (err) {
    res.status(500).json({ error: 'Error reading the log file' });
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

  // Ensure slot 60 is included with the assigned values if it's not in receivedSlots
  if (!parkingSlots.some(slot => slot.number === 60)) {
    parkingSlots.push({
      number: 60,
      status: "assigned",
      assignedTo: "Ramses de la Rosa",
      phone: "whatsapp:+5491169691511",
      timeoutHandle: null,
      timeoutDate: null,
    });
  }

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
    const result = await pool.query('SELECT date FROM holidays');
    const holidays = result.rows.map(row => {
      return DateTime.fromJSDate(row.date).toFormat('dd/MM/yyyy');
    });
    return new Set(holidays);
  } catch (err) {
    console.error('Error fetching holidays from DB:', err);
    throw err;
  }
}

async function getNextWorkday() {
  const localTime = getLocalTime();
  let nextDay = localTime.plus({ days: 1 }); // Start from the next day

  const holidays = await getHolidays();

  while (
      nextDay.isWeekend ||
      holidays.has(nextDay.toFormat('dd/MM/yyyy')) // Check if it's a holiday
  ) {
      nextDay = nextDay.plus({ days: 1 }); // Move to the next day
  }

  return nextDay.toFormat('dd/MM/yyyy');
}

async function isTodayHoliday() {
  const today = getLocalTime().toFormat('dd/MM/yyyy');
  const holidays = await getHolidays();
  return holidays.has(today);
}

async function isTodayWorkday() {
  const localTime = getLocalTime();
  const isHoliday = await isTodayHoliday();

  const isWorkday = localTime.weekday !== 6 && localTime.weekday !== 0 && !isHoliday;

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
  if(!todayBool){    
    const receivedData = await assignSlots(false);
    console.log("Assignments from db:", receivedData);

    saveParkingData(yesterday_FILE_PATH); //saving today's file 

    // Create a new Date object based on localTime and add one day
    parkingDate = await getNextWorkday(); //changing the date to tomorrow since new assignations are placed

    // Clear all existing timeouts
    parkingSlots.forEach((slot) => {
      if (slot.number === 60) {
        slot.status= "assigned"
        slot.assignedTo= "Ramses de la Rosa"
        slot.phone= "whatsapp:+5491169691511"
        slot.timeoutHandle= null
        slot.timeoutDate = null;
        return; // Skip this slot
      }
      if (slot.timeoutHandle) {
        clearTimeout(slot.timeoutHandle);
        slot.timeoutHandle = null;
      }
      slot.status = "available";
      slot.assignedTo = null;
      slot.phone = null;
      slot.timeoutDate = null;
    }); 

    waitingList = [];

    receivedData.forEach((item) => {
      const person = item.name;
      const slotNumber =
        item.slot === "WL" ? null : parseInt(item.slot, 10);
      const phone = `whatsapp:${item.phone}`;

      if (item.slot === "WL") {
        waitingList.push({ name: person, phone });
        console.log(`${person} is in the waiting list.`);
        logActionToDB(phone, "Added to waiting list via /excel-data");
      } else if (slotNumber) {
        const slot = parkingSlots.find((s) => s.number === slotNumber);
        if (slot) {
          slot.status = "pending";
          slot.assignedTo = person;
          slot.phone = phone;
          console.log(`${person} has parking slot ${slot.number}.`);
          logActionToDB(
            phone,
            `Assigned slot ${slot.number} via /excel-data`
          );

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
  }else {
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
      return res.status(200).json({ message: "Today is a holiday. No reminders sent." });
    }

    // Only send reminders to assigned slots (not slot 60, and only if phone exists)
    const assignedPhones = parkingSlots
      .filter(slot => slot.number !== 60 && slot.status === "assigned" && slot.phone)
      .map(slot => slot.phone);

    if (assignedPhones.length === 0) {
      return res.status(200).json({ message: "No assigned slots to send reminders." });
    }

    // Send reminders in parallel
    await Promise.all(assignedPhones.map(phone => sendReminder(phone)));

    res.status(200).json({ message: `Reminders sent to ${assignedPhones.length} users.` });
  } catch (error) {
    console.error("Error sending reminders:", error);
    res.status(500).json({ message: "Failed to send reminders." });
  }
});




// Endpoint to receive data from Excel macro
app.post("/excel-data", async (req, res) => {
  const todayBool = await isTodayHoliday();
  if(!todayBool){    
    const receivedData = req.body;
    
    saveParkingData(yesterday_FILE_PATH); //saving today's file 

    // Create a new Date object based on localTime and add one day
    parkingDate = await getNextWorkday(); //changing the date to tomorrow since new assignations are placed

    // Clear all existing timeouts
    parkingSlots.forEach((slot) => {
      if (slot.number === 60) {
        slot.status= "assigned"
        slot.assignedTo= "Ramses de la Rosa"
        slot.phone= "whatsapp:+5491169691511"
        slot.timeoutHandle= null
        slot.timeoutDate = null;
        return; // Skip this slot
      }
      if (slot.timeoutHandle) {
        clearTimeout(slot.timeoutHandle);
        slot.timeoutHandle = null;
      }
      slot.status = "available";
      slot.assignedTo = null;
      slot.phone = null;
      slot.timeoutDate = null;
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
        if (slot) {
          slot.status = "pending";
          slot.assignedTo = person;
          slot.phone = phone;
          console.log(`${person} has parking slot ${slot.number}.`);
          logActionToDB(
            phone,
            `Assigned slot ${slot.number} via /excel-data`
          );

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
  }else {
    res.status(200).send("Skipping day, today is holiday");
  }
  
});

async function writeTable(users, res){
  try {
    // Loop through each user and insert into the database
    for (const user of users) {
      const { name, phone, date_of_hire, priority } = user;

      // Insert query to add the user into the "roster" table
      const query = `
        INSERT INTO roster (name, phone, date_of_hire, priority)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (name) DO UPDATE 
        SET phone = EXCLUDED.phone, 
            date_of_hire = EXCLUDED.date_of_hire,
            priority = EXCLUDED.priority;
      `;

      // Execute the query
      await pool.query(query, [name, phone, date_of_hire, priority]);

    }

    // Respond with a success message
    return res.status(200).json({ message: "Roster updated successfully." });
  } catch (error) {
    console.error("Error updating roster:", error);
    return res.status(500).json({ message: "Failed to update roster.", error: error.message });
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
          return res.status(400).json({ message: "Missing required parameters: user_id, latitude, or longitude." });
        }

        // For demonstration purposes, log the data
        console.log(`User ID: ${user_id}, Latitude: ${latitude}, Longitude: ${longitude}`);

        res.status(200).json({ message: "Location received successfully." });
    } catch (error) {
        console.error("Error saving parking data:", error);
        res.status(500).send("Error saving parking data");
    }
});


// API route to get data from PostgreSQL
app.get('/today_assignments', async (req, res) => {
  try {
    const assignments = await assignSlots(true);
    res.json(assignments);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});


// API route to get last cancellations from PostgreSQL
app.get('/last_cancellations', async (req, res) => {
  try {
    const cancellations = await getViews('last_cancellations');
    res.status(200).json(cancellations);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// API route to get top cancellers from PostgreSQL
app.get('/top_cancellers', async (req, res) => {
  try {
    const cancellations = await getViews('top_cancellers');
    res.status(200).json(cancellations);
  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Endpoint: returns both today's and yesterday's parking data
app.get('/parking-data', async (req, res) => {
  try {
    // use your constants here
    const [todayRaw, yesterdayRaw] = await Promise.all([
      fs.readFileSync(DATA_FILE_PATH, 'utf8'),
      fs.readFileSync(yesterday_FILE_PATH, 'utf8'),
    ]);

    const today = JSON.parse(todayRaw);
    const yesterday = JSON.parse(yesterdayRaw);

    res.json({ today, yesterday });
  } catch (err) {
    console.error('Failed to load parking data:', err);
    res.status(500).json({ message: 'Error loading parking data' });
  }
});

// Endpoint to update the user roster data
app.post("/update-roster", async (req, res) => {
  console.log("Received request to update roster");
  const users = req.body;

  if (!Array.isArray(users) || users.length === 0) {
    console.log("Invalid request: request body must contain a list of users.");
    return res.status(400).json({ message: "Request body must contain a list of users." });
  }

  csvData = users.map(user => ({
    name: user.name || "",
    phone: user.phone || "",
    date_of_hire: user.date_of_hire || "",
    priority: user.priority || ""
  }));

  await writeTable(csvData, res);

});



// Endpoint to update the holidays
app.post("/update-holidays", (req, res) => {
  console.log("Received request to update the holidays list");
  const holidays = req.body;

  if (!Array.isArray(holidays) || holidays.length === 0) {
    console.log("Invalid request: request body must contain a list of holidays.");
    return res.status(400).json({ message: "Request body must contain a list of holidays." });
  }

  holidaysData = holidays.map(user => ({
    date: user.date || "",
    description: user.description || ""
  }));

  saveHolidays(holidaysData, res);

});



// Twilio send message helper without interactive buttons
async function sendWhatsAppMessage(to, message) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  try {
    const sentMessage = await client.messages.create({
      body: message,
      from: twilioNumber,
      to: to,
    });
    
  } catch (error) {
    console.error("Error sending message:", error);
  }
}

async function sendReminder(to){
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX03b40419642af21c89b1d33546a5d7ba";

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      timeout: 5000
    })
    .catch((error) => console.error("Error sending message:", error));
}


function sendTimeoutMessage(to, slot){
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
      timeout: 5000
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
      timeout: 5000
    })
    .catch((error) => console.error("Error sending message:", error));
}

function pingPair(to , assignedTo, number){
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HX782c2ad7292677c969d75720ed1e3d69";
  const variables = { 1: assignedTo, 2: String(number)};
  const variablesJson = JSON.stringify(variables);
  
  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000
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
      timeout: 5000
    })
    .catch((error) => console.error("Error sending message:", error));
}


function sendMessageWithButtonsFromBusiness(to, slot) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  console.log("Sending with busines initiated message")
  const template_id = "HX1d2fbc51c4b8e5ba8612845e810b0bb6"; // Ensure this template ID is correct and approved
  
  const variables = { 1: `${slot.number}` };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000
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
      timeout: 5000
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
      timeout: 5000
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
      timeout: 5000
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
  const date = `${(today.getMonth() + 1).toString().padStart(2, '0')}/${today.getDate().toString().padStart(2, '0')}/${today.getFullYear()}`;
  
  const template_id = "HX302373474c5815892d054e92aec7e64b";
  const variables = { 1: date };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000
    })
    .catch((error) => console.error("Error sending date template message:", error));
}

// Start the server and ngrok
// app.listen(port, () =>
//   console.log(`Node.js web server at http://localhost:${port} is running...`)
// );

app.listen(port,'0.0.0.0', () =>
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
