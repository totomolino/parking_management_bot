// auth.js
const { ConfidentialClientApplication } = require('@azure/msal-node');
const config = require('./authConfig');

const cca = new ConfidentialClientApplication(config);

async function getAccessToken() {
  const clientCredentialRequest = {
    scopes: config.scopes,
  };

  try {
    const response = await cca.acquireTokenByClientCredential(clientCredentialRequest);
    return response.accessToken;
  } catch (error) {
    console.error('Error acquiring access token:', error);
    throw error;
  }
}

module.exports = { getAccessToken };
