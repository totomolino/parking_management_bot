async function main(workbook: ExcelScript.Workbook) {
    try {
        // Set the URL of your API endpoint for parking slots
        const parkingSlotsUrl = "https://brief-stable-penguin.ngrok-free.app/update-holidays";

        // Get the "Slots" worksheet
        let slotsSheet = workbook.getWorksheet("Holidays");
        let lastRow = slotsSheet.getUsedRange().getRowCount();
        let dataRange = slotsSheet.getRange(`B6:C${lastRow}`); // Adjusted to start at row 4

        // Get data from the range
        let data = dataRange.getValues();
        let holidays: Array<{ date: string; description: string }> = [];


        for (let i = 0; i < data.length; i++) {
            let date = data[i][0] as string; // Column B for date
            let description = data[i][1] as string; // Column C for description
            holidays.push({ date, description });
        }

        // Send the holidays as JSON to the API endpoint
        let holidaysJsonString = JSON.stringify(holidays);
        console.log("Roster JSON:", holidaysJsonString);

        const response = await fetch(parkingSlotsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: holidaysJsonString,
        });

        // Check the response from the API endpoint
        if (!response.ok) {
            throw new Error(`Error sending Holidays: ${response.status} - ${await response.text()}`);
        }

        const responseData = await response.text();
        console.log("Holidays sent successfully:", responseData);

    } catch (error) {
        console.log("Error sending Holidays:", error);
    }
}
