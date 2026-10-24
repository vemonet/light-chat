export const uid = () => Math.random().toString(36).slice(2, 12);

/** Readable tool name: get_weather or getWeather become "Get weather" */
export const humanize = (name: string) => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`)
    .replace(/[_-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

export interface PatchOperation {
  op: "add" | "remove" | "replace" | "move" | "copy" | "test";
  path: string;
  from?: string;
  value?: unknown;
}

/** Apply a JSON Patch (RFC 6902) to a copy of `doc`. `test` operations are ignored */
export function applyPatch<T>(doc: T, ops: PatchOperation[]): T {
  let root: any = structuredClone(doc);
  // JSON Pointer to keys: "/a/b~1c" -> ["a", "b/c"]
  const keysOf = (pointer: string) =>
    pointer
      .split("/")
      .slice(1)
      .map((k) => k.replace(/~1/g, "/").replace(/~0/g, "~"));
  const get = (keys: string[]) => keys.reduce((o, k) => o?.[k], root);
  const remove = (keys: string[]) => {
    const parent = get(keys.slice(0, -1));
    const key = keys[keys.length - 1];
    if (Array.isArray(parent)) parent.splice(Number(key), 1);
    else if (parent) delete parent[key];
  };
  // Add inserts in arrays, replace overwrites. "-" appends to an array
  const put = (keys: string[], value: unknown, insert: boolean) => {
    if (!keys.length) return void (root = value);
    const parent = get(keys.slice(0, -1));
    const key = keys[keys.length - 1];
    if (Array.isArray(parent)) {
      if (key === "-") parent.push(value);
      else parent.splice(Number(key), insert ? 0 : 1, value);
    } else if (parent) parent[key] = value;
  };
  for (const { op, path, from, value } of ops) {
    const keys = keysOf(path);
    if (op === "remove") remove(keys);
    else if (op === "add" || op === "replace") put(keys, structuredClone(value), op === "add");
    else if (op === "move" || op === "copy") {
      const source = keysOf(from ?? "");
      const moved = structuredClone(get(source));
      if (op === "move") remove(source);
      put(keys, moved, true);
    }
  }
  return root;
}
