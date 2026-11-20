import { expect, it } from "bun:test";
import { mergeSuffixList } from "../../../src/tunnels/ca-actions";
import { HostnameError } from "../../../src/tunnels/hosts-block";

it.each(["company.com", "dev.local", "lan", "home", "*.test", "bad..test", "-bad.test", "127.0.0.1", "test.evil.com"])(
  "rejects unsafe CA trust domain %s", (domain) => {
    expect(() => mergeSuffixList([], [domain])).toThrow(HostnameError);
  },
);

it("normalizes reserved domains before merging the trust list", () => {
  expect(mergeSuffixList(["reoclo.test"], [" REOCLO.TEST. ", "internal", "app.home.arpa", "x.example", "x.invalid", "x.localhost"]))
    .toEqual(["app.home.arpa", "internal", "reoclo.test", "x.example", "x.invalid", "x.localhost"]);
});

it("rejects legacy unsafe suffixes when merging a trust request", () => {
  expect(() => mergeSuffixList(["company.com"], ["reoclo.test"])).toThrow(HostnameError);
});
