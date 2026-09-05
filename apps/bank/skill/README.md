# Client skill

`bank/SKILL.md` is a Claude Code skill that teaches agents on a client machine that the archive exists and how to query it. Install it wherever you run agents:

```sh
cp -r skill/bank ~/.claude/skills/bank
```

The skill assumes a `bank` binary on `PATH` and a remote server, so put the two env vars in the shell profile (`~/.zshrc`) — a skill cannot export them itself:

```sh
export BANK_URL=http://vps.tailnet.ts.net:8480
export BANK_TOKEN=bank_...            # ssh vps bank token new <machine>, printed once
```

Verify with `bank stats`; the skill's own preflight uses the same command and knows how to read each failure.

On the VPS the skill works unchanged: leave `BANK_URL` unset there and the CLI talks to `DATABASE_URL` directly.
