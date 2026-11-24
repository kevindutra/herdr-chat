// Which MCP servers from Claude Code's init make the chat's "didn't start" notice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeMcpToReport } from "../../host/providers/mcp.ts";

test("claude MCP notice: claude.ai account connectors never signed in stay quiet, as in the TUI; real failures and your own servers' sign-ins are told", () => {
  const servers = [
    { name: "claude.ai Gmail", status: "needs-auth" },
    { name: "claude.ai Notion", status: "needs-auth" },
    { name: "claude.ai Linear", status: "connected" },
    { name: "claude.ai Slack", status: "failed" },
    { name: "plugin:p:server-a", status: "needs-auth" },
    { name: "mine", status: "failed" },
    { name: "ok", status: "connected" },
  ];
  assert.deepEqual(claudeMcpToReport(servers, new Set()).map((m) => m.name), ["claude.ai Slack", "plugin:p:server-a", "mine"]);
  // Each one once per chat.
  assert.deepEqual(claudeMcpToReport(servers, new Set(["mine"])).map((m) => m.name), ["claude.ai Slack", "plugin:p:server-a"]);
});
