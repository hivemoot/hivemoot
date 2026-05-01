// Test-wide env defaults. The bot's WarRoomStore + getRedisClient()
// require HIVEMOOT_REDIS_REST_URL/TOKEN at construction time; tests
// that don't deliberately remove them get sensible placeholders so
// the construction path runs (mocked downstream consumers don't hit
// the real URL). Individual tests can `delete process.env.…` in a
// `beforeEach` to assert the misconfiguration path.
process.env.HIVEMOOT_REDIS_REST_URL ??= "https://redis.example/test";
process.env.HIVEMOOT_REDIS_REST_TOKEN ??= "test-redis-token";
