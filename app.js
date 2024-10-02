const http = require('http');
const express = require('express');
const bodyParser = require('body-parser');
const twilio = require('twilio');
const ngrok = require('@ngrok/ngrok');
require('dotenv').config(); // Load environment variables from .env file

const app = express();
port = 3000
app.use(bodyParser.urlencoded({ extended: false }));

// In-memory storage for received data
let parkingData = [];

app.get('/health', (_, res) => {
    res.send('OK');
})

app.get('/wake', (_, res) => {
    const date = new Date();
    date.setHours(date.getHours() + 3);
    console.log("Wake App Server: ", date);
    res.send('OK');
})

// const waitingList = [];
const waitingList = ['whatsapp:+5491166070996'];
let slotAvailable = false;

const buttons = [
  { id: 'button1', title: 'Yes' },
  { id: 'button2', title: 'No' }
];

function generateHTMLTable(parkingData) {
    let table = '<table border="1" style="border-collapse: collapse; width: 100%;">';
    table += '<tr><th>Parking Slot</th><th>Person</th></tr>'; // Header row

    parkingData.forEach(item => {
        table += '<tr>';
        table += `<td>${item["Parking slot"]}</td>`;
        table += `<td>${item.Person}</td>`;
        table += '</tr>';
    });

    table += '</table>';
    return table;
}

function generatePlainTextTable(parkingData) {
    // Define maximum column widths
    const parkingSlotWidth = 15; // Width for Parking Slot column
    const personWidth = 20;       // Width for Person column

    let table = 'Parking Slot'.padEnd(parkingSlotWidth) + '| ' + 'Person'.padEnd(personWidth) + '\n';
    table += '-'.repeat(parkingSlotWidth + personWidth + 2) + '\n'; // Add a separator line

    parkingData.forEach(item => {
        // Align Parking Slot numbers in the center
        const parkingSlotString = item["Parking slot"].toString();
        const parkingSlotPadding = parkingSlotWidth - parkingSlotString.length;
        const parkingSlot = ' '.repeat(Math.floor(parkingSlotPadding / 2)) + parkingSlotString +
                            ' '.repeat(Math.ceil(parkingSlotPadding / 2));
        
        // Align Person names to the left
        const person = item.Person.padEnd(personWidth);

        table += `${parkingSlot}| ${person}\n`;
    });

    return table;
}


// Handle incoming WhatsApp messages
app.post('/whatsapp', (req, res) => {
  const messageBody = req.body.Body.trim().toLowerCase();
  const sender = req.body.From; // WhatsApp number

  if (messageBody.startsWith('start list:')) {
    try {
      // Extract and sanitize the list string
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
  } else if (messageBody === 'add me') {
    if (!waitingList.includes(sender)) {
      waitingList.push(sender);
      sendWhatsAppMessage(sender, "You've been added to the waiting list.");
    } else {
      sendWhatsAppMessage(sender, "You're already on the waiting list.");
    }
  } else if (messageBody === 'show list') {
      //  sendWhatsAppMessage(sender, `The data is ${JSON.stringify(parkingData, null, 2)}`);
       sendWhatsAppMessage(sender, `The data is \n${generatePlainTextTable(parkingData)}`);

  }else if (messageBody === 'cancel') {
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
  } else if (messageBody.startsWith('notify')) {
    const listString = messageBody.replace('notify ', '').replace(/[\[\]']+/g, '').trim();
    console.log(listString)
    sendWhatsAppMessage2(waitingList[Number(listString)], "A parking slot is available. Do you want it? Reply 'Yes' or 'No'.");
  } else if (slotAvailable && messageBody === 'yes') {
    if (waitingList[0] === sender) {
      sendWhatsAppMessage(sender, "You've been assigned a parking slot.");
      slotAvailable = false;
      waitingList.shift(); // Remove the user who accepted the slot
    } else {
      sendWhatsAppMessage(sender, "You're not next in line.");
    }
  } else if (slotAvailable && messageBody === 'no') {
    if (waitingList[0] === sender) {
      sendWhatsAppMessage(sender, "You've declined the slot. Asking the next person.");
      slotAvailable = false;
      askNextInLine();
    }
  } else {
    sendWhatsAppMessage(sender, "Unknown command. Please use 'Add me' or 'Remove me'.");
  }
  res.sendStatus(200);
  console.log(waitingList);
});




// Function to notify the next person on the waiting list
function askNextInLine() {
  if (waitingList.length > 0) {
    slotAvailable = true;
    sendWhatsAppMessage(waitingList[0], "A parking slot is available. Do you want it? Reply 'Yes' or 'No'.");
  } else {
    slotAvailable = false;
  }
}
app.use(bodyParser.json()); // Middleware to parse JSON body

// Endpoint to receive data from Excel macro
app.post('/excel-data', (req, res) => {
  // Assuming the Excel macro will send JSON data
  const receivedData = req.body;
  console.log('Data received from Excel:', receivedData);
  
  // Process the data as needed
  parkingData = receivedData
  
  // Send a response back to the Excel macro
  res.status(200).send('Data received successfully');
});


// // Twilio send message helper
// function sendWhatsAppMessage(to, message) {
//   const accountSid = 'AC11e65e51a8103f9755dea5e707c03f73';
//   const authToken = 'cf0b399ba91e1802b5768165de899006';
//   const client = new twilio(accountSid, authToken);


//   client.messages.create({
//     body: message,
//     from: 'whatsapp:+14155238886',
//     to: to
//   });
// }

// Twilio send message helper with buttons
function sendWhatsAppMessage(to, message, buttons = []) {
  const accountSid = 'AC11e65e51a8103f9755dea5e707c03f73';
  const authToken = 'cf0b399ba91e1802b5768165de899006';
  const client = new twilio(accountSid, authToken);

  // Construct the buttons array if provided
  const interactiveButtons = buttons.length > 0 ? buttons.map((button) => ({
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


function sendWhatsAppMessage2(to, message) {
  const accountSid = 'AC11e65e51a8103f9755dea5e707c03f73';
  const authToken = 'cf0b399ba91e1802b5768165de899006';
  const client = new twilio(accountSid, authToken);

  client.messages.create({
    from: 'whatsapp:+14155238886',    
    to: to,
    contentSid:'HX209b9dbfabc26dfd91fc9339c3b346c2'
  })
  .then(message => console.log('Message sent:', message.sid))
  .catch(error => console.error('Error sending message:', error));
}




// Create HTTP server
const server = http.createServer(app);
server.listen(port, () => console.log(`Node.js web server at ${port} is running...`));

// Get your endpoint online with ngrok
// ngrok.connect({ addr: port, authtoken: process.env.NGROK_AUTHTOKEN, domain: 'upward-gull-dear.ngrok-free.app' })
//   .then((listener) => {
//     console.log(`Ingress established at: ${listener.url()}`);
//     // Here you can set up your Twilio webhook URL with the ngrok URL
//   })
//   .catch((error) => {
//     console.error('Error connecting ngrok:', error);
//   });