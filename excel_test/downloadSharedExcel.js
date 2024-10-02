// downloadSharedExcel.js
const axios = require('axios');
const { getAccessToken } = require('./auth');

async function downloadSharedExcelFile(shareUrl) {
  const accessToken = await getAccessToken();

  // Encode the share URL in Base64 as per Microsoft Graph API requirements
  const encodedUrl = Buffer.from(shareUrl).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const url = `https://graph.microsoft.com/v1.0/shares/u!${encodedUrl}/driveItem/content`;

  try {
    const response = await axios.get(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      responseType: 'arraybuffer', // Important for binary data
    });

    return response.data; // This is a Buffer
  } catch (error) {
    if (error.response && error.response.data) {
      // Attempt to parse the error response
      try {
        const errorJson = JSON.parse(error.response.data.toString());
        console.error('Error downloading shared Excel file:', JSON.stringify(errorJson, null, 2));
      } catch (parseError) {
        console.error('Error downloading shared Excel file:', error.response.data.toString());
      }
    } else {
      console.error('Error downloading shared Excel file:', error.message);
    }
    throw error;
  }
}

module.exports = { downloadSharedExcelFile };
