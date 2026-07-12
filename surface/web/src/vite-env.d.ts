/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_URL?: string;
  readonly VITE_ATRIUM_WS_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
