const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const cors = require("cors");
const ngrok = require("@ngrok/ngrok");
const fs = require("fs"); // Import fs module for logging
require("dotenv").config(); // Load environment variables from .env file
const csvParser = require('csv-parser');
const { createCanvas, loadImage } = require('canvas');

const filePath = './roster.csv'; // Path to your CSV file
const imagePath = 'original_image.jpg';
const outputPath = 'modified_image.jpg';

let csvData = []; // In-memory storage for CSV data
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
  const headers = "name,phone,priority\n";
  const updatedCSV = headers + data.map((row) => `${row.name},${row.phone},${row.priority}`).join('\n');
  fs.writeFile(filePath, updatedCSV, (err) => {
    if (err) {
      console.error("Error writing CSV file:", err);
      return res.status(500).json({ message: "Failed to update CSV file." });
    }
    res.status(200).json({ message: "CSV file updated successfully." });
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
    methods: ['POST', 'OPTIONS'],
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
}));

// Add slot 60 with pre-assigned values
initialSlots.push({
  number: 60,
  status: "assigned",
  assignedTo: "Ramses de la Rosa",
  phone: "whatsapp:+5491169691511",
  timeoutHandle: null,
});

// In-memory storage
let parkingSlots = [...initialSlots];
let waitingList = [];


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
    return res.status(200).send("OK");
  }
  

  switch (true) {
    case messageBody === "add me":
      handleAddMe(sender, name);
      break;
    case messageBody === "show all":
      handleShowAll(sender);
      break;
    case messageBody === "show image":
      handleShowImage(sender);
      break;
    case messageBody === "show parking":
      handleShowParking(sender);
      break;
    case messageBody === "show timeouts":
      handleShowTimeouts(sender);
      break;
    case messageBody === "show waiting list":
      handleShowWaitingList(sender);
      break;
    case messageBody === "cancel":
      handleCancel(sender, name);
      break;
    case messageBody === "accept":
      handleSlotAccept(sender, name);
      break;
    case messageBody === "decline":
      handleSlotDecline(sender, name);
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

  res.status(200).send("OK"); // Respond to Twilio immediately
});

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
      nextDay7am.setDate(localTime.getDate() + 1); // Move to the next day

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
    sendMessageWithButtons(user.phone, message);
  }

  // Calculate adjusted timeout duration
  const adjustedTimeout = calculateTimeoutDuration(timeoutDuration);

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

      // Notify the user about timeout (optional)
      sendWhatsAppMessage(
        user.phone,
        `You did not respond in time for parking slot ${slot.number}. The slot is now available for others.`
      );

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
function handleShowAll(sender) {
  const userInSlots = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status !== "available"
  );
  const userInWaiting = waitingList.find((user) => user.phone === sender);

  let message = "";

  if (userInSlots) {
    const slot = parkingSlots.find((slot) => slot.phone === sender);
    message += `You are assigned to parking slot *${slot.number}*.\n`;
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

  message += `\n\n${generateFullTable()}`;

  sendWhatsAppMessage(sender, message);
}

// Function to handle the 'show parking' command
function handleShowParking(sender) {
  const userInSlots = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status !== "available"
  );
  const userInWaiting = waitingList.find((user) => user.phone === sender);

  let message = "";

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

  message += `\n\n${generateParkingSlotTable()}`;

  sendWhatsAppMessage(sender, message);
}

// Function to handle the 'show parking' command
function handleShowTimeouts(sender) {
  let message = "Slot|Person|Timeout\n";
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
function handleShowWaitingList(sender) {
  const userInWaiting = waitingList.find((user) => user.phone === sender);

  let message = "";

  if (userInWaiting) {
    message += `You are on the waiting list at position ${
      waitingList.indexOf(userInWaiting) + 1
    }.\n`;
  } else {
    message += "You are not on the waiting list.\n";
  }

  message += `\n${generateWaitingListTable()}`;

  sendWhatsAppMessage(sender, message);
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

    sendWhatsAppMessage(
      sender,
      `Congratulations! You've been assigned parking slot ${slot.number}.`
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
  }));

  // Ensure slot 60 is included with the assigned values if it's not in receivedSlots
  if (!parkingSlots.some(slot => slot.number === 60)) {
    parkingSlots.push({
      number: 60,
      status: "assigned",
      assignedTo: "Ramses de la Rosa",
      phone: "whatsapp:+5491169691511",
      timeoutHandle: null,
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

// Endpoint to receive data from Excel macro
app.post("/excel-data", (req, res) => {
  const receivedData = req.body;
  console.log("Data received from Excel:", receivedData);

  // Clear all existing timeouts
  parkingSlots.forEach((slot) => {
    if (slot.number === 60) {
      return; // Skip this slot
    }
    if (slot.timeoutHandle) {
      clearTimeout(slot.timeoutHandle);
      slot.timeoutHandle = null;
    }
    slot.status = "available";
    slot.assignedTo = null;
    slot.phone = null;
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

  res.status(200).send("Excel data processed successfully.");
});

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
app.post("/update-roster", (req, res) => {
  console.log("Received request to update roster");
  const users = req.body;

  if (!Array.isArray(users) || users.length === 0) {
    console.log("Invalid request: request body must contain a list of users.");
    return res.status(400).json({ message: "Request body must contain a list of users." });
  }

  csvData = users.map(user => ({
    name: user.name || "",
    phone: user.phone || "",
    priority: user.priority || ""
  }));

  writeCSV(csvData, res);


});



// Twilio send message helper without interactive buttons
function sendWhatsAppMessage(to, message) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

  client.messages
    .create({
      body: message,
      from: twilioNumber,
      to: to,
      timeout: 5000
    })
    .then((message) => console.log("Message sent:", message.body, "to", to))
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


// Twilio send message helper with interactive buttons (using template messages)
function sendMessageWithButtons(to, message) {
  const client = new twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
  const template_id = "HXba220fcf27481337670220b10c05af90"; // Ensure this template ID is correct and approved
  
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
