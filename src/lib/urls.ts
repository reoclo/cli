// URL helpers — derive every Reoclo property URL from REOCLO_ROOT_DOMAIN.
//
// Production defaults to "reoclo.com". Staging sets
// REOCLO_ROOT_DOMAIN=reoclo.dev; local HTTPS dev sets it to reoclo.test.
//
// Each helper honors a per-service REOCLO_* override env var so deployments
// that set explicit overrides keep working unchanged:
//
//   appUrl     ← REOCLO_APP_URL      | fallback `app.{root}`
//   authUrl    ← REOCLO_AUTH_URL     | fallback `auth.{root}`
//   docsUrl    ← REOCLO_DOCS_URL     | fallback `docs.{root}`
//   apiUrl     ← REOCLO_API_URL      | fallback `api.{root}`
//   gatewayUrl ← REOCLO_GATEWAY_URL  | fallback `gateway.{root}`
//   cdnUrl     ← REOCLO_CDN_URL      | fallback `cdn.{root}`
//   getUrl     ← REOCLO_GET_URL      | fallback `get.{root}`
//   streamsUrl ← REOCLO_STREAMS_URL  | fallback `streams.{root}`
//   directUrl  ← REOCLO_DIRECT_URL   | fallback `direct.{root}`
//   uptimeHost ← REOCLO_UPTIME_HOST  | fallback `uptime.{root}`
//
// Override env values may be full URLs ("https://api.example.com") or bare
// hostnames ("api.example.com"). Trailing slashes are stripped.

const ROOT_DOMAIN = process.env["REOCLO_ROOT_DOMAIN"] || "reoclo.com";
const SCHEME = process.env["REOCLO_URL_SCHEME"] || "https";

function stripScheme(value: string): string {
  return value.replace(/^(https?|wss?):\/\//, "").replace(/\/$/, "");
}

function resolveUrl(overrideKeys: string[], subdomain: string | null, path = ""): string {
  for (const key of overrideKeys) {
    const raw = process.env[key];
    if (!raw) continue;
    if (/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, "") + path;
    return `${SCHEME}://${stripScheme(raw)}${path}`;
  }
  const host = subdomain ? `${subdomain}.${ROOT_DOMAIN}` : ROOT_DOMAIN;
  return `${SCHEME}://${host}${path}`;
}

function resolveHost(overrideKeys: string[], subdomain: string | null): string {
  for (const key of overrideKeys) {
    const raw = process.env[key];
    if (raw) return stripScheme(raw);
  }
  return subdomain ? `${subdomain}.${ROOT_DOMAIN}` : ROOT_DOMAIN;
}

export const rootDomain = (): string => ROOT_DOMAIN;
export const siteUrl = (path = ""): string => resolveUrl(["REOCLO_SITE_URL"], null, path);
export const appUrl = (path = ""): string => resolveUrl(["REOCLO_APP_URL"], "app", path);
export const appHost = (): string => resolveHost(["REOCLO_APP_URL"], "app");
export const authUrl = (path = ""): string => resolveUrl(["REOCLO_AUTH_URL"], "auth", path);
export const docsUrl = (path = ""): string => resolveUrl(["REOCLO_DOCS_URL"], "docs", path);
export const apiUrl = (path = ""): string => resolveUrl(["REOCLO_API_URL"], "api", path);
export const gatewayUrl = (path = ""): string =>
  resolveUrl(["REOCLO_GATEWAY_URL"], "gateway", path);
export const cdnUrl = (path = ""): string => resolveUrl(["REOCLO_CDN_URL"], "cdn", path);
export const getUrl = (path = ""): string => resolveUrl(["REOCLO_GET_URL"], "get", path);
export const streamsUrl = (path = ""): string =>
  resolveUrl(["REOCLO_STREAMS_URL"], "streams", path);

/** Direct gateway URL converted to WebSocket scheme (wss/ws). */
export const directWsUrl = (path = ""): string => {
  const url = resolveUrl(["REOCLO_DIRECT_URL"], "direct", path);
  return url.replace(/^https:/, "wss:").replace(/^http:/, "ws:");
};

export const uptimeHost = (): string => resolveHost(["REOCLO_UPTIME_HOST"], "uptime");
export const supportEmail = (): string => `support@${ROOT_DOMAIN}`;
