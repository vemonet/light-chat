import { expect, test } from "vite-plus/test";
import { applyPatch } from "../src/utils.ts";

test("applyPatch applies JSON Patch operations to a copy", () => {
  const doc = { a: { b: 1 }, list: [1, 2], "x/y": 0 };
  const out = applyPatch(doc, [
    { op: "add", path: "/list/1", value: 9 },
    { op: "add", path: "/list/-", value: 3 },
    { op: "replace", path: "/a/b", value: 2 },
    { op: "remove", path: "/x~1y" },
    { op: "copy", from: "/a", path: "/c" },
    { op: "move", from: "/list/0", path: "/first" },
    { op: "test", path: "/a/b", value: 2 },
  ]);
  expect(out).toEqual({ a: { b: 2 }, c: { b: 2 }, list: [9, 2, 3], first: 1 });
  expect(doc).toEqual({ a: { b: 1 }, list: [1, 2], "x/y": 0 });
  expect(applyPatch(doc, [{ op: "replace", path: "", value: [1] }])).toEqual([1]);
});
