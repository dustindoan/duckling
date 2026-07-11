// Shim that satisfies imports of `ente-base/electron`.
//
// Aliased in via tsconfig paths. The functions and types here mirror the
// public surface of ../ente/web/packages/base/electron.ts that the upload
// code consumes — `ensureElectron`, focus/blur subscribers — but route
// through our PlatformAdapter-installed globalThis.electron instead of
// asserting an Electron host.
//
// Stays a stub until we have a smoke import to test against; expanding it
// is part of the "wire ente packages" task.

// Re-export the Electron interface type as ente expects. Resolved through
// the linked node_modules/ente-base package (see scripts/link-ente.sh) —
// NOT a relative filesystem escape, which would hardcode where the ente
// checkout lives relative to this repo (broke in CI, and for anyone whose
// checkout isn't literally at ../ente).
export type { Electron } from "ente-base/types/ipc";
import type { Electron } from "ente-base/types/ipc";

export const ensureElectron = (): Electron => {
    const et = (globalThis as { electron?: Electron }).electron;
    if (et) return et;
    throw new Error(
        "globalThis.electron unset; PlatformAdapter not installed?",
    );
};

// Focus/blur helpers are UI affordances; the helper has no window. Provide
// no-op replacements for the public API surface so call sites compile.
export const suppressMainWindowBlurForTrustedPrompt = (_durationMs?: number) => {};
export const shouldSuppressMainWindowBlur = () => false;
export const clearMainWindowBlurSuppression = () => {};
export const subscribeMainWindowFocus = (_listener: () => void) => () => {};
export const subscribeMainWindowBlur = (_listener: () => void) => () => {};
