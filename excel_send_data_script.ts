async function main(workbook: ExcelScript.Workbook) {
    try {
        // Set the URL of your API endpoint
        const url = "https://brief-stable-penguin.ngrok-free.app/excel-data";

        // Get the active worksheet
        let sheet = workbook.getWorksheet("Parking spaces allocation");

        // Start from row 12 in column C and find the last non-empty cell
        let columnC = sheet.getRange("C12:C" + sheet.getUsedRange().getRowCount()).getValues();
        let lastRow = 12;

        // Loop through column C to find the last non-empty cell
        for (let i = 0; i < columnC.length; i++) {
            if (columnC[i][0] === "") {
                lastRow = 12 + i - 1;  // Set the last row before the empty cell
                break;
            }
            lastRow = 12 + i;  // Update lastRow if there is no break (no empty cells)
        }


        // Define the range for columns C, E, and P starting from row 12
        let dataRange = sheet.getRange(`C12:Q${lastRow}`);

        // Get the values from the range
        let data = dataRange.getValues();

        // Prepare an array for JSON items
        let jsonItems: Array<Object> = [];

        for (let i = 0; i < data.length; i++) {
            let row = data[i];

            const parking_slot = row[14]

            // Create an object for each row, extracting phone (col C), name (col E), and parking slot (col P)
            if (parking_slot) {
                let item = {
                    Parking_slot: parking_slot,  // Column P (index 12)
                    Person: row[2],         // Column E (index 2)
                    Number: row[3]          // Column C (index 0)
                };

                // Push the item to the JSON array
                jsonItems.push(item);
            }
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
