// src/client/api-client.ts
import type { HttpClient } from "./http";

/** The slice of {@link HttpClient} the repository-deploy flows use. A structural
 *  type so tests can drive the flows with an in-memory fake. */
export type ApiClient = Pick<HttpClient, "get" | "post" | "put">;
