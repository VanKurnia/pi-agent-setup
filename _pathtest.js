const path = require('path');

// Exactly what's in settings.json (JSON decodes \\ to \)
const sourcePath = "..\\extensions\\custom-header.ts";
console.log("JSON-decoded path:", JSON.stringify(sourcePath));

const agentDir = "C:\\Users\\Ivan Kurniawan\\.pi\\agent";
const result = path.resolve(agentDir, sourcePath);
console.log("Resolved:", result);
console.log("Exists:", require('fs').existsSync(result));

// With forward slashes
const result2 = path.resolve(agentDir, "../extensions/custom-header.ts");
console.log("Resolved (forward):", result2);
console.log("Exists (forward):", require('fs').existsSync(result2));
