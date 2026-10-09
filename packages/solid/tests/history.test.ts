import { expect, test } from "vite-plus/test";
import { searchConversations, type Conversation } from "../src/history.ts";

const conversation = (id: string, texts: string[]): Conversation => ({
  id,
  title: `Title ${id}`,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  messages: texts.map((text, i) => ({
    id: `${id}-${i}`,
    role: i % 2 ? "assistant" : "user",
    parts: [{ type: "text", text }],
    createdAt: new Date(0),
  })),
});

test("searchConversations returns one hit per matching message, case-insensitive", () => {
  const conversations = [
    conversation("a", ["What is a Protein?", "A protein is made of amino acids.\n\nProteins fold."]),
    conversation("b", ["Hello", "Hi"]),
    conversation("c", ["protein again"]),
  ];
  const hits = searchConversations(conversations, " PROTEIN ");
  expect(hits.map((h) => h.messageId)).toEqual(["a-0", "a-1", "c-0"]);
  expect(hits[1]).toMatchObject({ conversationId: "a", title: "Title a" });
  // Whitespace is collapsed in the snippet
  expect(hits[1].snippet).toBe("A protein is made of amino acids. Proteins fold.");
  expect(searchConversations(conversations, "")).toEqual([]);
  expect(searchConversations(conversations, "protein", 2)).toHaveLength(2);
});

test("searchConversations snippet starts shortly before the match", () => {
  const hits = searchConversations([conversation("a", [`${"x ".repeat(50)}needle`])], "needle");
  expect(hits[0].snippet.startsWith("...")).toBe(true);
  expect(hits[0].snippet.endsWith("needle")).toBe(true);
  expect(hits[0].snippet.length).toBeLessThan(40);
});
