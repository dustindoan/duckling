// SQLite-backed KVStore implementation.
//
// Replaces ente-base/kv (which uses `idb`). Persists to a single .db file
// so a token survives between invocations. Defaults to ~/.duckling/state.db;
// override with $DUCKLING_STATE_DIR (or $ENTE_HELPER_STATE_DIR, kept for
// the CoralStack app, which predates the rename).
//
// JSON-serialize everything to keep the schema simple. Tagged with the
// original JS type so getKVS/N/B can return the right shape.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { KVStore } from "./adapter.ts";

export const stateDir = (): string => {
    const override =
        process.env.DUCKLING_STATE_DIR ?? process.env.ENTE_HELPER_STATE_DIR;
    if (override) return override;
    return join(homedir(), ".duckling");
};

const dbPath = (): string => join(stateDir(), "state.db");

export class SqliteKV implements KVStore {
    private db: Database;

    constructor(path?: string) {
        const dir = stateDir();
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.db = new Database(path ?? dbPath());
        // Two duckling processes may share this file (the CoralStack app's
        // helper + a CLI invocation). bun:sqlite defaults to no busy
        // timeout, so a concurrent write throws SQLITE_BUSY immediately;
        // WAL + a generous busy_timeout makes cross-process sharing safe.
        this.db.run("PRAGMA journal_mode = WAL");
        this.db.run("PRAGMA busy_timeout = 5000");
        this.db.run(`
            CREATE TABLE IF NOT EXISTS kv (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                type TEXT NOT NULL
            )
        `);
    }

    async get(key: string): Promise<unknown> {
        const row = this.db
            .query<{ value: string; type: string }, [string]>(
                "SELECT value, type FROM kv WHERE key = ?",
            )
            .get(key);
        if (!row) return undefined;
        return decode(row.value, row.type);
    }

    async getString(key: string): Promise<string | undefined> {
        const v = await this.get(key);
        return typeof v === "string" ? v : undefined;
    }

    async getNumber(key: string): Promise<number | undefined> {
        const v = await this.get(key);
        return typeof v === "number" ? v : undefined;
    }

    async getBoolean(key: string): Promise<boolean | undefined> {
        const v = await this.get(key);
        return typeof v === "boolean" ? v : undefined;
    }

    async set(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            await this.remove(key);
            return;
        }
        const [encoded, type] = encode(value);
        this.db.run(
            "INSERT OR REPLACE INTO kv (key, value, type) VALUES (?, ?, ?)",
            [key, encoded, type],
        );
    }

    async remove(key: string): Promise<void> {
        this.db.run("DELETE FROM kv WHERE key = ?", [key]);
    }

    async clear(): Promise<void> {
        this.db.run("DELETE FROM kv");
    }

    close(): void {
        this.db.close();
    }
}

const encode = (value: unknown): [string, string] => {
    if (typeof value === "string") return [value, "string"];
    if (typeof value === "number") return [String(value), "number"];
    if (typeof value === "boolean") return [value ? "1" : "0", "boolean"];
    return [JSON.stringify(value), "json"];
};

const decode = (value: string, type: string): unknown => {
    switch (type) {
        case "string":
            return value;
        case "number":
            return Number(value);
        case "boolean":
            return value === "1";
        case "json":
            return JSON.parse(value);
        default:
            return value;
    }
};
