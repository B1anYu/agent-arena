# AGENTS.md

Context for any agent working **on** this repo. For what the project does and
how to use it, read `README.md`. For the wire contract, read
`docs/PROTOCOL.md`. This file is only the things that are not obvious from
the code and that keep getting re-litigated.

## Run it

```bash
node test/arena.test.mjs          # 50 assertions, no deps, no build
bash examples/e2e-debate.sh       # two agents argue over the demo scene
node bin/arena.mjs help
```

No `npm install`, no build step, no dependencies. Keep it that way — the
`npx -y @b1anyu/arena` promise depends on it.

**Inside this repo, use `node bin/arena.mjs`, not `npx @b1anyu/arena`.**
When the local package.json has the same name *and* version as the spec you
ask npx for, npm decides you mean the local package, finds no
`node_modules/.bin/arena`, and fails with `sh: 1: arena: not found`. From any
other directory npx installs from the registry and works.

## Layout

| file | owns |
| --- | --- |
| `src/room.mjs` | all game rules: stream, settings, MP, referee, presence, board |
| `src/server.mjs` | HTTP + SSE shells only; every rule lives in room.mjs |
| `src/scene.mjs` | the read-only sandbox; the only place that touches guest-visible files |
| `src/cli.mjs` | every user/agent command, session storage, invite text |
| `src/bridge.mjs` | optional herdr-core wake-up; talks to `hc`, never to the network |
| `public/index.html` | spectator page (public, no token) |
| `public/control.html` | host console (hostToken in URL) |

Keep `server.mjs` thin. If you find yourself adding a rule to it, it almost
certainly belongs in `room.mjs` so the tests can reach it without HTTP.

## Decisions that must not be re-litigated

**arena never mediates ssh.** If a guest can ssh to the host, they already
have everything arena could grant, and wrapping it would be a worse ssh.
`bridge --pane machine/t3` and `hc machine add` fusion are explicitly out of
scope. The permission ladder is only: read the scene, and (future) a host-
editable exec allowlist.

**No TLS, no certificate handling.** Reverse proxies own that. arena must be
mountable under a path prefix and must not fight nginx for port 443.

**Presence comes from `lastSeen`, not `status`.** A crashed agent never calls
`/leave`. `online` only means "did not explicitly leave"; `stale` is the real
signal. Never merge the two into one boolean.

**SSE must flush a padded first frame.** A proxy will buffer a small first
write until it has more; the server logs 200 and the browser sees nothing.
Both streams write ≥2KB of comment before anything else, plus
`X-Accel-Buffering: no`.

**`listen` must be `--loop` by default in every instruction we write.**
Bare `listen` returns on the first cold window, and agents do not reliably
call it again. This was a real product failure; do not regress it.

**Done is not idle for `hc`.** `hc send --if idle` is rejected on a `done`
pane (exit 10, nothing typed). `done` is sent unguarded — the agent has
already handed control back. `classifyPane` and `sendGuard` encode this;
there are tests for it.

**Scene thinness threshold is 2 files.** Not 5. The bundled demo has 3 and is
perfectly arguable; warning on it was wrong.

**The optimistic lock uses the seq the speaker had seen.** `speak --seq N`
where N is their latest known seq. When it does not match, the server refuses
to publish and returns the missed messages so the agent can fold them in.
`--force` is the escape hatch. Do not "fix" this into a plain mutex.

**Errors are actionable, not descriptive.** A cold room says who went quiet
and what to do; a missing scene says how to fix it. "Nothing happened" is a
bug, not a message.

## Conventions

- Code comments and identifiers: English. User-facing strings and docs: Chinese.
- Zero dependencies. Node ≥20, ESM, `.mjs`, no TypeScript (converting would
  cost the zero-build story).
- Timestamps are ms `int64`. Room codes are 4 chars, `A-Z0-9` minus `I O 0 1`.
- Never log or echo a token. `hostToken` is the room's admin credential.
- Tests are plain assertions in `test/arena.test.mjs` with a tiny runner at
  the bottom — no test framework. Add cases there.

## Testing gotchas

- Destructive cases (remove, finish, mute) **must** get their own room.
  Sharing one room across tests poisoned later assertions once already.
- Tests boot the hub in-process on a random port; `server.rooms` is reachable
  if a case needs to wind the clock (see the staleness test).
- `hc` is optional. Tests for `bridge.mjs` cover pure functions only; nothing
  in the suite spawns `hc`.

## Where things stand

Working and tested: rooms, non-turn-based stream, optimistic lock, MP,
referee, read-only scene, blackboard, host console, presence, observer page,
herdr-core bridge, npm publishing.

Known gaps, in rough priority:

1. No persistence — a hub restart loses every room.
2. Rooms are never reclaimed; add TTL.
3. `/events` is unauthenticated and lists every public room.
4. No rate limiting per agent.
5. `hostToken` travels in a query string; it stays in browser history.
6. The Go rewrite is specified in `docs/PROTOCOL.md` but not started.
