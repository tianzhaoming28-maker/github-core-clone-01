// The forge's notion of who exists.
//
// The trial hands this server exactly one credential: a bearer token in the
// MAKEFUN_SHOP_TOKEN environment variable. Every surface the suite speaks to
// addresses data by login — /api/v3/repos/{login}/{repo}, the GraphQL
// viewer { login }, the git remote /{login}/{repo}.git — and the login the
// token names is the scenario viewer's. The scenario itself is a published,
// deterministic function of one constant seed (the kit ships it as wire.ts so
// entrants can reproduce it), so the forge derives the same identities here
// instead of guessing: the token's owner, their two neighbours in the user
// list, and the organisation name. Nothing else about the scenario is needed:
// repositories, issues and pull requests are all created through the API.

/** The one seed every scenario value derives from (the kit's SCENARIO_SEED). */
const SCENARIO_SEED = 0x6a09e667f3bcc909n;
/** 2^64 - 1: every hash and state below is kept inside 64 bits. */
const U64_MASK = (1n << 64n) - 1n;

/** FNV-1a over UTF-16 code units, 64-bit: a label's stable seed contribution. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: spreads a seeded value's bits across the whole word. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/**
 * A xorshift64* stream: three shifts and one multiply per step, seeded from a
 * label under the scenario seed. The same label gives the same stream in any
 * process, which is the whole point — the forge and the suite agree on the
 * identities without ever exchanging them.
 */
class Stream {
  private state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.state = masked === 0n ? SCENARIO_SEED : masked;
  }

  static fromLabel(label: string): Stream {
    return new Stream(mix64(SCENARIO_SEED ^ fnv1a64(label)));
  }

  /** The next 64-bit value. */
  nextU64(): bigint {
    let x = this.state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  /** The next 32-bit value, from the top half of the next 64-bit one. */
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, maxExclusive), unbiased by rejection sampling. */
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  /** One element of `items`, uniformly. */
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

/** The name pools the scenario's user and organisation generators draw from. */
const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];
const ORG_ADJECTIVES: readonly string[] = [
  'amber', 'brisk', 'calm', 'crisp', 'eager', 'faint', 'gentle', 'happy', 'idle', 'jolly', 'keen', 'lively',
  'mellow', 'nimble', 'open', 'plain', 'quick', 'quiet', 'rapid', 'soft', 'steady', 'tidy', 'upbeat',
  'vivid', 'warm', 'witty', 'young', 'zesty',
];
const ORG_NOUNS: readonly string[] = [
  'acorn', 'badger', 'canyon', 'cedar', 'comet', 'coral', 'delta', 'ember', 'falcon', 'glade', 'harbor',
  'indigo', 'juniper', 'kettle', 'lantern', 'meadow', 'nebula', 'orchid', 'pebble', 'quartz', 'raven',
  'saffron', 'thistle', 'umber', 'violet', 'willow', 'yarrow', 'zephyr',
];

/** One person in the scenario's user list. */
export interface ForgeUser {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/** `count` users with unique logins, drawn from the 'users' stream in order. */
function generateUsers(count: number): ForgeUser[] {
  const rng = Stream.fromLabel('users');
  const used = new Set<string>();
  const users: ForgeUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

/** The scenario's twelve users; index 0 owns the token, 1 and 2 are the other logins checks use. */
export const USERS: readonly ForgeUser[] = generateUsers(12);
/** The token's owner: every repository the forge holds belongs to this login. */
export const VIEWER: ForgeUser = USERS[0];
/** The second user (a collaborator in the scenario; the forge only needs the login to 404 politely). */
export const TEAMMATE: ForgeUser = USERS[1];
/** The third user: the stranger whose name on a repository path must read as not-found. */
export const STRANGER: ForgeUser = USERS[2];

/** The scenario's organisation name, from the 'org' stream. */
export const ORG_LOGIN: string = (() => {
  const rng = Stream.fromLabel('org');
  return `${rng.pick(ORG_ADJECTIVES)}-${rng.pick(ORG_NOUNS)}-org`;
})();

/** Look a user up by login (the forge knows the twelve scenario users and no one else). */
export function userByLogin(login: string): ForgeUser | null {
  for (const user of USERS) if (user.login === login) return user;
  return null;
}
