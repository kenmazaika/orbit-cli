# orbit-cli

Universal command-line interface for [Orbit](https://github.com/kenmazaika/orbit-blog) — a private,
object-backed workspace for documents, artifacts, inbox decisions, and agent collaboration.

It talks only to the Orbit HTTP API (`/api/v1`). It has no database driver, no vault dependency, and no
built-in agent runtime: agents are attached through adapters (OpenClaw is the first one).

## Install

```bash
npm install -g orbit-cli     # or: npx orbit-cli
orbit --help
```

Requires Node 22+.

## Connect

```bash
orbit login --url https://orbit.example.com --token "$ORBIT_TOKEN"
orbit status
```

The token is stored in `~/.config/orbit/config.json` (mode 0600). Override with `ORBIT_URL` and
`ORBIT_TOKEN`, or point `ORBIT_CONFIG` at another file. Tokens are workspace-scoped; the server derives the
workspace from the token, never from the request body.

## Commands

```bash
# Objects (universal)
orbit object create --kind orbit.document --title "Draft" [--external-id id] [--data '{"k":"v"}']
orbit object get <id>
orbit object list [--kind k] [--status s]
orbit object update <id> [--title t] [--status s] [--data json]
orbit object revisions <id> [--create --file draft.md]
orbit object relations <id> [--add --to <id> --relation cites]

# Artifacts (document review with immutable revisions)
orbit artifact create --title "Post" [--id slug]
orbit artifact show <id>
orbit artifact revisions <id>
orbit artifact revise <id> --file revised.md
orbit artifact feedback <id> --text "tighten the intro"

# Inbox (messages and decision cards)
orbit inbox send --title "Review this" --body-file ./note.md
orbit inbox send --title "Which approach?" --actions "Option A" --actions "Option B" --actions "Something else"
orbit inbox list [--status open|closed] [--json]
orbit inbox show <id> --json
orbit inbox respond <id> --choice "Option A" [--text "why"]
orbit inbox close <id>

# Articles (private Orbit documents, not a public blog)
orbit article create --title "Draft"
orbit article publish --id <id> --file draft.md
orbit article revise <id> --file revised.md
orbit article feedback <id> --text "..."

# Agent actions
orbit actions pending --json
orbit actions claim <id>
orbit actions progress <id> --message "Revising"
orbit actions complete <id> [--revision <revId>]
orbit actions fail <id> --error "reason"

# Live-ish helpers (polling)
orbit watch [--object <id>] [--interval 2]
orbit bridge status
orbit bridge run --script ./my-adapter.mjs
```

Global flags: `--json`, `--file`, `--stdin`, `--text`. Exit codes: `0` ok, `1` error, `2` usage, `3` auth.

## Agent bridge

`orbit bridge run` is a transport shell; execution is an adapter. Set `ORBIT_BRIDGE_SCRIPT` or pass
`--script` to a Node module that exports the agent loop. The bridge in the reference deployment:

- polls `GET /api/v1/agent/actions` every 2 s;
- claims an action transactionally (`POST .../claim`) with a lease;
- dispatches to an agent runtime;
- reports `progress`, then `complete` or `fail`;
- never runs two consumers for the same queue.

The Orbit API is authoritative: D1 stores actions, leases, revisions, and events. A dropped connection loses
nothing; pending work is still there on reconnect.

## Self-hosting

Deploy the Orbit Worker + D1 (see the Orbit application repo), mint a scoped agent token, then point the CLI
at your URL. The CLI has no personal paths and no OpenClaw-specific requirement; OpenClaw is one adapter.

## Security

- Tokens are bearer tokens; treat them like passwords. Never commit `~/.config/orbit/config.json`.
- The CLI never sends document bodies anywhere except your configured Orbit base URL.
- Document content is untrusted input: only explicit human submissions create agent actions.

MIT licensed.
