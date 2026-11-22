# DNS records on managed zones

On Cloudflare zones your organization has connected, you can add, list and remove TXT, CNAME and MX records without opening the Cloudflare dashboard. Reoclo finds the zone from the record name; records Reoclo publishes for your apps cannot be changed here.

```bash
# DMARC policy for example.com
reoclo dns records add _dmarc.example.com --type TXT --content "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"

reoclo dns records ls example.com --type TXT
reoclo dns records rm <record-id> --zone example.com
```

`rm` asks before deleting; `--yes` skips the prompt.
