import {
    BlobSASPermissions,
    BlobServiceClient,
    SASProtocol,
    StorageSharedKeyCredential,
    generateBlobSASQueryParameters,
} from '@azure/storage-blob';

import {
    AZURE_STORAGE_ACCOUNT_KEY,
    AZURE_STORAGE_ACCOUNT_NAME,
    AZURE_STORAGE_CONNECTION_STRING,
} from '../config/server.config.js';
import logger from './logger.js';

/**
 * Azure Blob client + SAS minting (Step 21 — task attachments;
 * Step 22 — profile photos).
 *
 * The API stores files in **private** containers. The FE never gets a
 * permanent URL — every read/write is gated by a short-lived SAS the
 * server signs with the account key. Stored on the row are
 * `blob_container` + `blob_key` (the source of truth) plus uploader
 * metadata; no SAS is ever persisted (they're regenerated on demand).
 *
 * Auth modes (`server.config.ts`):
 *   1. `AZURE_STORAGE_CONNECTION_STRING` — preferred, one secret.
 *   2. `AZURE_STORAGE_ACCOUNT_NAME` + `AZURE_STORAGE_ACCOUNT_KEY` — fallback.
 *
 * Both modes require the account key because SAS signing happens
 * server-side. Managed-identity / token-only credentials cannot generate
 * user-delegation SAS without round-tripping to Azure AD per request — we
 * keep the surface small in v1 and document the connection-string flow.
 *
 * All clients are lazy: the first call that needs Azure throws a clear
 * `azureNotConfigured` error if the env was never set, instead of failing
 * at boot. That keeps unrelated tests / local dev runs unblocked when no
 * one is exercising the attachment endpoints.
 */

// ─── Lazy singletons ─────────────────────────────────────────────────────

interface AzureContext {
    serviceClient: BlobServiceClient;
    /**
     * Shared-key credential used to sign SAS tokens. Must be a real
     * account key — neither connection-string SAS nor token credentials
     * can sign child SAS, and we want to fail loudly if someone wires
     * those by accident.
     */
    sharedKey: StorageSharedKeyCredential;
    accountName: string;
}

let cachedContext: AzureContext | null = null;

/**
 * Parse `AccountName=...;AccountKey=...` out of a connection string. The
 * SDK has its own parser internally but doesn't expose it; we only need
 * the two pieces and a strict failure when either is missing.
 */
const parseConnectionString = (cs: string): { accountName: string; accountKey: string } | null => {
    const parts: Record<string, string> = {};
    for (const segment of cs.split(';')) {
        const trimmed = segment.trim();
        if (!trimmed) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        parts[trimmed.slice(0, eq)] = trimmed.slice(eq + 1);
    }
    const accountName = parts.AccountName;
    const accountKey = parts.AccountKey;
    if (!accountName || !accountKey) return null;
    return { accountName, accountKey };
};

class AzureNotConfiguredError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'AzureNotConfiguredError';
    }
}

const azureNotConfigured = (): never => {
    throw new AzureNotConfiguredError(
        'Azure Blob storage is not configured — set AZURE_STORAGE_CONNECTION_STRING ' +
            'or AZURE_STORAGE_ACCOUNT_NAME + AZURE_STORAGE_ACCOUNT_KEY before using attachments.'
    );
};

const buildContext = (): AzureContext => {
    if (AZURE_STORAGE_CONNECTION_STRING) {
        const parsed = parseConnectionString(AZURE_STORAGE_CONNECTION_STRING);
        if (!parsed) {
            throw new AzureNotConfiguredError(
                'AZURE_STORAGE_CONNECTION_STRING is set but missing AccountName / AccountKey segments.'
            );
        }
        const sharedKey = new StorageSharedKeyCredential(parsed.accountName, parsed.accountKey);
        return {
            serviceClient: BlobServiceClient.fromConnectionString(AZURE_STORAGE_CONNECTION_STRING),
            sharedKey,
            accountName: parsed.accountName,
        };
    }

    if (AZURE_STORAGE_ACCOUNT_NAME && AZURE_STORAGE_ACCOUNT_KEY) {
        const sharedKey = new StorageSharedKeyCredential(AZURE_STORAGE_ACCOUNT_NAME, AZURE_STORAGE_ACCOUNT_KEY);
        const url = `https://${AZURE_STORAGE_ACCOUNT_NAME}.blob.core.windows.net`;
        return {
            serviceClient: new BlobServiceClient(url, sharedKey),
            sharedKey,
            accountName: AZURE_STORAGE_ACCOUNT_NAME,
        };
    }

    return azureNotConfigured();
};

const getContext = (): AzureContext => {
    if (!cachedContext) cachedContext = buildContext();
    return cachedContext;
};

/** Test seam: drop the cached client. Production code never calls this. */
export const __resetAzureClientForTests = (): void => {
    cachedContext = null;
};

export const isAzureConfigured = (): boolean =>
    Boolean(AZURE_STORAGE_CONNECTION_STRING || (AZURE_STORAGE_ACCOUNT_NAME && AZURE_STORAGE_ACCOUNT_KEY));

// ─── SAS minting ─────────────────────────────────────────────────────────

export interface MintSasOptions {
    container: string;
    blobKey: string;
    /** TTL in minutes; clamped at the call site against settings. */
    ttlMinutes: number;
    /**
     * Pin the upload Content-Type so the FE can't post a `.png` and serve
     * it back as `text/html` later. Read SAS does not use this; the
     * stored blob's content-type wins on download.
     */
    contentType?: string;
}

export interface MintDownloadSasOptions extends MintSasOptions {
    /**
     * Original filename, surfaced as `Content-Disposition: attachment;
     * filename="..."` on the download response. Forces the browser to
     * save rather than render — defence against an uploaded HTML/SVG
     * payload executing in the same origin even if the MIME allowlist
     * later admits one of those types.
     */
    fileName?: string;
}

export interface MintedSas {
    url: string;
    expires_at: Date;
}

/**
 * Tolerance for clock skew between this server and Azure's signing
 * verifier. Kept tight — a wide window stretches every minted SAS by
 * 2× this value, which would defeat the point of a short TTL when an
 * admin lowers `system_settings.uploads.sas_token_ttl_minutes`. 30s is
 * comfortably above NTP-synced VM drift and lets us advertise honest
 * effective lifetimes.
 */
const SAS_START_SKEW_MS = 30 * 1000;

const buildExpiry = (ttlMinutes: number): { startsOn: Date; expiresOn: Date } => {
    const now = Date.now();
    return {
        startsOn: new Date(now - SAS_START_SKEW_MS),
        expiresOn: new Date(now + ttlMinutes * 60 * 1000),
    };
};

/**
 * Encode a filename for the `Content-Disposition` SAS field. Azure
 * appends this verbatim into a header, so we strip control bytes,
 * back-slashes, and quotes before quoting the value. The header must be
 * RFC 6266-safe; we keep it ASCII to avoid the encoded-word dance for
 * unicode names (the *display* filename in our DB stays unicode — this
 * is only what the browser uses on Save As).
 */
const encodeContentDispositionFilename = (name: string): string => {
    // Strip C0 controls + DEL; replace quotes/backslashes that would
    // terminate the quoted-string early; cap at 255 chars.
    const cleaned = name
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f]/g, '')
        .replace(/["\\]/g, '_')
        .slice(0, 255);
    const safe = cleaned.length > 0 ? cleaned : 'download';
    return `attachment; filename="${safe}"`;
};

/**
 * Mint a SAS that grants the FE permission to PUT a single blob.
 *
 *  - Permissions: `create` only — no `write`, no read, no list, no
 *    delete. `c` is enough for a single-PUT block-blob upload; we
 *    deliberately exclude `w` so a client who keeps the SAS around
 *    can't *replace* the content of a blob they uploaded earlier
 *    (which would let them slip past the post-finalize HEAD check).
 *    Trade-off: chunked / resumable uploads will fail. For the 25 MiB
 *    cap in `system_settings.uploads.max_file_size_mb` a single PUT is
 *    fine in every supported browser.
 *  - HTTPS-only (`SASProtocol.Https`).
 *  - `contentType` pin (when supplied) becomes the SAS's `rsct` (response
 *    content-type override on the request) — the FE must send a matching
 *    Content-Type header or Azure rejects with 403.
 */
export const mintUploadSas = ({ container, blobKey, ttlMinutes, contentType }: MintSasOptions): MintedSas => {
    const { sharedKey, accountName } = getContext();
    const { startsOn, expiresOn } = buildExpiry(ttlMinutes);

    const sas = generateBlobSASQueryParameters(
        {
            containerName: container,
            blobName: blobKey,
            permissions: BlobSASPermissions.parse('c'),
            startsOn,
            expiresOn,
            protocol: SASProtocol.Https,
            contentType,
        },
        sharedKey
    ).toString();

    const url = `https://${accountName}.blob.core.windows.net/${container}/${encodeBlobPath(blobKey)}?${sas}`;
    return { url, expires_at: expiresOn };
};

/**
 * Mint a short-lived **read** SAS for downloads.
 *
 * Sets `Content-Disposition: attachment; filename=<original>` so the
 * browser saves rather than renders. Combined with the upload-time
 * `Content-Type` pin this means an uploaded HTML / SVG / etc. payload
 * cannot execute in the application origin — even if a future config
 * change widens the MIME allowlist to admit one of those types.
 */
export const mintDownloadSas = ({ container, blobKey, ttlMinutes, fileName }: MintDownloadSasOptions): MintedSas => {
    const { sharedKey, accountName } = getContext();
    const { startsOn, expiresOn } = buildExpiry(ttlMinutes);

    const sas = generateBlobSASQueryParameters(
        {
            containerName: container,
            blobName: blobKey,
            permissions: BlobSASPermissions.parse('r'),
            startsOn,
            expiresOn,
            protocol: SASProtocol.Https,
            contentDisposition: fileName ? encodeContentDispositionFilename(fileName) : undefined,
        },
        sharedKey
    ).toString();

    const url = `https://${accountName}.blob.core.windows.net/${container}/${encodeBlobPath(blobKey)}?${sas}`;
    return { url, expires_at: expiresOn };
};

// ─── Server-side blob ops (HEAD + DELETE) ────────────────────────────────

export interface BlobHead {
    exists: boolean;
    /** Bytes — only present when `exists === true`. */
    size?: number;
    /** Stored content-type — only present when `exists === true`. */
    contentType?: string;
}

/**
 * Verify that a blob the client claims to have uploaded actually exists.
 * Used by `finalize` so the server can reject a metadata-only spoof
 * before persisting a row pointing at nothing.
 *
 * Azure surfaces "not found" as `404` on the head request; we map that
 * to `exists: false`. Any other error propagates so the caller can decide
 * whether to retry / 502.
 */
export const headBlob = async (container: string, blobKey: string): Promise<BlobHead> => {
    const { serviceClient } = getContext();
    const blob = serviceClient.getContainerClient(container).getBlobClient(blobKey);
    try {
        const props = await blob.getProperties();
        return {
            exists: true,
            size: typeof props.contentLength === 'number' ? props.contentLength : undefined,
            contentType: props.contentType,
        };
    } catch (err: unknown) {
        const status = (err as { statusCode?: number })?.statusCode;
        if (status === 404) return { exists: false };
        throw err;
    }
};

/**
 * Best-effort delete. Soft-deleted attachment rows hold the blob_key for
 * audit purposes, but the blob itself can be removed eagerly to free the
 * storage account. Errors are logged at warn — the row's `deleted_at` has
 * already been set by the time we get here, so the user's primary signal
 * (delete success) must not flip to failure if Azure is briefly down.
 */
export const deleteBlob = async (container: string, blobKey: string): Promise<void> => {
    try {
        const { serviceClient } = getContext();
        const blob = serviceClient.getContainerClient(container).getBlobClient(blobKey);
        // `deleteIfExists` swallows 404 by design — re-running a delete
        // for a row whose blob was already wiped (e.g. retries) is a no-op.
        await blob.deleteIfExists();
    } catch (err) {
        logger.warn(
            { err, code: 'BLOB_DELETE_FAILED', container, blob_key: blobKey },
            'Azure blob delete failed; row already soft-deleted'
        );
    }
};

/**
 * Upload bytes to a blob from server-side code (Step 30 — async export
 * worker). The FE-driven flow uses a SAS instead (single PUT from the
 * browser); this helper is for cases where the server itself produces the
 * payload and there's no client to hand a SAS to.
 *
 * Container is auto-created on first use (`createIfNotExists`) so the
 * dev-loop doesn't require a manual setup step. The container is private —
 * downloads still go through `mintDownloadSas`.
 *
 * `contentType` is pinned at upload time to match the SAS download
 * contract (browser uses the stored content-type header to decide
 * disposition). Caller passes the canonical MIME for the payload format.
 */
export const putBlob = async (input: {
    container: string;
    blobKey: string;
    body: Buffer;
    contentType: string;
}): Promise<{ size: number }> => {
    const { serviceClient } = getContext();
    const containerClient = serviceClient.getContainerClient(input.container);
    // Idempotent — a 409 ContainerAlreadyExists is silently absorbed.
    await containerClient.createIfNotExists();
    const blockBlob = containerClient.getBlockBlobClient(input.blobKey);
    await blockBlob.uploadData(input.body, {
        blobHTTPHeaders: { blobContentType: input.contentType },
    });
    return { size: input.body.length };
};

// ─── Path encoding ───────────────────────────────────────────────────────
//
// Blob keys may contain `/` (we use them for namespacing — `tasks/{id}/...`).
// The HTTP URL must percent-encode every segment but PRESERVE the `/`,
// otherwise the server returns 400. `encodeURI` would also leave `?` and
// `#` intact, which we don't want; `encodeURIComponent` mangles `/`. So
// we split + encode each segment.

const encodeBlobPath = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

export { AzureNotConfiguredError };
