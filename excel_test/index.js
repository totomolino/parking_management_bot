// index.js
const { downloadSharedExcelFile } = require('./downloadSharedExcel');
const { parseExcel } = require('./parseExcel');
require('dotenv').config();

const shareUrl = 'https://1drv.ms/x/s!AqGIH17M2gVbgpQneet9VzZBnxv6Eg?e=zXCkQH'; // Ensure this is set in your .env file

async function main() {
  try {
    console.log('Downloading Excel file from OneDrive...');
    const excelBuffer = await downloadSharedExcelFile(shareUrl);
    console.log('Download complete.');

    console.log('Parsing Excel file...');
    const data = parseExcel(excelBuffer);
    console.log('Parsing complete.');

    console.log('Excel Data:', data);
  } catch (error) {
    console.error('Error processing Excel file:', error);
  }
}

main();
