const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const cors = require('cors');
require('dotenv').config(); // Load environment variables from .env file

const app = express();
const port = 3000;

// Middleware setup
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); // Middleware to parse JSON body
// Use CORS middleware
app.use(cors());

// Define all parking slots with their initial status
// const allSlots = [
//   832, 834, 835, 836, 837, 838, 839, 840, 841, // Corrected duplicate 840 to 841
//   ...Array.from({ length: 10 }, (_, i) => 585 + i), // 585 to 594
//   ...Array.from({ length: 8 }, (_, i) => 569 + i)  // 569 to 576
// ].map(slotNumber => ({
//   number: slotNumber,
//   status: 'available', // possible statuses: 'available', 'pending', 'assigned'
//   assignedTo: null
// }));

const allSlots = [
  832
].map(slotNumber => ({
  number: slotNumber,
  status: 'available', // possible statuses: 'available', 'pending', 'assigned'
  assignedTo: null,
  phone: null
}));

// In-memory storage
let parkingSlots = [...allSlots];
let waitingList = [];

// Predefined buttons for interactive messages
const buttons = [
  { id: 'button_accept', title: 'Accept' },
  { id: 'button_decline', title: 'Decline' }
];

// Health check endpoint
app.get('/health', (_, res) => {
  res.send('OK');
});

// Wake endpoint to log the current time
app.get('/wake', (_, res) => {
  const date = new Date();
  date.setHours(date.getHours() + 3);
  console.log("Wake App Server: ", date);
  res.send('OK');
});

// Function to generate the parking slot table
function generateParkingSlotTable() {
  const parkingSlotWidth = 15; // Width for Parking Slot column
  const personWidth = 20;      // Width for Person column

  // Header for parking slot table
  let table = 'Parking Slot'.padEnd(parkingSlotWidth) + '| ' + 'Person'.padEnd(personWidth) + '\n';
  table += '-'.repeat(parkingSlotWidth + personWidth + 2) + '\n'; // Separator line

  // Add data rows for parking slot list
  parkingSlots.forEach(item => {
    const parkingSlotString = item.number.toString();
    const parkingSlotPadding = parkingSlotWidth - parkingSlotString.length;
    const parkingSlot = ' '.repeat(Math.floor(parkingSlotPadding / 2)) + parkingSlotString +
                        ' '.repeat(Math.ceil(parkingSlotPadding / 2));

    const person = item.assignedTo.padEnd(personWidth);
    table += `${parkingSlot}| ${person}\n`;
  });

  return table;
}

// Function to generate the waiting list table
function generateWaitingListTable() {
  const indexWidth = 5;        // Width for index column
  const personWidth = 20;      // Width for Person column

  // Header for waiting list table
  let table = 'No.'.padEnd(indexWidth) + '| ' + 'Person'.padEnd(personWidth) + '\n';
  table += '-'.repeat(indexWidth + personWidth + 2) + '\n'; // Separator line

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
  return parkingTable + '\n' + 'Waiting List:\n' + waitingTable;
}

// Handle incoming WhatsApp messages
app.post('/whatsapp', (req, res) => {
  const messageBody = req.body.Body.trim().toLowerCase();
  const sender = req.body.From; // WhatsApp number

  switch (true) {
    case messageBody === 'add me':
      handleAddMe(sender);
      break;
    case messageBody === 'show all':
      sendWhatsAppMessage(sender, `The data is \n${generateFullTable()}`);
      break;
    case messageBody === 'show parking':
      sendWhatsAppMessage(sender, `The data is \n${generateParkingSlotTable()}`);
      break;
    case messageBody === 'show waiting list':
      sendWhatsAppMessage(sender, `The data is \n${generateWaitingListTable()}`);
      break;
    case messageBody === 'cancel':
      handleCancel(sender);
      break;
    case messageBody === 'accept':
      handleSlotAccept(sender);
      break;
    case messageBody === 'decline':
      handleSlotDecline(sender);
      break;
    default:
      sendWhatsAppMessage(sender, "Unknown command. Please use 'Add me', 'Show all', 'Show parking', 'Show waiting list', 'Cancel', 'Accept', or 'Decline'.");
  }

  res.sendStatus(200);  
});

// Function to assign the next available slot to the first person in the waiting list
function assignNextSlot() {
  if (waitingList.length === 0) return;

  // Find the first available slot
  const availableSlot = parkingSlots.find(slot => slot.status === 'available');
  if (!availableSlot) {
    console.log('No available slots at the moment.');
    return;
  }

  // Assign the slot to the first person in the waiting list
  const nextPerson = waitingList[0];
  availableSlot.status = 'pending';
  availableSlot.assignedTo = nextPerson.phone;

  // Notify the user with interactive buttons
  sendWhatsAppMessage2(nextPerson.phone, `A parking slot (${availableSlot.number}) is available. Do you accept it? Reply with 'Accept' or 'Decline'.`);
}

// Function to notify the next person in the waiting list
function notifyAvailability() {
  assignNextSlot();
}

// Handle the 'add me' command
function handleAddMe(sender) {
  if (!waitingList.some(user => user.phone === sender)) {
    // Ideally, retrieve the user's name from a database or ask for it
    const userName = 'User'; // Placeholder: You can enhance this by asking for the user's name
    waitingList.push({ name: userName, phone: sender });
    sendWhatsAppMessage(sender, "You've been added to the waiting list.");

    // If no slots are pending assignment, try assigning
    assignNextSlot();
  } else {
    sendWhatsAppMessage(sender, "You're already on the waiting list.");
  }
}

// Handle the 'cancel' command
function handleCancel(sender) {
  const index = waitingList.findIndex(user => user.phone === sender);
  if (index > -1) {
    waitingList.splice(index, 1);
    sendWhatsAppMessage(sender, "You've been removed from the waiting list.");

    // If the user had a pending slot, free it
    const pendingSlot = parkingSlots.find(slot => slot.assignedTo === sender && slot.status === 'pending');
    if (pendingSlot) {
      pendingSlot.status = 'available';
      pendingSlot.assignedTo = null;
      assignNextSlot();
    }
  } else {
    sendWhatsAppMessage(sender, "You're not on the waiting list.");
  }
}

// Handle acceptance of a parking slot
function handleSlotAccept(sender) {
  const slot = parkingSlots.find(slot => slot.assignedTo === sender && slot.status === 'pending');
  
  if (slot) {
    slot.status = 'assigned';
    const user = waitingList.find(user => user.phone === sender);
    sendWhatsAppMessage(sender, `Congratulations! You've been assigned parking slot ${slot.number}.`);
    waitingList = waitingList.filter(user => user.phone !== sender);
    console.log(`Slot ${slot.number} assigned to ${user.name}.`);

    // Optionally, assign another slot if available
    assignNextSlot();
  } else {
    sendWhatsAppMessage(sender, "You don't have any pending slot assignments.");
  }
}

// Handle declination of a parking slot
function handleSlotDecline(sender) {
  const slot = parkingSlots.find(slot => slot.assignedTo === sender && slot.status === 'pending');
  
  if (slot) {
    slot.status = 'available';
    slot.assignedTo = null;
    sendWhatsAppMessage(sender, `You've declined parking slot ${slot.number}. The slot is now available for others.`);
    
    // Remove the first user who declined
    waitingList.shift();
    
    // Notify the next person
    assignNextSlot();
  } else {
    sendWhatsAppMessage(sender, "You don't have any pending slot assignments to decline.");
  }
}

// Notify the next person on the waiting list
function askNextInLine() {
  if (waitingList.length > 0) {
    slotAvailable = true;
    sendWhatsAppMessage(waitingList[0].phone, "A parking slot is available. Do you want it? Reply 'Accept' or 'Decline'.", buttons);
  } else {
    slotAvailable = false;
  }
}

// Endpoint to receive data from Excel macro
app.post('/excel-data', (req, res) => {
  const receivedData = req.body;
  console.log('Data received from Excel:', receivedData);

  // Reset parking slots based on received data
  parkingSlots = parkingSlots.map(slot => ({
    ...slot,
    status: 'available',
    assignedTo: null,
    phone: null
  }));

  waitingList = [];

  receivedData.forEach(item => {
    const person = item.Person;
    const slotNumber = item.Parking_slot === 'WL' ? null : parseInt(item.Parking_slot, 10);
    const phone = `whatsapp:${item.Number}`;

    if (item.Parking_slot === 'WL') {
      waitingList.push({ name: person, phone });
      console.log(`${person} is in the waiting list.`);
    } else if (slotNumber) {
      const slot = parkingSlots.find(s => s.number === slotNumber);
      if (slot) {
        slot.status = 'assigned';
        slot.assignedTo = person;
        slot.phone = phone;
        console.log(`${person} has parking slot ${slot.number}.`);

        // Notify the assigned user
        sendWhatsAppMessage2(phone, `You have been assigned to parking slot ${slot.number}.`);
      }
    }
  });

  // Notify the next person in the waiting list
  assignNextSlot();

  // Create message for the waiting list
  if (waitingList.length > 0) {
    // Create a personalized message for each member in the waiting list
    waitingList.forEach((member, i) => {
      const waitingListMessage = `You are in the waiting list: \n${waitingList.map((m, index) => {
        return `${index + 1}. ${m.name}${index === i ? ' (you)' : ''}`;
      }).join('\n')}`;

      // Send a WhatsApp message to each waiting list member with their order
      sendWhatsAppMessage(member.phone, waitingListMessage);
    });
  }

  res.status(200).send('Data received successfully');
});

// Twilio send message helper with buttons
function sendWhatsAppMessage(to, message, buttons = []) {
  const client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

  const interactiveButtons = buttons.length > 0 ? buttons.map(button => ({
    type: 'reply',
    reply: {
      id: button.id,
      title: button.title
    }
  })) : [];

  client.messages.create({
    body: message,
    from: 'whatsapp:+14155238886',
    to: to,
    interactive: {
      type: 'button',
      body: {
        text: message
      },
      action: {
        buttons: interactiveButtons
      }
    }
  })
  .then(message => console.log('Message sent:', message.sid, 'to', to))
  .catch(error => console.error('Error sending message:', error));
}

// Twilio send message helper without buttons
function sendWhatsAppMessage2(to, message) {
  const client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const template_id = 'HX11c138027519a9b312f9d550da94d35e'; // Ensure this template ID is correct and approved

  const variables = { "1": message };
  const variablesJson = JSON.stringify(variables);

  client.messages.create({
    from: 'whatsapp:+14155238886',
    to: to,
    contentSid: template_id,
    contentVariables: variablesJson
  })
  .then(message => console.log('Message sent:', message.sid))
  .catch(error => console.error('Error sending message:', error));
}

// Start the server and ngrok
app.listen(port, () => console.log(`Node.js web server at http://localhost:${port} is running...`));
