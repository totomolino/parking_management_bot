const express = require("express");
const bodyParser = require("body-parser");
const twilio = require("twilio");
const cors = require("cors");
const ngrok = require("@ngrok/ngrok");
require("dotenv").config(); // Load environment variables from .env file

const app = express();
const port = 3000;

// Middleware setup
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); // Middleware to parse JSON body
app.use(cors()); // Enable CORS

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
  841, // Corrected duplicate 840 to 841
  ...Array.from({ length: 10 }, (_, i) => 585 + i), // 585 to 594
  ...Array.from({ length: 8 }, (_, i) => 569 + i), // 569 to 576
].map((slotNumber) => ({
  number: slotNumber,
  status: "available", // possible statuses: 'available', 'pending', 'assigned'
  assignedTo: null,
  phone: null,
}));

// In-memory storage
let parkingSlots = [...initialSlots];
let waitingList = [];

// Predefined buttons for interactive messages
const buttons = [
  { id: "button_accept", title: "Accept" },
  { id: "button_decline", title: "Decline" },
];

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
  const name = req.body.ProfileName;

  switch (true) {
    case messageBody === "add me":
      handleAddMe(sender, name);
      break;
    case messageBody === "show all":
      handleShowAll(sender);
      break;
    case messageBody === "show parking":
      handleShowParking(sender);
      break;
    case messageBody === "show waiting list":
      handleShowWaitingList(sender);
      break;
    case messageBody === "cancel":
      handleCancel(sender);
      break;
    case messageBody === "accept":
      handleSlotAccept(sender, name);
      break;
    case messageBody === "decline":
      handleSlotDecline(sender);
      break;
    case messageBody === "release":
      handleSlotDecline(parkingSlots[0].phone);
      break;
    default:
      sendWhatsAppMessage(
        sender,
        "Unknown command. Please use 'Add me', 'Show all', 'Show parking', 'Show waiting list', 'Cancel', 'Accept', or 'Decline'."
      );
  }
});

// Function to assign the next available slot to the first person in the waiting list
function assignNextSlot() {
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
  waitingList.splice(0, 1); //removing the first from waiting list
  availableSlot.status = "pending";
  availableSlot.assignedTo = nextPerson.name + " (Pending)";
  availableSlot.phone = nextPerson.phone;

  // Notify the user with interactive buttons
  sendMessageWithButtons(
    nextPerson.phone,
    `A parking slot is available!\nPlease confirm if you want parking slot *${availableSlot.number}*.`
  );
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
    return;
  }

  if (userInWaiting) {
    sendWhatsAppMessage(
      sender,
      `You're already on the waiting list at position ${
        waitingList.indexOf(userInWaiting) + 1
      }.`
    );
    return;
  }

  // Check for available slot
  const availableSlot = parkingSlots.find(
    (slot) => slot.status === "available"
  );
  if (availableSlot) {
    // Assign slot immediately
    availableSlot.status = "pending";
    availableSlot.assignedTo = name;
    availableSlot.phone = sender;
    sendMessageWithButtons(
      sender,
      `A parking slot is available!\nPlease confirm if you want parking slot *${availableSlot.number}*.`
    );
  } else {
    // Add to waiting list
    waitingList.push({ name, phone: sender });
    sendWhatsAppMessage(
      sender,
      "No available parking slots at the moment. You've been added to the waiting list."
    );

    // Optionally notify the next slot availability
    assignNextSlot();
  }
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
function handleCancel(sender) {
  const userInWaitingIndex = waitingList.findIndex(
    (user) => user.phone === sender
  );
  const userInSlots = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status !== "available"
  );

  if (userInWaitingIndex > -1) {
    waitingList.splice(userInWaitingIndex, 1);
    sendWhatsAppMessage(sender, "You've been removed from the waiting list.");
    assignNextSlot();
    return;
  }

  if (userInSlots) {
    const slot = parkingSlots.find((slot) => slot.phone === sender);
    slot.status = "available";
    slot.assignedTo = null;
    slot.phone = null;
    sendWhatsAppMessage(sender, `You've released parking slot ${slot.number}.`);
    assignNextSlot();
    return;
  }

  sendWhatsAppMessage(
    sender,
    "You're neither on the waiting list nor assigned to any parking slot."
  );
}

// Function to handle acceptance of a parking slot
function handleSlotAccept(sender, name) {
  const slot = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status === "pending"
  );

  if (slot) {
    slot.status = "assigned";
    slot.assignedTo = name;
    sendWhatsAppMessage(
      sender,
      `Congratulations! You've been assigned parking slot ${slot.number}.`
    );
    waitingList = waitingList.filter((user) => user.phone !== sender);
    console.log(`Slot ${slot.number} assigned to ${slot.assignedTo}.`);

    // Optionally, assign another slot if available
    assignNextSlot();
  } else {
    sendWhatsAppMessage(sender, "You don't have any pending slot assignments.");
  }
}

// Function to handle declination of a parking slot
function handleSlotDecline(sender) {
  const slot = parkingSlots.find(
    (slot) => slot.phone === sender && slot.status === "pending"
  );

  if (slot) {
    slot.status = "available";
    slot.assignedTo = null;
    slot.phone = null;
    sendWhatsAppMessage(
      sender,
      `You've declined parking slot ${slot.number}. The slot is now available for others.`
    );
    assignNextSlot();
  } else {
    sendWhatsAppMessage(
      sender,
      "You don't have any pending slot assignments to decline."
    );
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

  // Reset parking slots based on received data
  parkingSlots = receivedSlots.map((slotNumber) => ({
    number: slotNumber,
    status: "available",
    assignedTo: null,
    phone: null,
  }));

  waitingList = []; // Reset waiting list

  console.log("The parking slots have been reset: ", parkingSlots);

  res.status(200).send("Parking slots have been reset successfully.");
});

// Endpoint to receive data from Excel macro
app.post("/excel-data", (req, res) => {
  const receivedData = req.body;
  console.log("Data received from Excel:", receivedData);

  // Reset parking slots based on received data
  parkingSlots.forEach((slot) => {
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
    } else if (slotNumber) {
      const slot = parkingSlots.find((s) => s.number === slotNumber);
      if (slot) {
        slot.status = "pending";
        slot.assignedTo = person;
        slot.phone = phone;
        console.log(`${person} has parking slot ${slot.number}.`);

        // Notify the assigned user
        sendMessageWithButtons(
          phone,
          `You have been assigned to parking slot ${slot.number}.`
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
      const waitingListMessage = `You are on the waiting list:\n${waitingList
        .map((m, index) => {
          return `${index + 1}. ${m.name}${index === i ? " (you)" : ""}`;
        })
        .join("\n")}`;

      // Send a WhatsApp message to each waiting list member with their order
      sendWhatsAppMessage(member.phone, waitingListMessage);
    });
  }

  res.status(200).send("Excel data processed successfully.");
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
      from: "whatsapp:+14155238886",
      to: to,
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
  const template_id = "HX11c138027519a9b312f9d550da94d35e"; // Ensure this template ID is correct and approved

  const variables = { 1: message };
  const variablesJson = JSON.stringify(variables);

  client.messages
    .create({
      from: "whatsapp:+14155238886",
      to: to,
      contentSid: template_id,
      contentVariables: variablesJson,
    })
    .then((message) => console.log("Message sent:", message.body))
    .catch((error) => console.error("Error sending message:", error));
}

// Start the server and ngrok
app.listen(port, () =>
  console.log(`Node.js web server at http://localhost:${port} is running...`)
);

// Get your endpoint online with ngrok
ngrok
  .connect({
    addr: port,
    authtoken: process.env.NGROK_AUTHTOKEN,
    domain: "upward-gull-dear.ngrok-free.app",
  })
  .then((listener) => {
    console.log(`Ingress established at: ${listener.url()}`);
    // Here you can set up your Twilio webhook URL with the ngrok URL
  })
  .catch((error) => {
    console.error("Error connecting ngrok:", error);
  });
