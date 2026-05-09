// Re-export the war-room storage layer and redis-lock helper from a
// single entrypoint. Consumers can also reach `redis-lock` via the
// `./redis-lock` subpath export (see package.json) when they only
// need the lock primitive.
//
// `.ts` extensions in source: tsc compiles with
// `rewriteRelativeImportExtensions: true`, so the emitted dist/ has
// `.js` extensions — Node-native ESM-resolvable. The `.ts` form is
// what bundlers (web's Turbopack, vitest, esbuild) resolve literally
// from source.
export * from "./war-room.js";
export * from "./redis-lock.js";
export * from "./queen-verdict.js";
