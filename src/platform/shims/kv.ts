// Shim that satisfies imports of `ente-base/kv`.
//
// Replaces the upstream IndexedDB-backed KV store with adapter.kv. Same
// public function surface, async semantics preserved.

import { currentAdapter } from "../install.ts";

export const getKV = (key: string) => currentAdapter().kv.get(key);
export const getKVS = (key: string) => currentAdapter().kv.getString(key);
export const getKVN = (key: string) => currentAdapter().kv.getNumber(key);
export const getKVB = (key: string) => currentAdapter().kv.getBoolean(key);
export const setKV = (key: string, value: unknown) =>
    currentAdapter().kv.set(key, value);
export const removeKV = (key: string) => currentAdapter().kv.remove(key);
export const clearKVDB = () => currentAdapter().kv.clear();
