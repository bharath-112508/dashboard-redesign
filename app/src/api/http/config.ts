/** Base URL of the backend API, e.g. http://localhost:3101/api/v1. Empty means mock mode. */
export const API_URL: string = import.meta.env.VITE_API_URL ?? ''

/** True when the app talks to the real backend instead of the browser mock. */
export const apiMode = API_URL !== ''

/** Whether the login page lists the Demo DB accounts: API builds made with VITE_DEMO_ACCOUNTS=true only (never production). */
export const demoAccountsOn = (api: boolean, flag: string | undefined) => api && flag === 'true'
export const demoAccounts = demoAccountsOn(apiMode, import.meta.env.VITE_DEMO_ACCOUNTS)
