const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const ngrok = require('@ngrok/ngrok');
require('dotenv').config(); // Load environment variables from .env file

const app = express();
const port = 3000;

// Middleware setup
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json()); // Middleware to parse JSON body

// In-memory storage for received data
let parkingData = [];
let waitingList = ['whatsapp:+5491166070996'];
let slotAvailable = false;

// Predefined buttons for interactive messages
const buttons = [
  { id: 'button1', title: 'Yes' },
  { id: 'button2', title: 'No' }
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

// Helper function to generate HTML table from parking data
function generateHTMLTable(data) {
  let table = '<table border="1" style="border-collapse: collapse; width: 100%;">';
  table += '<tr><th>Parking Slot</th><th>Person</th></tr>'; // Header row

  data.forEach(item => {
    table += '<tr>';
    table += `<td>${item["Parking slot"]}</td>`;
    table += `<td>${item.Person}</td>`;
    table += '</tr>';
  });

  table += '</table>';
  return table;
}

// Helper function to generate a plain text table from parking data
function generatePlainTextTable(data) {
  const parkingSlotWidth = 15; // Width for Parking Slot column
  const personWidth = 20;       // Width for Person column

  let table = 'Parking Slot'.padEnd(parkingSlotWidth) + '| ' + 'Person'.padEnd(personWidth) + '\n';
  table += '-'.repeat(parkingSlotWidth + personWidth + 2) + '\n'; // Separator line

  data.forEach(item => {
    const parkingSlotString = item["Parking slot"].toString();
    const parkingSlotPadding = parkingSlotWidth - parkingSlotString.length;
    const parkingSlot = ' '.repeat(Math.floor(parkingSlotPadding / 2)) + parkingSlotString +
                        ' '.repeat(Math.ceil(parkingSlotPadding / 2));
    
    const person = item.Person.padEnd(personWidth);
    table += `${parkingSlot}| ${person}\n`;
  });

  return table;
}

// Handle incoming WhatsApp messages
app.post('/whatsapp', (req, res) => {
  const messageBody = req.body.Body.trim().toLowerCase();
  const sender = req.body.From; // WhatsApp number

  switch (true) {
    case messageBody.startsWith('start list:'):
      handleStartList(messageBody, sender);
      break;
    case messageBody === 'add me':
      handleAddMe(sender);
      break;
    case messageBody === 'show list':
      sendWhatsAppMessage(sender, `The data is \n${generatePlainTextTable(parkingData)}`);
      break;
    case messageBody === 'cancel':
      handleCancel(sender);
      break;
    case messageBody.startsWith('notify'):
      handleNotify(messageBody, sender);
      break;
    case slotAvailable && messageBody === 'yes':
      handleSlotAccept(sender);
      break;
    case slotAvailable && messageBody === 'no':
      handleSlotDecline(sender);
      break;
    default:
      sendWhatsAppMessage(sender, "Unknown command. Please use 'Add me' or 'Remove me'.");
  }

  res.sendStatus(200);
  console.log(waitingList);
});

// Handle the 'start list' command
function handleStartList(messageBody, sender) {
  try {
    const listString = messageBody.replace('start list:', '').replace(/[\[\]']+/g, '').trim();
    const numbers = listString.split(',').map(number => number.trim().replace(/[^0-9+]/g, ''));

    if (numbers.length > 0) {
      waitingList.length = 0; // Clear existing list
      numbers.forEach(number => {
        const formattedNumber = `whatsapp:${number}`;
        if (!waitingList.includes(formattedNumber)) {
          waitingList.push(formattedNumber);
        }
      });
      sendWhatsAppMessage(sender, "Waiting list has been initialized with the provided numbers.");
    } else {
      sendWhatsAppMessage(sender, "No numbers were provided. Please provide a valid list of numbers.");
    }
  } catch (error) {
    console.error('Error processing list:', error);
    sendWhatsAppMessage(sender, "There was an error processing the list. Please ensure the format is correct.");
  }
}

// Handle the 'add me' command
function handleAddMe(sender) {
  if (!waitingList.includes(sender)) {
    waitingList.push(sender);
    sendWhatsAppMessage(sender, "You've been added to the waiting list.");
  } else {
    sendWhatsAppMessage(sender, "You're already on the waiting list.");
  }
}

// Handle the 'cancel' command
function handleCancel(sender) {
  const index = waitingList.indexOf(sender);
  if (index > -1) {
    waitingList.splice(index, 1);
    sendWhatsAppMessage(sender, "You've been removed from the waiting list.");
    if (waitingList.length > 0) {
      askNextInLine();
    }
  } else {
    sendWhatsAppMessage(sender, "You're not on the waiting list.");
  }
}

// Handle the 'notify' command
function handleNotify(messageBody, sender) {
  const listString = messageBody.replace('notify ', '').replace(/[\[\]']+/g, '').trim();
  console.log(listString);
  sendWhatsAppMessage2(waitingList[Number(listString)], "Test message");
}

// Handle acceptance of a parking slot
function handleSlotAccept(sender) {
  if (waitingList[0] === sender) {
    sendWhatsAppMessage(sender, "You've been assigned a parking slot.");
    slotAvailable = false;
    waitingList.shift(); // Remove the user who accepted the slot
  } else {
    sendWhatsAppMessage(sender, "You're not next in line.");
  }
}

// Handle declination of a parking slot
function handleSlotDecline(sender) {
  if (waitingList[0] === sender) {
    sendWhatsAppMessage(sender, "You've declined the slot. Asking the next person.");
    slotAvailable = false;
    askNextInLine();
  }
}

// Notify the next person on the waiting list
function askNextInLine() {
  if (waitingList.length > 0) {
    slotAvailable = true;
    sendWhatsAppMessage(waitingList[0], "A parking slot is available. Do you want it? Reply Yes or No.");
  } else {
    slotAvailable = false;
  }
}

// Endpoint to receive data from Excel macro
app.post('/excel-data', (req, res) => {
  const receivedData = req.body;
  console.log('Data received from Excel:', receivedData);
  
  // Arrays to hold parking and waiting list members
  const parkingList = [];
  const waitingList = [];

  // Iterate through the received data
  receivedData.forEach(item => {
    const person = item.Person;
    const slot = item.Parking_slot;
    const phone = `whatsapp:${item.Number}`;
    let index = 0;
    if (slot === 'WL') {
      // If the person is in the waiting list, add their name and order to waitingList array
      index++;
      waitingList.push(`${index}. ${person}`); // Index + 1 for 1-based numbering
      console.log(`${person} is in the waiting list.`);
    } else {
      // If the person has a parking slot, add to parkingList array
      parkingList.push(`${person} (${slot})`);
      console.log(`${person} has parking slot ${slot}. The number is ${phone}.`);
      
      // Send WhatsApp message for parking slot
      sendWhatsAppMessage2(phone, `You have been assigned to parking slot ${slot}.`);
    }
  });

  // Create message for the waiting list
  if (waitingList.length > 0) {
    const waitingListMessage = `You are in the waiting list: \n${waitingList.join(', ')}`;
    
    // Send a WhatsApp message to all waiting list members with their order
    waitingList.forEach((person, index) => {
      // Get the original phone number from receivedData based on the index
      const phone = `whatsapp:${receivedData[index].Number}`; // Use the original number
      sendWhatsAppMessage(phone, waitingListMessage);
    });
  }

  // Send success response
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
  .then(message => console.log('Message sent:', message.sid))
  .catch(error => console.error('Error sending message:', error));
}

// Twilio send message helper without buttons
function sendWhatsAppMessage2(to, message) {
  const client = new twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const template_id = 'HX11c138027519a9b312f9d550da94d35e';

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
app.listen(port, () => console.log(`Node.js web server at ${port} is running...`));
