// env.ts — side-effect-only module. Import FIRST so process.env is
// populated before any ente module evaluates.
//
// ente/web/packages/base/app.ts runs an IIFE at module-load time that reads
// process.env.appName and bakes the result into clientPackageName. If
// appName is unset when that IIFE evaluates, clientPackageName becomes
// `undefined`, which downstream poisons publicRequestHeaders() and (as we
// learned the hard way) causes museum POSTs to hang.
//
// Strict import-order discipline: src/index.ts MUST import this file
// before any module that transitively imports ente-base/app.

// Endpoint precedence: DUCKLING_ENDPOINT wins, then ENTE_ENDPOINT, then a
// pre-set NEXT_PUBLIC_ENTE_ENDPOINT (the variable ente's own code reads),
// then ente's hosted service. Self-hosters point this at their museum.
const DEFAULT_MUSEUM = "https://api.ente.io";

const endpoint =
    process.env.DUCKLING_ENDPOINT ??
    process.env.ENTE_ENDPOINT ??
    process.env.NEXT_PUBLIC_ENTE_ENDPOINT ??
    DEFAULT_MUSEUM;
process.env.NEXT_PUBLIC_ENTE_ENDPOINT = endpoint;

// "photos" — the only sane choice; everything else in clientPackageName's
// dict is an alternative ente app we don't impersonate.
if (!process.env.appName) {
    process.env.appName = "photos";
}

export const MUSEUM_URL = process.env.NEXT_PUBLIC_ENTE_ENDPOINT;
