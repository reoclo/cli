import { describe, expect, it } from "bun:test";
import { ReauthRequiredError } from "../../../src/client/errors";
import {
  type FailureState,
  isFailureState,
  isStickyState,
  reportFor,
  stateForCloseCode,
  stateForConnectError,
  STATE_INFO,
  TUNNEL_STATES,
} from "../../../src/tunnels/states";

describe("stateForCloseCode", () => {
  const cases: [number | undefined, FailureState][] = [
    [4401, "needs_sign_in"],
    [4410, "server_offline"],
    [4502, "server_offline"],
    [4429, "quota_reached"],
    [4408, "expired"],
    [4407, "closed_by_operator"],
    [4403, "forbidden"],
    [4404, "forbidden"],
    [4409, "forbidden"],
    [4501, "failed"],
    [4503, "failed"],
    [1006, "failed"],
    [undefined, "failed"],
  ];
  for (const [code, state] of cases) {
    it(`maps ${String(code)} to ${state}`, () => {
      expect(stateForCloseCode(code)).toBe(state);
    });
  }
});

describe("stateForConnectError", () => {
  it("maps a refused upgrade by HTTP status", () => {
    expect(stateForConnectError(new Error("Unexpected server response: 401")).state).toBe("needs_sign_in");
    expect(stateForConnectError(new Error("Unexpected server response: 403")).state).toBe("forbidden");
    expect(stateForConnectError(new Error("Unexpected server response: 429")).state).toBe("quota_reached");
    expect(stateForConnectError(new Error("Unexpected server response: 502")).state).toBe("server_offline");
    expect(stateForConnectError(new Error("connect ECONNREFUSED")).state).toBe("failed");
  });

  it("maps sign-in failures from bootstrap", () => {
    expect(stateForConnectError(new ReauthRequiredError("default", "rejected")).state).toBe("needs_sign_in");
    const notAuth = Object.assign(new Error("not authenticated"), { exitCode: 3 });
    expect(stateForConnectError(notAuth).state).toBe("needs_sign_in");
    const notGranted = Object.assign(new Error("org not granted"), { exitCode: 5 });
    expect(stateForConnectError(notGranted).state).toBe("forbidden");
  });
});

describe("state tables", () => {
  it("has a message and action for every state", () => {
    for (const s of TUNNEL_STATES) {
      expect(STATE_INFO[s].message.length).toBeGreaterThan(0);
      expect(STATE_INFO[s].action.length).toBeGreaterThan(0);
    }
  });

  it("marks only expired and closed_by_operator as sticky", () => {
    expect(TUNNEL_STATES.filter(isStickyState)).toEqual(["expired", "closed_by_operator"]);
  });

  it("does not count ready, active or down as failures", () => {
    for (const s of ["down", "ready", "connecting", "active", "reconnecting"] as const) {
      expect(isFailureState(s)).toBe(false);
    }
  });

  it("reportFor carries the detail only when given", () => {
    expect(reportFor("failed", "boom")).toMatchObject({ state: "failed", detail: "boom" });
    expect(reportFor("ready")).not.toHaveProperty("detail");
  });
});
