/** Base URL of the backend API, e.g. http://localhost:3101/api/v1. Empty means mock mode. */
export const API_URL: string = import.meta.env.VITE_API_URL ?? ''

/** True when the app talks to the real backend instead of the browser mock. */
export const apiMode = API_URL !== ''
