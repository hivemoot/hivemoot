// Re-export the war-room storage layer and redis-lock helper from a
// single entrypoint. Consumers can also reach `redis-lock` via the
// `./redis-lock` subpath export (see package.json) when they only
// need the lock primitive.
//
// Extension-less relative imports — both consumers (web's Turbopack
// + bot's tsc) compile the shared sources via `bundler` module
// resolution, which finds the `.ts` files without an explicit
// extension. (NodeNext would reject this; bot's tsconfig was
// switched off NodeNext for that reason — see the rationale comment
// in `bot/tsconfig.json`.)

export * from "./war-room";
export * from "./redis-lock";
