# Tunnels

The `tunnel` command opens authenticated TCP and UDP tunnels through a server's runner. It needs no SSH keys and no inbound firewall rules: the tunnel rides the runner's existing outbound WebSocket connection.

```bash
# Forward TCP (default)
reoclo tunnel <server> -L 5432:5432
reoclo tunnel <server> -L 8080:internal-db:5432       # remote host other than localhost
reoclo tunnel <server> -L 0.0.0.0:8080:internal:80    # bind explicitly

# Forward UDP
reoclo tunnel <server> -L 53:53 --udp

# Reverse TCP
reoclo tunnel <server> -R 8080:3000

# Multiple forwards in one session
reoclo tunnel <server> -L 5432:5432 -L 6379:6379

# Session management (live + history)
reoclo tunnel ls --server <server> --active
reoclo tunnel describe <tunnel-id>
reoclo tunnel close <tunnel-id>
```

Tunnels survive transient runner reconnects: if the runner disconnects briefly, the CLI parks the session and resumes once the runner is back. If the CLI itself loses its connection, it reconnects with backoff and gives up after `--reconnect-deadline` seconds (default 300).

Large transfers are fine. The CLI sends stream data in frames of at most 64 KiB, so a big upload through a tunnel no longer closes the connection.

## Saved tunnel recovery and desktop telemetry

From 0.116.0, the daemon automatically recovers enabled saved tunnels after a lost session or an offline pool, including tunnels without `keep_up`. A maximum-duration expiration opens a fresh session. Retries grow from 1 second to a 30-second cap with jitter. Disabling or removing the tunnel cancels recovery, and daemon shutdown cancels every timer. Authorization failures and operator closures still require action; quota failures remain visible until capacity is available.

The control API includes `retry: { attempt, next_at }` while a retry is scheduled. `next_at` is an RFC 3339 timestamp. `POST /v1/tunnels/:name/up` cancels the delay and retries immediately. Busy local listeners retain their separate 5 to 60 second retry schedule.

Terminal sessions publish cumulative payload counters to their temporary registration file once per second. The daemon includes them in its traffic events under `terminal:<id>`, so the desktop can graph terminal sessions alongside saved tunnels. Older running terminals must be restarted with the new CLI before they can report counters.

## Local certificate domains

CA trust permits `.test`, `.localhost`, `.internal`, `.home.arpa`, `.example` and `.invalid`, including their roots and subdomains. Names are normalized to lowercase, with one trailing dot removed. Public DNS domains and `.local` are rejected at the shared CLI and daemon trust boundary. Remove legacy unsupported suffixes before trusting a replacement CA.

This policy uses RFC 2606 and RFC 6761, with RFC 8375 for `home.arpa` and ICANN resolution 2024.07.29.06 for `internal`. Host-file allowlists keep their existing rules; certificate trust is more restrictive.

## Concurrent tunnel limit

Each user and each organization can hold a limited number of open tunnels at once. When you hit the limit, the tunnel exits instead of retrying, with a message such as:

```
tunnel: max concurrent tunnels per user reached (4). Run `reoclo tunnel ls` to see open tunnels and `reoclo tunnel close <id>` to free one.
```

(The defaults are 4 per user and 32 per organization. The number in the message is your current limit, and the organization form reads "per tenant".) Run `reoclo tunnel ls --active` to see what is open, then `reoclo tunnel close <tunnel-id>` to free a slot.

## Closing stale sessions

`reoclo tunnel close` also cleans up a session that no gateway holds any more, for example after a crash. The command reports that the session "had no live connection" and marks it closed. If the session was seen on a gateway within the last few minutes it is left open and the command asks you to try again shortly.
