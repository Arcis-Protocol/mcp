export default function Home() {
  return (
    <div style={{ background: "#08080A", color: "#f0ece4", minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "serif" }}>
      <div style={{ textAlign: "center" }}>
        <p style={{ color: "#D4AF69", letterSpacing: "0.3em", fontSize: 12 }}>A R C I S</p>
        <h1 style={{ fontSize: 32, margin: "16px 0" }}>MCP Server</h1>
        <p style={{ color: "#8A8478" }}>Connect at <code style={{ color: "#D4AF69" }}>/api/mcp</code></p>
        <p style={{ color: "#8A8478", fontSize: 12, marginTop: 24 }}>9 tools &middot; Streamable HTTP &middot; Base Sepolia</p>
      </div>
    </div>
  );
}
