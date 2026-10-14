import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * A Content-Security-Policy for the built app (the dev server injects inline scripts, so not there):
 * scripts only from the app, data only from the app, the API and Azure Blob uploads.
 * frame-ancestors cannot be set in a meta tag; the host should send it as a header.
 */
const csp = (apiUrl: string | undefined): Plugin => {
  // A relative API address (behind the same host) is already 'self'.
  const api = URL.canParse(apiUrl ?? '') ? new URL(apiUrl!).origin : ''
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${api} https://*.blob.core.windows.net data: blob:`.replace(/\s+/g, ' '),
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')
  return {
    name: 'csp',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: policy }, injectTo: 'head-prepend' }],
  }
}

export default defineConfig(({ mode }) => ({
  // Env files are read next to this config, wherever the build is run from.
  plugins: [react(), tailwindcss(), csp(loadEnv(mode, decodeURIComponent(new URL('.', import.meta.url).pathname), 'VITE_').VITE_API_URL)],
}))
