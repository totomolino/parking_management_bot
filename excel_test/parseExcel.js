// parseExcel.js
const XLSX = require('xlsx');

function parseExcel(buffer) {
  // Read the buffer into a workbook
  const workbook = XLSX.read(buffer, { type: 'buffer' });

  // Get the first sheet name
  const sheetName = workbook.SheetNames[0];

  // Get the worksheet
  const worksheet = workbook.Sheets[sheetName];

  // Convert to JSON
  const jsonData = XLSX.utils.sheet_to_json(worksheet, { defval: null });

  return jsonData;
}

module.exports = { parseExcel };
