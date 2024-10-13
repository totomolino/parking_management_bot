async function main(workbook: ExcelScript.Workbook) {
  try {
    // Set the URL of your API endpoint
    const url = "https://upward-gull-dear.ngrok-free.app/excel-data";

    // Get the active worksheet
    let sheet = workbook.getActiveWorksheet();
    
    // Get the last used row
    let lastRow = sheet.getUsedRange().getRowCount();

    // Define the range for columns C, E, and P starting from row 12
    let dataRange = sheet.getRange(`C12:P${lastRow}`);

    // Get the values from the range
    let data = dataRange.getValues();

    // Prepare an array for JSON items
    let jsonItems: Array<Object> = [];

    for (let i = 0; i < data.length; i++) {
      let row = data[i];

      // Create an object for each row, extracting phone (col C), name (col E), and parking slot (col P)
      let item = {
        Parking_slot: row[12],  // Column P (index 12)
        Person: row[2],         // Column E (index 2)
        Number: row[0]          // Column C (index 0)
      };

      // Push the item to the JSON array
      jsonItems.push(item);
    }

    // Convert the array of items to a JSON string
    let jsonString = JSON.stringify(jsonItems);
    console.log(jsonString);

    // Send the JSON data to the API
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: jsonString,
    });

    // Check the response from the server
    if (!response.ok) {
      throw new Error(`Error sending data: ${response.status} - ${await response.text()}`);
    }

    const responseData = await response.text();
    console.log("Data sent successfully:", responseData);

  } catch (error) {
    console.log("Error:", error);
  }
}
