import { createMattermostAdapter } from "chat-adapter-mattermost";

// Shared with the agent's channel handler and proactive CRM DMs. Laziness also
// lets non-network tests import reminder logic without Mattermost credentials.
let singleton: ReturnType<typeof createMattermostAdapter> | undefined;
export function getMattermostAdapter() {
  return (singleton ??= createMattermostAdapter());
}

export async function sendMattermostDm(userId: string, markdown: string) {
  const adapter = getMattermostAdapter();
  const threadId = await adapter.openDM(userId);
  const post = await adapter.postMessage(threadId, { markdown });
  const channelId = adapter.channelIdFromThreadId(threadId);
  return { postId: post.id, threadId, channelId };
}
