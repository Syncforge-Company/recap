#!/usr/bin/env npx tsx
/**
 * test-speaker-names.ts — SPEAKER_NAMES maps Discord ids/usernames/nicknames
 * to the names used in transcripts and minutes.
 *
 * Run:  npx tsx tests/test-speaker-names.ts
 */
process.env.SPEAKER_NAMES = 'th1=Théo, RonaldYop65 = Ronald ,894012839071719456=Davi,broken,=x';

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function main() {
  const { Config, aliasFor } = await import('../src/config');
  assert(Config.SPEAKER_NAMES.size === 3, `3 valid pairs parsed (got ${Config.SPEAKER_NAMES.size})`);
  assert(aliasFor(['1', 'th1', 'Th1'], 'th1') === 'Théo', 'username match');
  assert(aliasFor(['2', 'x', 'ronaldyop65'], 'ronaldyop65') === 'Ronald', 'case-insensitive match, spaces trimmed');
  assert(aliasFor(['894012839071719456', 'davi'], 'Davi Peterson') === 'Davi', 'user id match');
  assert(aliasFor(['3', 'alguem'], 'Alguém') === 'Alguém', 'falls back to the Discord name');
  assert(aliasFor([null, undefined], 'X') === 'X', 'ignores empty candidates');
  console.log('✅ SPEAKER_NAMES maps ids, usernames and nicknames');
}

main().then(() => console.log('\nAll speaker name tests passed.')).catch((err) => {
  console.error(err);
  process.exit(1);
});
