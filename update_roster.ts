async function main(workbook: ExcelScript.Workbook) {
  try {
    // Set the URL of your API endpoint for parking slots
    const parkingSlotsUrl = "https://brief-stable-penguin.ngrok-free.app/update-roster";

    // Get the "Slots" worksheet
    let slotsSheet = workbook.getWorksheet("FT Employees Roster (From HR)");
    let lastRow = slotsSheet.getUsedRange().getRowCount();
    let dataRange = slotsSheet.getRange(`A2:A${lastRow}`); // Only get the first column with parking slots

    // Get the parking slots
    let slotsData = dataRange.getValues();
    let parkingSlots: Array<number> = [];

    for (let i = 0; i < slotsData.length; i++) {
      let slot = Number(slotsData[i][0]); // Get the first column value (parking slot)
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

  } catch (error) {
    console.log("Error sending parking slots:", error);
  }
}