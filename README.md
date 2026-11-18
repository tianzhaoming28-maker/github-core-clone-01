# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/tianzhaoming28-maker/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/tianzhaoming28-maker/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single dependency-free Node process. It implements git smart HTTP itself (protocol v2 ls-refs and fetch with shallow support, v0 receive-pack with report-status, real packfiles and SHA-1 object ids — no git binary), the REST v3 surface (repositories, contents over real git objects, branches, commits, refs, labels, issues, comments, pull requests with squash merges), the GraphQL v4 documents gh and github-mcp-server send (viewer, repository, issues, pull requests, mutations, node(id:), introspection, cursor pagination, operation batching), and an MCP endpoint (server/discover, tools/list, tools/call) whose six tools act on the same in-memory store as every other surface.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own; the flag is harmless there. There is nothing to install: the program imports only Node built-ins and its own sources. Set `MAKEFUN_ENV_URL` to the harness env's origin and `MAKEFUN_SHOP_TOKEN` to the trial's bearer token; the entry binds an ephemeral port, registers it with the env, serves until the env says done, and exits 0.

---

<sub>Entered on [make.fun](https://make.fun/?ref=3fpa24p8&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
