// Re-export the war-room storage layer and redis-lock helper from a
// single entrypoint. Consumers can also reach `redis-lock` via the
// `./redis-lock` subpath export (see package.json) when they only
// need the lock primitive.
//
// `.js` suffixes are required for consumers that compile with
// `moduleResolution: "NodeNext"` (e.g. the bot); they're tolerated
// by `bundler` resolution (e.g. web) so the same form works in
// both contexts.

export * from "./war-room.js";
export * from "./redis-lock.js";
