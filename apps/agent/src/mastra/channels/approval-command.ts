import type { Agent } from "@mastra/core/agent";
import type { ChannelHandlerContext, ToolDisplayFn } from "@mastra/core/channels";
import type { Message, Thread } from "chat";

type PendingOwner = { runId: string; userId: string };
type ThreadMetadata = Record<string, unknown> & { mattermostApprovalOwners?: Record<string, PendingOwner> };

const COMMAND = /^!(approve|deny|approvals)\b(?:\s+([^\s]+))?\s*$/i;
const activeCommands = new Set<string>();

function commandText(message: Message): RegExpExecArray | null {
  return COMMAND.exec((message.text ?? "").trim().replace(/^@[\w.\-]+\s+/, ""));
}

async function mappedThread(thread: Thread, ctx: ChannelHandlerContext) {
  const storage = ctx.mastra?.getStorage();
  const memory = await storage?.getStore("memory");
  if (!memory) return null;
  const { threads } = await memory.listThreads({
    filter: {
      metadata: {
        channel_platform: thread.adapter.name,
        channel_externalThreadId: thread.id,
        channel_externalChannelId: thread.channelId,
      },
    },
    perPage: 1,
  });
  return { memory, thread: threads[0] };
}

function owners(metadata: Record<string, unknown> | undefined): Record<string, PendingOwner> {
  const value = (metadata as ThreadMetadata | undefined)?.mattermostApprovalOwners;
  return value && typeof value === "object" ? value : {};
}

async function saveOwners(
  thread: Thread,
  ctx: ChannelHandlerContext,
  additions: Record<string, PendingOwner>,
) {
  const mapping = await mappedThread(thread, ctx);
  if (!mapping?.thread) return;
  const next = { ...owners(mapping.thread.metadata), ...additions };
  await mapping.memory.updateThread({
    id: mapping.thread.id,
    metadata: { ...(mapping.thread.metadata ?? {}), mattermostApprovalOwners: next },
  });
}

/** Records approvals created by this message without claiming older pending calls. */
export async function bindNewApprovals(
  thread: Thread,
  message: Message,
  ctx: ChannelHandlerContext,
  agent: Agent,
  before: Set<string>,
  runId?: string,
) {
  const mapping = await mappedThread(thread, ctx);
  if (!mapping?.thread || !message.author?.userId) return;
  const { runs } = await agent.listSuspendedRuns({
    threadId: mapping.thread.id,
    resourceId: mapping.thread.resourceId,
  });
  const additions: Record<string, PendingOwner> = {};
  for (const run of runs) {
    if (runId && run.runId !== runId) continue;
    for (const call of run.toolCalls) {
      if (call.requiresApproval && call.toolCallId && !before.has(call.toolCallId)) {
        additions[call.toolCallId] = { runId: run.runId, userId: message.author.userId };
      }
    }
  }
  if (Object.keys(additions).length) await saveOwners(thread, ctx, additions);
}

export async function pendingIds(thread: Thread, ctx: ChannelHandlerContext, agent: Agent): Promise<Set<string>> {
  const mapping = await mappedThread(thread, ctx);
  if (!mapping?.thread) return new Set();
  const { runs } = await agent.listSuspendedRuns({ threadId: mapping.thread.id, resourceId: mapping.thread.resourceId });
  return new Set(runs.flatMap((run) => run.toolCalls.filter((call) => call.requiresApproval).map((call) => call.toolCallId).filter(Boolean) as string[]));
}

/** Handles explicit, persistent approval commands before a message reaches the model. */
export async function handleApprovalCommand(
  thread: Thread,
  message: Message,
  ctx: ChannelHandlerContext,
  agent: Agent,
): Promise<boolean> {
  const match = commandText(message);
  if (!match) return false;
  if (message.author?.isBot || !message.author?.userId) return true;

  const action = match[1].toLowerCase();
  const callId = match[2];
  const mapping = await mappedThread(thread, ctx);
  if (!mapping?.thread) {
    await thread.post("I can't find this conversation's approval state yet. Please retry the request.");
    return true;
  }
  const { runs } = await agent.listSuspendedRuns({ threadId: mapping.thread.id, resourceId: mapping.thread.resourceId });
  const pending = runs.flatMap((run) => run.toolCalls
    .filter((call) => call.requiresApproval && call.toolCallId)
    .map((call) => ({ runId: run.runId, call })));

  if (action === "approvals") {
    if (!pending.length) await thread.post("There are no pending approvals in this conversation.");
    else await thread.post(pending.map(({ call }) => `- \`${call.toolCallId}\` — \`${call.toolName ?? "tool"}\` ${call.args ? `\`${JSON.stringify(call.args)}\`` : ""}`).join("\n"));
    return true;
  }
  if (!callId) {
    await thread.post(`Usage: \`!${action} <toolCallId>\`. Use \`!approvals\` to list pending requests.`);
    return true;
  }
  const target = pending.filter(({ call }) => call.toolCallId === callId);
  if (target.length !== 1) {
    await thread.post("That approval is not pending in this conversation. Use `!approvals` to get a current ID.");
    return true;
  }
  const owner = owners(mapping.thread.metadata)[callId];
  if (!owner || owner.runId !== target[0].runId || owner.userId !== message.author.userId) {
    await thread.post("Only the member who requested this action can approve or deny it. Older requests without an owner must be made again.");
    return true;
  }
  const key = `${mapping.thread.id}:${callId}`;
  if (activeCommands.has(key)) {
    await thread.post("That approval is already being processed.");
    return true;
  }
  activeCommands.add(key);
  try {
    const before = new Set(pending.map(({ call }) => call.toolCallId!));
    ctx.requestContext.set("channel", {
      platform: thread.adapter.name,
      eventType: "message",
      threadId: thread.id,
      channelId: thread.channelId,
      isDM: thread.isDM,
      messageId: message.id,
      userId: message.author.userId,
      userName: message.author.fullName || message.author.userName,
    });
    await thread.post(action === "approve" ? "Approval received — processing the action…" : "Denial received — cancelling the action…");
    const stream = action === "approve"
      ? await agent.approveToolCall({ runId: target[0].runId, toolCallId: callId, requestContext: ctx.requestContext, memory: { thread: mapping.thread.id, resource: mapping.thread.resourceId } })
      : await agent.declineToolCall({ runId: target[0].runId, toolCallId: callId, requestContext: ctx.requestContext, memory: { thread: mapping.thread.id, resource: mapping.thread.resourceId } });
    // Observe the actual tool outcome; an empty assistant reply or a finished
    // stream alone does not prove that the approved action succeeded.
    let outcome: "success" | "failed" | "denied" | undefined;
    let interrupted = false;
    for await (const chunk of stream.fullStream) {
      if (chunk.type === "tool-result" && chunk.payload.toolCallId === callId) {
        outcome = chunk.payload.isError ? "failed" : "success";
      } else if (chunk.type === "tool-error" && chunk.payload.toolCallId === callId) {
        outcome = "failed";
      } else if (chunk.type === "tool-output-denied" && chunk.payload.toolCallId === callId) {
        outcome = "denied";
      } else if (chunk.type === "error" || chunk.type === "abort") {
        interrupted = true;
      }
    }
    const label = (target[0].call.toolName ?? "requested action").replace(/_/g, " ");
    const confirmation = outcome === "success" && action === "approve"
      ? `Done — ${label} completed successfully.`
      : outcome === "denied"
        ? `Denied — ${label} was not run.`
        : outcome === "failed"
          ? `The action failed (${label}). Please check its current state before trying again.`
          : `I received your decision, but couldn't confirm completion of ${label}. Please check its current state before trying again.`;
    await thread.post(confirmation);
    console.info("[approval] outcome", { action, toolCallId: callId, outcome: outcome ?? "unconfirmed", interrupted });
    await bindNewApprovals(thread, message, ctx, agent, before);
  } catch (error) {
    console.error("[approval] resume failed", error);
    await thread.post("I couldn't process that approval. It may already have been handled; use `!approvals` to check.");
  } finally {
    activeCommands.delete(key);
  }
  return true;
}

/** Show only approval requests; ordinary tool calls and their raw results stay hidden. */
export const renderApprovalCommand: ToolDisplayFn = (event) => {
  if (event.kind !== "approval") return undefined;
  const args = event.args ? `\nArguments: \`${JSON.stringify(event.args)}\`` : "";
  return {
    kind: "post",
    message: `Approval needed for **${event.displayName}**.\n\`!approve ${event.toolCallId}\` to continue or \`!deny ${event.toolCallId}\` to cancel.${args}`,
  };
};
