const axios = require('axios');

// WhatsApp Cloud API credentials
const token = 'YOUR_ACCESS_TOKEN';  // Replace with your Temporary Access Token
const phoneNumberId = 'YOUR_PHONE_NUMBER_ID';  // Replace with your Phone Number ID
const recipientPhone = 'RECIPIENT_PHONE_NUMBER';  // Replace with recipient's phone number in international format (e.g., +1234567890)
const message = 'Hello, this is a test message from the WhatsApp Cloud API!';  // The message you want to send

// Send message function
async function sendMessage() {
  try {
    const url = `https://graph.facebook.com/v17.0/${phoneNumberId}/messages`;
    
    const response = await axios.post(url, {
      messaging_product: 'whatsapp',
      to: recipientPhone,
      type: 'text',
      text: {
        body: message,
      },
    }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    });

    console.log('Message sent:', response.data);
  } catch (error) {
    console.error('Error sending message:', error.response ? error.response.data : error.message);
  }
}

sendMessage();
