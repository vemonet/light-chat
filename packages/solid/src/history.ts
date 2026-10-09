import type { Message } from "./types.ts";

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: Date;
}

export interface Conversation extends ConversationSummary {
  messages: Message[];
  createdAt: Date;
}

/** A message matching a search, shown as one row in the sidebar */
export interface SearchHit {
  conversationId: string;
  /** Conversation title */
  title: string;
  /** Message to scroll to and highlight the query in when the hit is opened */
  messageId: string;
  /** Text around the match */
  snippet: string;
}

/** Where conversations are persisted, implement it to use your own API or database */
export interface HistoryStore {
  /** Conversations to show in the sidebar, most recent first */
  list(): Promise<ConversationSummary[]>;
  get(id: string): Promise<Conversation | undefined>;
  /** Create or update a conversation, called after each message and response */
  save(conversation: Conversation): Promise<void>;
  delete(id: string): Promise<void>;
  /** Messages matching the query, one hit per message, most recent first. The sidebar search is hidden without it */
  search?(query: string): Promise<SearchHit[]>;
}

/** Case-insensitive search in the text of the messages, one hit per matching message, conversations in the given order */
export function searchConversations(conversations: Conversation[], query: string, limit = 100): SearchHit[] {
  const q = query.trim().toLowerCase();
  const hits: SearchHit[] = [];
  if (!q) return hits;
  for (const c of conversations) {
    for (const m of c.messages) {
      const text = m.parts
        .map((p) => (p.type === "text" ? p.text : ""))
        .join(" ")
        // Drop common markdown markers (emphasis, code, headings) so the snippet reads like the rendered text
        .replace(/[*`]+/g, "")
        .replace(/^#{1,6}\s|\n#{1,6}\s/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const i = text.toLowerCase().indexOf(q);
      if (i < 0) continue;
      // Some context before the match, the rest is cut by CSS
      const start = Math.max(0, i - 30);
      const snippet = (start ? "..." : "") + text.slice(start, i + q.length + 100);
      hits.push({ conversationId: c.id, title: c.title, messageId: m.id, snippet });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

/** Default history store, conversations are kept in the browser IndexedDB */
export class IndexedDBHistory implements HistoryStore {
  #name: string;
  #db?: Promise<IDBDatabase>;

  constructor(name = "light-chat") {
    this.#name = name;
  }

  /** Run a request on the conversations object store, the database is opened on first use */
  async #run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    this.#db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(this.#name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("conversations", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB unavailable"));
    });
    const db = await this.#db;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction("conversations", mode).objectStore("conversations"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
    });
  }

  async list(): Promise<ConversationSummary[]> {
    const all = await this.#run<Conversation[]>("readonly", (s) => s.getAll());
    return all
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  }

  get(id: string): Promise<Conversation | undefined> {
    return this.#run<Conversation | undefined>("readonly", (s) => s.get(id));
  }

  async save(conversation: Conversation): Promise<void> {
    await this.#run("readwrite", (s) => s.put(conversation));
  }

  async delete(id: string): Promise<void> {
    await this.#run("readwrite", (s) => s.delete(id));
  }

  async search(query: string): Promise<SearchHit[]> {
    const all = await this.#run<Conversation[]>("readonly", (s) => s.getAll());
    all.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    return searchConversations(all, query);
  }
}
