// Summon-sigil helpers shared by the web composer. Spawning goes through
// useChatMessageActions.spawnQueuedSession; this module only re-exports the
// shared sigil grammar.

export { SUMMON_SIGIL, looksLikeSummonSigil, parseSummonSigil } from '@atrium/surface-client';
