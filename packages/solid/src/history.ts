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

/** Where conversations are persisted, implement it to use your own API or database */
export interface HistoryStore {
  /** Conversations to show in the sidebar, most recent first */
  list(): Promise<ConversationSummary[]>;
  get(id: string): Promise<Conversation | undefined>;
  /** Create or update a conversation, called after each message and response */
  save(conversation: Conversation): Promise<void>;
  delete(id: string): Promise<void>;
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
}
