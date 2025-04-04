async function main(workbook: ExcelScript.Workbook) {
    try {
        const apiUrl = "https://brief-stable-penguin.ngrok-free.app/refresh_logs"; // Replace with your endpoint

        const startingRow = 1 //Where headers starts

        // Get the "Slots" worksheet
        let slotsSheet = workbook.getWorksheet("Logs");
        let lastRow = slotsSheet.getUsedRange().getRowCount() + startingRow - 1;

        // Get all worksheets
        const sheets = workbook.getWorksheets();

        // Try to find the sheet that has Table1
        let table: ExcelScript.Table | null = null;

        for (const sheet of sheets) {
            const tables = sheet.getTables();
            const tableNames = tables.map(t => t.getName());

            for (const t of tables) {
                if (t.getName() === "Table1") {
                    table = t;
                    break;
                }
            }

            if (table) break;
        }

        if (!table) {
            throw new Error('Table "Table1" not found in any worksheet.');
        }

        const rows = table.getRangeBetweenHeaderAndTotal().getValues();

        // Get last Nro value (column index 0)
        let lastLine = 0;
        if (rows.length > 0) {
            const lastRow = rows[rows.length - 1];
            const nroValue = parseInt(lastRow[0] as string);
            if (!isNaN(nroValue)) {
                lastLine = nroValue;
            }
        }

        console.log(`Last line number: ${lastLine}`);

        // Prepare POST payload
        const body = JSON.stringify({ line: lastLine });

        // Send POST request to fetch new logs
        const response = await fetch(apiUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: body,
        });

        if (!response.ok) {
            throw new Error(`API error: ${response.status} - ${await response.text()}`);
        }

        const json: { newLines: string[] } = await response.json();
        const newLines: string[] = json.newLines;

        if (newLines.length === 0) {
            console.log("No new lines to append.");
            return;
        }

        const rowsToAdd = newLines.map(line => {
            const [nro, time, number, name, log] = line.split('|'); // Extract API values
            return [nro, time, null, null, null, number, name, log, null]; // Insert NULLs where formulas exist
        });

        console.log("Rows to add:", JSON.stringify(rowsToAdd, null, 2));

        // Ensure `rowsToAdd` is a 2D array
        if (!Array.isArray(rowsToAdd) || !rowsToAdd.every(row => Array.isArray(row))) {
            throw new Error("Invalid row format: Expected a 2D array.");
        }

        // Append rows safely (Excel will auto-calculate formulas)
        table.addRows(-1, rowsToAdd);
        console.log(`Added ${rowsToAdd.length} rows to Table1.`);
    } catch (error) {
        console.log("Error refreshing logs:", error);
    }
}
