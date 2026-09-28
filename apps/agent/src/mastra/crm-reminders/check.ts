// Read-only production preflight: fetch/match without creating preferences or DMs.
import { fetchAssignments } from "./service";
import { resolveCrmUser } from "../mattermost/rest";

const { assignments } = await fetchAssignments();
const people = new Map(assignments.map((task) => [task.profileId, task]));
let matched = 0;
for (const person of people.values()) {
  try {
    await resolveCrmUser(person);
    matched++;
  } catch {
    // Avoid dumping CRM names/emails or service error bodies into deployment logs.
  }
}
console.info(
  JSON.stringify({
    activeAssignments: assignments.length,
    assignees: people.size,
    matched,
    unmatched: people.size - matched,
    messagesSent: 0,
  }),
);
