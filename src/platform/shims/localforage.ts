// Shim that satisfies `import localForage from "localforage"`.
//
// ente's files-db.ts (ente-gallery/services/files-db) uses localforage for a
// small local cache of collections/files. The real package only works in a
// browser: its driver detection requires a working IndexedDB/WebSQL/
// localStorage backend, and under Bun it throws "No available storage method
// found" even with fake-indexeddb installed. Rather than fight that detection,
// we alias `localforage` (tsconfig paths) to this in-memory implementation.
//
// Scope: only the six methods files-db.ts/photos-fdb.ts actually call
// (config, ready, getItem, setItem, removeItem, clear). Storage is a plain
// in-process Map with the same lifetime fake-indexeddb data would have had —
// lost on restart, which is correct for a stateless helper (a fresh process
// re-pulls from remote with sinceTime=0).

const store = new Map<string, unknown>();

const localForage = {
    config(_options?: unknown): void {},

    async ready(): Promise<void> {},

    async getItem<T>(key: string): Promise<T | null> {
        return (store.has(key) ? (store.get(key) as T) : null);
    },

    async setItem<T>(key: string, value: T): Promise<T> {
        store.set(key, value);
        return value;
    },

    async removeItem(key: string): Promise<void> {
        store.delete(key);
    },

    async clear(): Promise<void> {
        store.clear();
    },
};

export default localForage;
