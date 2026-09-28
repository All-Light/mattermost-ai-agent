import { afterEach, expect, test } from "bun:test";
import { resolveCrmUser } from "../mattermost/rest";

const realFetch = globalThis.fetch;
const originalUrl = process.env.MATTERMOST_BASE_URL;
const originalToken = process.env.MATTERMOST_BOT_TOKEN;
afterEach(() => {
  globalThis.fetch = realFetch;
  if (originalUrl === undefined) delete process.env.MATTERMOST_BASE_URL;
  else process.env.MATTERMOST_BASE_URL = originalUrl;
  if (originalToken === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
  else process.env.MATTERMOST_BOT_TOKEN = originalToken;
});
function mock(status: number) {
  process.env.MATTERMOST_BASE_URL = "https://mattermost.test";
  process.env.MATTERMOST_BOT_TOKEN = "test-only";
  const paths: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    paths.push(String(url));
    if (paths.length === 1)
      return Response.json({ message: "lookup failure" }, { status });
    return Response.json({
      id: "mm-id",
      email: "asa.test@uuais.com",
      username: "asa.test",
      delete_at: 0,
    });
  }) as typeof fetch;
  return paths;
}
test("definite missing email falls back to normalized firstname.lastname", async () => {
  const paths = mock(404);
  expect(
    (await resolveCrmUser({ email: "missing@example.test", name: "Åsa Test" }))
      .id,
  ).toBe("mm-id");
  expect(paths).toHaveLength(2);
  expect(paths[1]).toContain("asa.test%40uuais.com");
});
test("transient error never tries a different identity", async () => {
  const paths = mock(503);
  await expect(
    resolveCrmUser({ email: "outage@example.test", name: "Someone Else" }),
  ).rejects.toThrow();
  expect(paths).toHaveLength(1);
});
