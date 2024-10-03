async function main(workbook: ExcelScript.Workbook) {
  try {
    // Set the URL of your API endpoint
    const url = "https://parking-management-bot.onrender.com/excel-data";

    let sheet = workbook.getActiveWorksheet();
    let lastRow = sheet.getUsedRange().getRowCount();
    let dataRange = sheet.getRange(`A2:C${lastRow}`);

    let data = dataRange.getValues();
    let jsonItems: Array<Object> = [];

    for (let i = 0; i < data.length; i++) {
      let row = data[i];
      let item = {
        Parking_slot: row[0],
        Person: row[1],
        Number: row[2]
      };
      jsonItems.push(item);
    }

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

