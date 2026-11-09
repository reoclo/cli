// src/tunnels/auth-flow.ts
//
// Sign-in for the desktop app: the daemon runs the device flow and the app
// shows the code. The browser is not opened here; the app decides.

import { deviceLogin } from "../auth/device-login";
import { apiUrl, authUrl, deriveAuthFromApi } from "../lib/urls";

export interface AuthEvent {
  status: "pending" | "success" | "failed";
  user_code?: string;
  verification_uri?: string;
  /** The URL with the code filled in. */
  verification_uri_complete?: string;
  expires_in?: number;
  email?: string;
  profile?: string;
  message?: string;
}

export interface AuthFlow {
  /** Resolves with the success event once approved; `onCode` receives the pending event first. */
  login(opts: { profile?: string }, onCode: (e: AuthEvent) => void): Promise<AuthEvent>;
}

export function createAuthFlow(login: typeof deviceLogin = deviceLogin): AuthFlow {
  return {
    async login(opts, onCode) {
      const api = apiUrl();
      const requested = opts.profile?.trim();
      const fromEnv = process.env["REOCLO_PROFILE"]?.trim();
      const profile = requested || fromEnv || "default";
      const source = requested ? "flag" : fromEnv ? "env" : "default";
      const result = await login(
        { profile, source, api, auth: deriveAuthFromApi(api) ?? authUrl(), browser: false },
        {
          onCode(init, uri) {
            onCode({
              status: "pending",
              user_code: init.user_code,
              verification_uri: init.verification_uri,
              verification_uri_complete: uri,
              expires_in: init.expires_in,
            });
          },
        },
      );
      return { status: "success", email: result.me.email, profile };
    },
  };
}
