import { describe, expect, test, mock } from "bun:test";
import type { Agent } from "@mastra/core/agent";
import type { ChannelHandlerContext } from "@mastra/core/channels";
import { RequestContext } from "@mastra/core/request-context";
import type { Message, Thread } from "chat";
import { bindNewApprovals, handleApprovalCommand, pendingIds, renderApprovalCommand } from "./approval-command";

function fixture() {
  const stored = { id: "internal", resourceId: "first-member", metadata: {
    channel_platform: "mattermost", channel_externalThreadId: "external", channel_externalChannelId: "channel",
    mattermostApprovalOwners: {} as Record<string, { runId: string; userId: string }>,
  } };
  let runs = [{ runId: "run-1", toolCalls: [{ toolCallId: "call-1", toolName: "delete_calendar_event", requiresApproval: true, args: { id: "event" } }] }];
  const post = mock(async (_content: unknown) => ({}));
  const thread = { id: "external", channelId: "channel", adapter: { name: "mattermost" }, isDM: false, post } as unknown as Thread;
  const memory = {
    listThreads: mock(async ({ filter }: any) => ({ threads: Object.entries(filter.metadata).every(([k, v]) => (stored.metadata as any)[k] === v) ? [stored] : [] })),
    updateThread: mock(async ({ metadata }: any) => { stored.metadata = metadata; }),
  };
  const ctx = { requestContext: new RequestContext(), mastra: { getStorage: () => ({ getStore: async () => memory }) } } as unknown as ChannelHandlerContext;
  const consumeStream = mock(async () => { runs = []; });
  let chunks: any[] | undefined;
  const output = (denied = false) => ({ fullStream: (async function* () {
    await consumeStream();
    yield* chunks ?? [{ type: denied ? "tool-output-denied" : "tool-result", payload: { toolCallId: "call-1", result: { deleted: true } } }];
  })() });
  const approveToolCall = mock(async (_options: any) => output());
  const declineToolCall = mock(async (_options: any) => output(true));
  const agent = { listSuspendedRuns: mock(async () => ({ runs })), approveToolCall, declineToolCall } as unknown as Agent;
  const message = (text: string, userId = "requester", isBot = false) => ({ id: "message", text, author: { userId, isBot, userName: userId } }) as Message;
  const bind = () => bindNewApprovals(thread, message("delete event"), ctx, agent, new Set());
  return { setChunks: (next: any[]) => { chunks = next; }, stored, thread, memory, ctx, agent, post, message, bind, consumeStream, approveToolCall, declineToolCall, setRuns: (next: typeof runs) => { runs = next; } };
}

describe("explicit Mattermost approvals", () => {
  test("binds new requests to their sender, preserves metadata, and never claims older requests", async () => {
    const f = fixture();
    await bindNewApprovals(f.thread, f.message("unrelated", "other"), f.ctx, f.agent, await pendingIds(f.thread, f.ctx, f.agent));
    expect(f.stored.metadata.mattermostApprovalOwners).toEqual({});
    await f.bind();
    expect(f.stored.metadata.channel_externalThreadId).toBe("external");
    expect(f.stored.metadata.mattermostApprovalOwners["call-1"]).toEqual({ runId: "run-1", userId: "requester" });
  });
  for (const action of ["approve", "deny"]) {
    test(`${action} resumes only the chosen tool and consumes its rendered output`, async () => {
      const f = fixture(); await f.bind();
      expect(await handleApprovalCommand(f.thread, f.message(`@bot !${action} call-1`), f.ctx, f.agent)).toBe(true);
      const called = action === "approve" ? f.approveToolCall : f.declineToolCall;
      expect(called).toHaveBeenCalledTimes(1);
      expect(called.mock.calls[0][0]).toMatchObject({ runId: "run-1", toolCallId: "call-1", memory: { thread: "internal", resource: "first-member" } });
      expect(f.consumeStream).toHaveBeenCalledTimes(1);
      expect(String(f.post.mock.calls[0][0])).toContain("received");
      expect(String(f.post.mock.calls[1][0])).toContain(action === "approve" ? "completed successfully" : "was not run");
      expect(f.ctx.requestContext.get("channel")).toMatchObject({ userId: "requester", threadId: "external" });
      await handleApprovalCommand(f.thread, f.message(`!${action} call-1`), f.ctx, f.agent);
      expect(called).toHaveBeenCalledTimes(1);
    });
  }
  for (const scenario of ["wrong sender", "wrong thread", "bot", "unowned", "wrong id"]) {
    test(`refuses ${scenario}`, async () => {
      const f = fixture(); if (scenario !== "unowned") await f.bind();
      const thread = scenario === "wrong thread" ? { ...f.thread, id: "another" } as Thread : f.thread;
      await handleApprovalCommand(thread, f.message(`!approve ${scenario === "wrong id" ? "absent" : "call-1"}`, scenario === "wrong sender" ? "other" : "requester", scenario === "bot"), f.ctx, f.agent);
      expect(f.approveToolCall).not.toHaveBeenCalled();
    });
  }
  test("lists only this conversation and gives usage for missing IDs", async () => {
    const f = fixture();
    await handleApprovalCommand(f.thread, f.message("!approvals"), f.ctx, f.agent);
    expect(String(f.post.mock.calls[0][0])).toContain("call-1");
    await handleApprovalCommand(f.thread, f.message("!approve"), f.ctx, f.agent);
    expect(String(f.post.mock.calls[1][0])).toContain("Usage");
    expect(await handleApprovalCommand(f.thread, f.message("yes"), f.ctx, f.agent)).toBe(false);
    expect(f.approveToolCall).not.toHaveBeenCalled();
  });
  test("concurrent duplicate commands execute once", async () => {
    const f = fixture(); await f.bind();
    await Promise.all([1, 2].map(() => handleApprovalCommand(f.thread, f.message("!approve call-1"), f.ctx, f.agent)));
    expect(f.approveToolCall).toHaveBeenCalledTimes(1);
  });
  test("chained approval inherits requester, not the thread creator", async () => {
    const f = fixture(); await f.bind();
    f.consumeStream.mockImplementation(async () => { f.setRuns([{ runId: "run-1", toolCalls: [{ toolCallId: "call-2", toolName: "delete_calendar_event", requiresApproval: true, args: { id: "next" } }] }]); });
    await handleApprovalCommand(f.thread, f.message("!approve call-1"), f.ctx, f.agent);
    expect(f.stored.metadata.mattermostApprovalOwners["call-2"]).toEqual({ runId: "run-1", userId: "requester" });
  });
  test("reports resume failure without executing a second time automatically", async () => {
    const f = fixture(); await f.bind();
    f.consumeStream.mockImplementation(async () => { throw new Error("mock resume failed"); });
    await handleApprovalCommand(f.thread, f.message("!approve call-1"), f.ctx, f.agent);
    expect(f.approveToolCall).toHaveBeenCalledTimes(1);
    expect(String(f.post.mock.calls.at(-1)![0])).toContain("couldn't process");
  });
  for (const scenario of ["tool-error", "isError", "empty", "unrelated", "abort"]) {
    test(`never claims success for ${scenario}`, async () => {
      const f = fixture(); await f.bind();
      f.setChunks(scenario === "empty" ? [] : [{
        type: scenario === "isError" || scenario === "unrelated" ? "tool-result" : scenario,
        payload: { toolCallId: scenario === "unrelated" ? "another-call" : "call-1", isError: scenario === "isError" },
      }]);
      await handleApprovalCommand(f.thread, f.message("!approve call-1"), f.ctx, f.agent);
      const reply = String(f.post.mock.calls.at(-1)![0]);
      expect(reply).not.toContain("completed successfully");
      expect(reply).toContain(scenario === "tool-error" || scenario === "isError" ? "failed" : "couldn't confirm");
    });
  }
  test("renders approval commands and hides routine results", () => {
    const common = { toolCallId: "call-1", toolName: "delete_calendar_event", displayName: "delete calendar event", argsSummary: "event", args: { id: "event" } };
    expect(renderApprovalCommand({ kind: "approval", ...common }, { platform: "mattermost", mode: "static" })).toMatchObject({ kind: "post", message: expect.stringContaining("!approve call-1") });
    expect(renderApprovalCommand({ kind: "result", ...common, result: { private: true }, resultText: "private", durationMs: 1, isError: false }, { platform: "mattermost", mode: "static" })).toBeUndefined();
  });
});
