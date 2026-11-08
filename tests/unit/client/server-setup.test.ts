import { describe, expect, test } from "bun:test";
import {
  parseAdminUser,
  parseFirewallPorts,
  parseInstallUrl,
  parseSshDestination,
  parseTrustedIps,
  portsBlockedByHardening,
  scannedPorts,
  resolveAdminUser,
} from "../../../src/client/server-setup";
import { resolveInstallUrl } from "../../../src/commands/servers-setup";

describe("input validation", () => {
  test("firewall ports accept the forms ufw accepts", () => {
    expect(parseFirewallPorts(["8080,5432/tcp", "9000:9100/udp"])).toEqual([
      "8080",
      "5432/tcp",
      "9000:9100/udp",
    ]);
  });

  test.each(["70000", "9000:9100", "9100:9000/tcp", "80;reboot"])("rejects port %s", (port) => {
    expect(() => parseFirewallPorts([port])).toThrow("--firewall-allow");
  });

  test("trusted IPs accept addresses and ranges", () => {
    expect(parseTrustedIps(["203.0.113.7", "203.0.113.0/24,2001:db8::/32"])).toEqual([
      "203.0.113.7",
      "203.0.113.0/24",
      "2001:db8::/32",
    ]);
  });

  test.each(["300.1.1.1", "1.1.1.1/33", "$(reboot)"])("rejects trusted IP %s", (ip) => {
    expect(() => parseTrustedIps([ip])).toThrow("--trusted-ip");
  });

  test.each(["root", "Admin", "a b", "$(id)"])("rejects admin user %s", (user) => {
    expect(() => parseAdminUser(user)).toThrow("--user");
  });

  test.each(["https://get.example.test;reboot", "ftp://get.example.test", "$(id)"])(
    "rejects install URL %s",
    (url) => {
      expect(() => parseInstallUrl(url)).toThrow("--install-url");
    },
  );

  test("SSH destinations split into user and host", () => {
    expect(parseSshDestination("root@203.0.113.9")).toEqual({ user: "root", host: "203.0.113.9" });
    expect(parseSshDestination("my-alias")).toEqual({ user: undefined, host: "my-alias" });
    expect(parseSshDestination("ubuntu@2001:db8::1")).toEqual({ user: "ubuntu", host: "2001:db8::1" });
  });

  test.each(["-oProxyCommand=x", "root@-oProxyCommand=x", "-l@host", "a b@host", "host;reboot"])(
    "rejects SSH destination %s",
    (dest) => {
      expect(() => parseSshDestination(dest)).toThrow("--ssh");
    },
  );
});

describe("resolveAdminUser", () => {
  test("prefers --user, then a non-root login, then ubuntu", () => {
    expect(resolveAdminUser("deploy", "admin")).toBe("deploy");
    expect(resolveAdminUser(undefined, "admin")).toBe("admin");
    expect(resolveAdminUser(undefined, "root")).toBe("ubuntu");
    expect(resolveAdminUser(undefined, undefined)).toBe("ubuntu");
  });
});

describe("resolveInstallUrl", () => {
  test("follows the API host so staging never fetches production's script", () => {
    expect(resolveInstallUrl(undefined, "https://api.reoclo.dev")).toBe("https://get.reoclo.dev");
    expect(resolveInstallUrl(undefined, "https://api.reoclo.com")).toBe("https://get.reoclo.com");
  });

  test("an explicit URL wins and loses its trailing slash", () => {
    expect(resolveInstallUrl("https://get.example.test/", "https://api.reoclo.com")).toBe(
      "https://get.example.test",
    );
  });
});

describe("portsBlockedByHardening", () => {
  const ports = [
    { port: 22, address: "0.0.0.0", process: "sshd" },
    { port: 2222, address: "0.0.0.0", process: "sshd" },
    { port: 80, address: "0.0.0.0", process: "caddy" },
    { port: 5432, address: "127.0.0.1", process: "postgres" },
    { port: 8080, address: "0.0.0.0", process: "app" },
    { port: 8080, address: "::", process: "app" },
    { port: 9050, address: "*", process: "metrics" },
  ];

  test("reports public ports outside SSH, 80 and 443, once each", () => {
    expect(portsBlockedByHardening(ports, [])).toEqual([8080, 9050]);
  });

  test("container ports published on the host count too", () => {
    const scan = {
      listening_ports: [],
      docker_port_bindings: [
        { host_port: 80, host_address: "0.0.0.0" },
        { host_port: 5432, host_address: "0.0.0.0" },
        { host_port: 6379, host_address: "127.0.0.1" },
      ],
    };
    expect(portsBlockedByHardening(scannedPorts(scan), [])).toEqual([5432]);
  });

  test("ports and ranges the caller opens are not reported", () => {
    expect(portsBlockedByHardening(ports, ["8080/tcp", "9000:9100/tcp"])).toEqual([]);
  });
});
