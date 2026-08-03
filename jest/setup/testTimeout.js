/**
 * setupFilesAfterEnv for every root jest project.
 *
 * `testTimeout` is a top-level-only option in jest 29 — it is silently dropped
 * from per-project configs — so the per-test budget has to be set from a setup
 * file instead.
 *
 * Why raise it at all: the property-based suites run hundreds of fast-check
 * cases inside a single `it()`. Run on its own,
 * __tests__/services/chatCacheService.property27.test.ts finishes in ~5s, which
 * means that under jest's parallel workers it loses the CPU often enough to
 * cross the 5s default and fail as a timeout even though every generated case
 * passed. A larger budget does not change what any test asserts or how many
 * cases it generates.
 */
jest.setTimeout(30000);
