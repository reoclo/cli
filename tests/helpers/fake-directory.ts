// tests/helpers/fake-directory.ts
//
// A Directory for the daemon tests: one organization, one server, one scanned
// port. It records every call and can be told to fail.

import type { Directory, OrgView, PortView, ResolvedServer, ServerView } from "../../src/tunnels/directory";

export class FakeDirectory implements Directory {
  calls: string[] = [];
  signed = true;
  failWith?: Error;
  serverId = "s1";

  private check(): void {
    if (this.failWith) throw this.failWith;
  }

  signedIn(): Promise<boolean> {
    return Promise.resolve(this.signed);
  }

  orgs(): Promise<OrgView[]> {
    this.calls.push("orgs");
    this.check();
    return Promise.resolve([{ id: "t1", slug: "acme", name: "Acme" }]);
  }

  servers(org: string): Promise<ServerView[]> {
    this.calls.push(`servers ${org}`);
    this.check();
    return Promise.resolve([{ id: this.serverId, name: "Production", slug: "prod-1", connection_type: "runner", status: "online" }]);
  }

  ports(org: string, server: string): Promise<PortView[]> {
    this.calls.push(`ports ${org} ${server}`);
    this.check();
    return Promise.resolve([{ port: 5432, protocol: "tcp", bind_address: "127.0.0.1", process: "postgres" }]);
  }

  resolve(input: { org: string; server: string; profile?: string }): Promise<ResolvedServer> {
    this.calls.push(`resolve ${input.org} ${input.server}`);
    this.check();
    return Promise.resolve({
      org: input.org,
      tenant_id: "t1",
      profile: input.profile ?? "default",
      server: input.server,
      server_id: this.serverId,
    });
  }
}
