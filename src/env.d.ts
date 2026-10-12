/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly ADMIN_USER: string;
  readonly ADMIN_PASSWORD: string;
  /** 32-byte hex: signs sessions and salts visitor hashes. */
  readonly ADMIN_SECRET: string;
  readonly KV_REST_API_URL: string;
  readonly KV_REST_API_TOKEN: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace App {
  interface Locals {
    /** True when the request carries a valid back-office session. Set by src/middleware.ts for every request. */
    admin: boolean;
  }
}

interface Window {
  /** First-party analytics beacon (src/scripts/track.ts). Absent when the visitor opted out. */
  track?: (name: string, data?: Record<string, string | number>) => void;
}
