# Run tests on test servers

Test servers run the tests declared in your repository (`ci/reoclo/tests/<name>.yml`) on machines Reoclo creates in your own AWS or Hetzner account. They are enabled per organization.

```bash
# A pool: where and how machines are created (--secret values are write-only)
reoclo test-pools create --name CI --credential hetzner-main --location fsn1 --server-type cx33 \
  --max-machines 4 --budget 25 --var NODE_ENV=test --secret API_TOKEN=...
reoclo test-pools ls
reoclo test-pools machines ci

# Turn tests on for a repository (organization admins; it asks first, --yes skips the question)
reoclo tests enable --repo acme/web

# Write a starter file in this repository, check it against the API, then run it
reoclo tests init unit --pool ci
reoclo tests validate
reoclo tests ls --repo acme/web --refresh
reoclo tests run unit --repo acme/web --ref main --wait

# Past runs: a run is its id or its number
reoclo tests runs --test unit --state failed
reoclo tests show 12
reoclo tests logs 12 --job build --follow
reoclo tests cancel 12
reoclo tests rerun 12
```

`--repo` takes `owner/name` or an id, and defaults to the git `origin` remote of the current checkout.

`tests run --wait` follows the run, prints each job and step as it changes with the job logs, and exits `0` when the run passes, `1` when it fails and `2` when it errors or is cancelled, so a pipeline can gate on it. Ctrl+C asks whether to cancel the run; answering no stops waiting and leaves it running (exit `130`). In CI use a machine token, because automation keys cannot call these routes.

```yaml
# GitHub Actions
- run: reoclo tests run unit --repo acme/web --ref "$GITHUB_REF_NAME" --wait
  env:
    REOCLO_MACHINE_TOKEN: ${{ secrets.REOCLO_MACHINE_TOKEN }}
```
