/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend API base URL. Set it to run the app against the real backend (API mode). */
  readonly VITE_API_URL?: string
}
