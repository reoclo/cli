import { z } from "zod";
import { HostnameError } from "./hosts-block";

// RFC 2606 / 6761, RFC 8375, and ICANN resolution 2024.07.29.06.
// .local belongs to mDNS; arbitrary public domains are deliberately excluded.
export const CA_RESERVED_SUFFIXES = ["test", "localhost", "internal", "home.arpa", "example", "invalid"] as const;
const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const domain = z.string().trim().transform((s) => s.toLowerCase().replace(/\.$/, ""))
  .pipe(z.string().max(253).regex(new RegExp(`^${label}(?:\\.${label})*$`))
    .refine((s) => CA_RESERVED_SUFFIXES.some((suffix) => s === suffix || s.endsWith(`.${suffix}`))))
  .brand<"CaDomain">();

export function parseCaDomain(value: string): z.infer<typeof domain> {
  const result = domain.safeParse(value);
  if (!result.success) {
    throw new HostnameError(
      `cannot trust ${JSON.stringify(value)}: use a valid DNS name under .test, .localhost, .internal, .home.arpa, .example or .invalid; public domains and .local are not permitted`,
    );
  }
  return result.data;
}
