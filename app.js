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
function readCSV() {
  fs.createReadStream(filePath)
    .pipe(csvParser()) // Define column headers
    .on('data', (row) => {
      csvData.push(row);
    })
    .on('end', () => {
      console.log('CSV file successfully processed');
    });
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
function saveHolidays(data, res) {
  // Add headers to CSV
  const headers = "date,description\n";
  const updatedCSV = headers + data.map((row) => `${row.date},${row.description}`).join('\n');
  fs.writeFile(holidaysFilePath, updatedCSV, (err) => {
    if (err) {
      console.error("Error writing holidays CSV file:", err);
      return res.status(500).json({ message: "Failed to update holidays CSV file." });
    }
    res.status(200).json({ message: "holidays CSV file updated successfully." });
  });
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
    allowedHeaders: ['Content-Type']
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
  logActionToDB(userPhone, userName, action); // Log to database as well
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
let parkingDate = restoredData?.parkingDate || getLocalTime().toLocaleDateString('en-GB');


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
  const parkingSlotWidth = 15; // Width for Parking Slot column
  const personWidth = 20; // Width for Person column

  // Header for parking slot table
  let table =
    "Parking Slot".padEnd(parkingSlotWidth) +
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
app.post("/whatsapp", (req, res) => {
  const messageBody = req.body.Body.trim().toLowerCase();
  const sender = req.body.From; // WhatsApp number
  // const name = req.body.ProfileName;
  
  const entry = csvData.find((row) => row.phone ===  sender.replace("whatsapp:", ""));

  const name = entry ? entry.name : sender;

  // Check if the sender is not found in csvData
  if (!entry) {
    sendWhatsAppMessage(
      sender,
      "It looks like your number is not logged in the forms.\nPlease fill https://forms.office.com/r/0scGm4w6s9 and contact Ceci or Majo."
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
      handleCancel(sender, name);
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
      const messageSid = req.body.MessageSid;
      const client = new twilio(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      client.messages(messageSid)
        .fetch()
        .then(message => {
          // Use Luxon to handle the timestamp properly
          const argentinaTime = DateTime.fromJSDate(new Date(message.dateSent))
            .setZone('America/Argentina/Buenos_Aires')
            .toFormat('yyyy-MM-dd HH:mm:ss');

          // Now pass the Argentina timestamp to handleReserve
          handleReserve(sender, name, argentinaTime);
        })
        .catch(err => {
          console.error("Failed to get Twilio timestamp, calculating timestamp", err);
          const fallbackTime = DateTime.now()
            .setZone('America/Argentina/Buenos_Aires')
            .toFormat('yyyy-MM-dd HH:mm:ss');
          handleReserve(sender, name, fallbackTime);
        });
      break;
    case messageBody === "test_new":
      handleTestNew(sender, name);
      break;
    case messageBody === "daycheck":
      sendWhatsAppMessage(
        sender,
        `Next bussines day is: ${getNextWorkday().toString()}, today is holiday? ${isTodayHoliday()}`
      );
      break;
    case messageBody === "help":
      sendWhatsAppMessage(
        sender,
        "Commands: 'Add me', 'Show all', 'Show parking', 'Show waiting list', 'Cancel'."
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

function handleReserve(sender, name, timestamp) {


  sendWhatsAppMessage(sender,`You are ${name} and you reserved at ${timestamp}`);
};



function getLocalTime(){
  const now = new Date();
  const options = {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: false
  };
  // Get the current hour in Argentina time
  const localDateTime = new Intl.DateTimeFormat('en-US', options).format(now);
  const [currentHour, currentMinute, currentSecond] = localDateTime.split(':').map(Number);

  // Create a local time date object
  const localTime = new Date(now.getTime() - (3 * 60 * 60 * 1000)); // Adjust for GMT-3
  localTime.setHours(currentHour, currentMinute, currentSecond, 0); // Set to local time
  return localTime;

}

// Helper function to calculate timeout with overnight pause
function calculateTimeoutDuration(timeoutDuration) {

  // Create a local time date object
  const localTime = getLocalTime();

  let nextDay7am = new Date(localTime); // Clone the current date

  let finalDelay = timeoutDuration;

  const currentHour = localTime.getHours(); // Extract the current hour (0–23)

  // If current time is after 10 PM or before 7 AM, set the target for the next day
  if (currentHour >= 22 || currentHour < 7) {
      // Set the target time to 7:10 AM on the correct day
      nextDay7am.setHours(7, 10, 0, 0); // Set to 7:10 AM in the local timezone
    
      // Adjust the date correctly:
      if (currentHour >= 22) {
        nextDay7am.setDate(localTime.getDate() + 1);
      }

      // Calculate the delay in milliseconds
      finalDelay = nextDay7am - localTime;      
  }
 

  console.log(`Current Time: ${localTime}`);
  console.log(`Next 7:10 AM: ${nextDay7am}`);
  console.log(`Overnight Delay: ${finalDelay}`);

  return finalDelay; // Return the delay
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
  
  // Save the timeout date as a string in ISO format
  const timeoutDate = new Date(getLocalTime().getTime() + adjustedTimeout);
  slot.timeoutDate = timeoutDate.toISOString(); // Save as string
  
  // Set up the timeout
  slot.timeoutHandle = setTimeout(() => {
    // Check if the slot is still pending
    if (slot.status === "pending" && slot.phone === user.phone) {
      console.log(
        `User ${user.phone} did not respond in time. Releasing slot ${slot.number}.`
      );
      logAction(user.phone, user.name, `Timeout for slot ${slot.number}`);

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
    console.log(slot);
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

  logAction(
    nextPerson.phone,
    nextPerson.name,
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
    logAction(
      sender,
      name,
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
    logAction(
      sender,
      name,
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
    logAction(sender, name, `Added and assigned slot ${availableSlot.number}`);
  } else {
    // Add to waiting list
    waitingList.push({ name, phone: sender });
    sendWhatsAppMessage(
      sender,
      "No available parking slots at the moment. You've been added to the waiting list."
    );
    logAction(sender, name, `Added to waiting list`);

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

  // message += `\n${generateParkingSlotTable()}`;
  message += "```" + "\n" + generateParkingSlotTable() + "```";

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

  console.log(message);
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
    logAction(
      sender,
      name,
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
    logAction(sender, name, `Canceled and released slot ${slot.number}`);
    assignNextSlot();
    return;
  }

  sendWhatsAppMessage(
    sender,
    "You're neither on the waiting list nor assigned to any parking slot."
  );
  logAction(
    sender,
    name,
    `Attempted to cancel but not found in slots or waiting list`
  );
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
    logAction(sender, name, `Accepted and assigned slot ${slot.number}`);
    console.log(`Slot ${slot.number} assigned to ${slot.assignedTo}.`);

    // Optionally, assign another slot if available
    assignNextSlot();
  } else {
    sendWhatsAppMessage(sender, "You don't have any pending slot assignments.");
    logAction(sender, name, `Attempted to accept but no pending assignments`);
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
    logAction(sender, name, `Declined slot ${slot.number}`);
    assignNextSlot();
  } else {
    sendWhatsAppMessage(
      sender,
      "You don't have any pending slot assignments to decline."
    );
    logAction(sender, name, `Attempted to decline but no pending assignments`);
  }
}


// Function to handle ping to shared parking slots
function handleSlotPing(sender, name) {

  const localTime = getLocalTime().toLocaleDateString('en-GB');

  let slots = parkingSlots

  console.log(`local time: ${localTime}, parkingDate: ${parkingDate}`);

  if(localTime !== parkingDate){ //if they are the same, it means that /excel-data didn't run yet
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
      logAction(sender, name, `Checked shared slot ${slot.number} (Pair: ${pairSlotNumber})`);
    } else {
      sendWhatsAppMessage(sender, `You are in slot ${slot.number}, which is not a shared slot.`);
      logAction(sender, name, `Checked non-shared slot ${slot.number}`);
    }
  } else {
    sendWhatsAppMessage(sender, "You don't have any slot assigned.");
    logAction(sender, name, "Attempted to check slot but has no assignment.");
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
  console.log("Received refresh_logs request with param:", req.body.line);
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
  logAction(
    "SYSTEM",
    "SYSTEM",
    "Parking slots have been reset via /parking_slots endpoint"
  );

  res.status(200).send("Parking slots have been reset successfully.");
});

// Read holiday dates from CSV
function getHolidays() {
  const filePath = path.resolve(holidaysFilePath);
  const data = fs.readFileSync(filePath, 'utf8');
  const lines = data.split('\n').slice(1); // Skip header
  const holidays = lines.map(line => line.split(',')[0].trim()); // Extract dates
  return new Set(holidays);
}

function getNextWorkday() {
  const localTime = getLocalTime();
  let nextDay = new Date(localTime);
  nextDay.setDate(nextDay.getDate() + 1); // Start from the next day

  const holidays = getHolidays();

  while (
      nextDay.getDay() === 6 || // Saturday
      nextDay.getDay() === 0 || // Sunday
      holidays.has(nextDay.toLocaleDateString('en-GB')) // Check if it's a holiday
  ) {
      nextDay.setDate(nextDay.getDate() + 1); // Move to the next day
  }

  return nextDay.toLocaleDateString('en-GB');
}

function isTodayHoliday() {
  const today = getLocalTime().toLocaleDateString('en-GB');
  const holidays = getHolidays();
  return holidays.has(today);
}

// Endpoint to receive data from Excel macro
app.post("/excel-data", (req, res) => {
  
  if(!isTodayHoliday()){    
    const receivedData = req.body;
    console.log("Data received from Excel:", receivedData);

    saveParkingData(yesterday_FILE_PATH); //saving today's file 

    // Create a new Date object based on localTime and add one day
    parkingDate = getNextWorkday(); //changing the date to tomorrow since new assignations are placed

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
        logAction(phone, person, "Added to waiting list via /excel-data");
      } else if (slotNumber) {
        const slot = parkingSlots.find((s) => s.number === slotNumber);
        if (slot) {
          slot.status = "pending";
          slot.assignedTo = person;
          slot.phone = phone;
          console.log(`${person} has parking slot ${slot.number}.`);
          logAction(
            phone,
            person,
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
        logAction(
          member.phone,
          member.name,
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
      const score = 10; // Fixed score for now

      // Insert query to add the user into the "roster" table
      const query = `
        INSERT INTO roster (name, phone, date_of_hire, priority, score)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (name) DO UPDATE 
        SET phone = EXCLUDED.phone, 
            date_of_hire = EXCLUDED.date_of_hire,
            priority = EXCLUDED.priority,
            score = EXCLUDED.score;
      `;

      // Execute the query
      await pool.query(query, [name, phone, date_of_hire, priority, score]);

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

  writeCSV(csvData, res);

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

    console.log("Message sent:", sentMessage.body, "to", to);
  } catch (error) {
    console.error("Error sending message:", error);
  }
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
    .then((message) => console.log("Message sent:", message.body))
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
    .then((message) => console.log("Message sent:", message.body, "to", to))
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
  console.log(`Pinging ${variablesJson}`)
  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000
    })
    .then((message) => console.log("Message sent:", message.body, "to", to))
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
    .then((message) => console.log("Message sent:", message.body))
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

  console.log(variables, variablesJson)

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000
    })
    .then((message) => console.log("Message sent:", message.body))
    .catch((error) => console.error("Error sending message:", error));
}

function sendCancelList(to, slot) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HXcb161f09ec74224ebe94587318c9bd19"; // Ensure this template ID is correct and approved
  
  // const variables = { 1: `${slot.number}` };
  const variables = { 1: `${slot}` };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: twilioNumber,
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
      timeout: 5000
    })
    .then((message) => console.log("Message sent:", message.body))
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
    .then((message) => console.log("Date template message sent:", message.body, "to", to))
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
