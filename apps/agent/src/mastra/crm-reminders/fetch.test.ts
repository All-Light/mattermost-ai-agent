import { describe, expect, test } from "bun:test";
import type { Page, QuerySpec } from "../crm/client";
import { fetchAssignments } from "./service";

const a = "00000000-0000-4000-8000-000000000001";
const b = "00000000-0000-4000-8000-000000000002";
function task(id: string, assignees: string[] = [a]) {
  return { id, title: id, description: "", status: "To do", due_date: null, assignees };
}
function page(rows: Record<string, unknown>[], truncated = false): Page {
  return { rows, total: null, truncated };
}

describe("CRM assignment snapshot fetch", () => {
  test("filters active assigned tasks and fetches only referenced profiles", async () => {
    const calls: QuerySpec[] = [];
    const result = await fetchAssignments(async (spec) => {
      calls.push(spec);
      return spec.table === "tasks" ? page([task("task-1", [a, b])]) : page([
        { id: a, name: "A", email: "a@example.com" },
        { id: b, name: "B", email: "b@example.com" },
      ]);
    });
    expect(calls[0]?.filters).toEqual({ status: 'in.("To do","In progress")', assignees: "not.eq.{}" });
    expect(calls[0]?.select).toBe("id,title,description,status,due_date,assignees");
    expect(calls[1]?.filters).toEqual({ id: `in.(${a},${b})` });
    expect(calls[1]?.select).toBe("id,name,email");
    expect(result.assignments).toHaveLength(2);
  });

  test("does not query profiles for an empty task snapshot", async () => {
    const tables: string[] = [];
    expect(await fetchAssignments(async (spec) => { tables.push(spec.table); return page([]); })).toEqual({ assignments: [], profiles: [] });
    expect(tables).toEqual(["tasks"]);
  });

  test("paginates a full task snapshot and batches profile lookups by 100", async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    const tasks = ids.map((id, i) => task(`task-${String(i).padStart(3, "0")}`, [id]));
    const calls: QuerySpec[] = [];
    const result = await fetchAssignments(async (spec) => {
      calls.push(spec);
      if (spec.table === "tasks") {
        const offset = spec.offset ?? 0;
        return page(tasks.slice(offset, offset + 200));
      }
      const selected = new Set(spec.filters!.id!.slice(4, -1).split(","));
      return page(ids.filter((id) => selected.has(id)).map((id) => ({ id, name: "", email: "" })));
    });
    expect(calls.filter((c) => c.table === "tasks").map((c) => c.offset ?? 0)).toEqual([0, 200]);
    const profileCalls = calls.filter((c) => c.table === "profiles");
    expect(profileCalls).toHaveLength(3);
    expect(profileCalls.map((c) => c.filters!.id!.slice(4, -1).split(",").length)).toEqual([100, 100, 1]);
    expect(result.assignments).toHaveLength(201);
  });

  test("aborts on source failure, truncated pages, repeated rows, and unsafe IDs", async () => {
    await expect(fetchAssignments(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    await expect(fetchAssignments(async () => page([task("x")], true))).rejects.toThrow("truncated");
    await expect(fetchAssignments(async () => page([task("x"), task("x")]))).rejects.toThrow("repeated");
    await expect(fetchAssignments(async (spec) => spec.table === "tasks" ? page([task("x", [`${a}),id.neq.${b}`])]) : page([]))).rejects.toThrow("profile ID");
  });
});
