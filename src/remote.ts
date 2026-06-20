import { server } from "./server.js";

// Remote mode: HTTP transport for Claude.ai custom connector
const PORT = parseInt(process.env.PORT || "3001");
server.listen(PORT);
console.log(`Arcis MCP Server listening on http://localhost:${PORT}/mcp`);
