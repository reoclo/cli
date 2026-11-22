# Secrets from Bitwarden and 1Password, and safe deletes

`secrets ls` shows where each secret comes from and whether it is in sync. `--source` filters by origin (`manual`, `bitwarden`, `onepassword`). With `-o json` the rows are the API's, filtered but otherwise unchanged.

```bash
reoclo secrets ls --project prod
# KEY          VERSION  SOURCE    SYNC    LAST SYNCED
# DB_PASSWORD  3        bitwarden synced  2026-11-01T09:12:44Z
# SENTRY_DSN   1        manual    -       -
reoclo secrets ls --project prod --source bitwarden

# Who reads this secret? Applications and stacks, by env reference or project binding
reoclo secrets usage DB_PASSWORD --project prod

# Synced secrets whose Bitwarden or 1Password connection was removed (add --project to narrow)
reoclo secrets orphans
reoclo secrets orphans --project prod -o json

# Stop syncing one secret; the value stays in Reoclo and becomes a manual secret
reoclo secrets detach DB_PASSWORD --project prod

# Detach every secret from one source (--all needs --source)
reoclo secrets detach --all --source bitwarden --project prod --yes
```

`secrets detach` asks before it changes anything (`--yes` skips the prompt) and reports how many secrets it detached. A manual secret is already detached, so the command says so and makes no API call.

`secrets orphans` lists synced secrets that lost their connection. Removing a connection in the dashboard detaches its secrets by default, so orphans only appear when someone chose to keep them as they were. They stay read-only until you detach them.

`secrets rm` lists the applications and stacks that use the secret and asks you to confirm. A synced secret cannot be deleted until it is detached: pass `--detach` to detach and delete in one step, or run `secrets detach` first. When the secret's connection is still syncing, `secrets rm` also prints a warning from the API: the connection would overwrite an edited copy or bring a deleted one back, so detach it (which also stops the sync recreating it).

```bash
reoclo secrets rm DB_PASSWORD --project prod --detach
```

Every command that deletes something asks first and takes `--yes` to skip the prompt: `monitors rm`, `secrets rm`, `channels delete`, `schedule rm`, `providers rm`, `env rm`, `status-pages rm` and `profile rm`, alongside the ones that already did. Without a terminal and without `--yes` a delete aborts with exit code 1 instead of waiting for input.
