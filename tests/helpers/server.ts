/**
 * tests/helpers/server.ts
 *
 * Test utility that spins up a fully wired McpServer + Client pair connected
 * through an in-process InMemoryTransport. This lets MCP-layer tests exercise
 * real tool registration and JSON-RPC dispatch without any network I/O.
 *
 *   createTestServer(register) — instantiate server, call register(), connect client
 *   getText(result)            — pull all "text" content blocks out of a tool result
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

export interface TestServer {
  client: Client;
  server: McpServer;
}

export async function createTestServer(register: (server: McpServer) => void): Promise<TestServer> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const server = new McpServer({ name: "ssh-remote-test", version: "0.0.0" });
  register(server);
  await server.connect(serverTransport);

  const client = new Client({ name: "test-client", version: "1" }, { capabilities: {} });
  await client.connect(clientTransport);

  return { client, server };
}

/** Extract the text content from a tool call result. */
export function getText(result: Awaited<ReturnType<Client["callTool"]>>): string {
  return (result.content as Array<{ type: string; text: string }>)
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("\n");
}
