async function main(workbook: ExcelScript.Workbook) {
    try {
        // Set the URL of your API endpoint for parking slots
        const parkingSlotsUrl = "https://brief-stable-penguin.ngrok-free.app/update-roster";

        // Get the "Slots" worksheet
        let slotsSheet = workbook.getWorksheet("FT Employees Roster (From HR)");
        let lastRow = slotsSheet.getUsedRange().getRowCount();
        let dataRange = slotsSheet.getRange(`A7:J${lastRow}`); // Adjusted to start at row 4

        // Get data from the range
        let data = dataRange.getValues();
        let roster: Array<{ name: string; phone: string; priority: number }> = [];

        // Priority mapping
        const priorityMap: { [key: string]: number } = {
            "Principal/Executive Director": 1,
            "Manager": 2,
            "Senior Consultant": 3,
            "Consultant": 3,
            "Associate Consultant": 4,
            "Associate": 4
        };

        for (let i = 0; i < data.length; i++) {
            let name = data[i][1] as string; // Column B for name
            let title = data[i][6] as string; // Column G for title
            let phone = data[i][9] as string; // Column J for phone
            if (phone === "No") {
                continue;
            }
            // Determine priority based on title
            let priority = priorityMap[title] || 5; // Default priority if title doesn't match

            roster.push({ name, phone, priority });
        }

        // Send the roster as JSON to the API endpoint
        let rosterJsonString = JSON.stringify(roster);
        console.log("Roster JSON:", rosterJsonString);

        const response = await fetch(parkingSlotsUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: rosterJsonString,
        });

        // Check the response from the API endpoint
        if (!response.ok) {
            throw new Error(`Error sending roster: ${response.status} - ${await response.text()}`);
        }

        const responseData = await response.text();
        console.log("Roster sent successfully:", responseData);

    } catch (error) {
        console.log("Error sending roster:", error);
    }
}
