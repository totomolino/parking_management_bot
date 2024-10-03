async function main(workbook: ExcelScript.Workbook) {
  try {
    // Set the URL of your API endpoints
    const url = "https://parking-management-bot.onrender.com/excel-data";
    const parkingSlotsUrl = "https://parking-management-bot.onrender.com/parking_slots";

    // Get the "reservations" worksheet
    let sheet = workbook.getWorksheet("reservations");
    let lastRow = sheet.getUsedRange().getRowCount();
    let dataRange = sheet.getRange(`A2:A${lastRow}`); // Only get the first column with parking slots

    // Get the parking slots
    let slotsData = dataRange.getValues();
    let parkingSlots: number[] = [];

    for (let i = 0; i < slotsData.length; i++) {
      let slot = slotsData[i][0]; // Get the first column value (parking slot)
      parkingSlots.push(slot); // Assuming slots are numbers
    }

    // Send the parking slots to the /parking_slots endpoint
    let slotsJsonString = JSON.stringify(parkingSlots);
    console.log("Parking Slots JSON:", slotsJsonString);

    const slotsResponse = await fetch(parkingSlotsUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: slotsJsonString,
    });

    // Check the response from the /parking_slots endpoint
    if (!slotsResponse.ok) {
      throw new Error(`Error sending parking slots: ${slotsResponse.status} - ${await slotsResponse.text()}`);
    }

    const slotsResponseData = await slotsResponse.text();
    console.log("Parking slots sent successfully:", slotsResponseData);

    // Now handle the rest of your data from the "reservations" sheet
    let dataRangeRest = sheet.getRange(`A2:C${lastRow}`);
    let data = dataRangeRest.getValues();
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
    console.log("Data JSON:", jsonString);

    // Send the JSON data to the /excel-data endpoint
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
