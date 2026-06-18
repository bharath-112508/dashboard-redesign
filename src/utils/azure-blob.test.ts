import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * Coverage focus for `azure-blob` — the SAS minting + blob-ops layer
 * that gates every file the platform stores. The security-critical
 * properties:
 *
 *   1. **Upload SAS uses `create`-only** (`c`), never `write`. A
 *      regression to `cw` would let a client who keeps a stale SAS
 *      around REPLACE the content of an already-finalised blob —
 *      defeating the post-finalize HEAD check that gates row writes.
 *   2. **Download SAS uses `read`-only** (`r`), and pins
 *      `Content-Disposition: attachment; filename="..."` when a
 *      filename is supplied. The disposition-attachment header is the
 *      defence-in-depth that prevents an uploaded HTML/SVG payload
 *      from rendering inline — even if the MIME allowlist later
 *      admits one of those types.
 *   3. **HTTPS-only protocol** on both flavours. A regression that
 *      flipped to HTTPSAndHTTP would let a stale-SAS mitm capture
 *      Authorization headers on plaintext.
 *   4. **Filename sanitisation** strips control chars + escape-quoting
 *      chars before embedding into the Content-Disposition header
 *      (RFC 6266 quoted-string can be terminated early by a `"` or
 *      `\` — those become `_`).
 *   5. **Blob-key path encoding** preserves `/` separators (we use
 *      them for `tasks/{id}/...` namespacing) but percent-encodes
 *      every segment so unusual chars in a filename don't form a
 *      malformed URL.
 *   6. **`AzureNotConfiguredError`** is thrown when env is missing —
 *      so a developer not exercising attachments isn't blocked at
 *      boot, and so a misconfig fails LOUDLY at the first attachment
 *      call rather than silently skipping the upload.
 *   7. **`headBlob` returns `exists: false` on Azure 404** — so
 *      `finalize` can reject a metadata-only spoof cleanly.
 */

// ─── Module-level mocks ──────────────────────────────────────────────────

const generateBlobSASQueryParametersMock = vi.fn((..._args: unknown[]) => ({
    toString: () => 'sig=stubbed-sas-token',
}));

const blobSASPermissionsParseMock = vi.fn((perms: string) => ({ permissions: perms }));

class FakeStorageSharedKeyCredential {
    constructor(
        public accountName: string,
        public accountKey: string
    ) {}
}

// Default container behaviour — tests can swap it via `setContainerStub`
// to inject failure modes for HEAD / DELETE / PUT.
let containerStub: unknown = {
    createIfNotExists: async () => undefined,
    getBlobClient: () => ({
        getProperties: async () => ({ contentLength: 0, contentType: 'application/octet-stream' }),
        downloadToBuffer: async () => Buffer.alloc(0),
        deleteIfExists: async () => undefined,
    }),
    getBlockBlobClient: () => ({
        uploadData: async () => undefined,
    }),
};

const setContainerStub = (stub: unknown): void => {
    containerStub = stub;
};

const getPropertiesMock = vi.fn(async () => ({ logging: { read: true }, cors: [] as unknown[] }));
const setPropertiesMock = vi.fn(async (_props: unknown) => undefined);

class FakeBlobServiceClient {
    static fromConnectionString = vi.fn(() => new FakeBlobServiceClient());
    // Prototype method (not instance-property) so a runtime override
    // takes effect on the cached service client too.
    getContainerClient(): unknown {
        return containerStub;
    }
    getProperties(): unknown {
        return getPropertiesMock();
    }
    setProperties(props: unknown): unknown {
        return setPropertiesMock(props);
    }
}

vi.mock('@azure/storage-blob', () => ({
    BlobServiceClient: FakeBlobServiceClient,
    StorageSharedKeyCredential: FakeStorageSharedKeyCredential,
    BlobSASPermissions: { parse: blobSASPermissionsParseMock },
    SASProtocol: { Https: 'https', HttpsAndHttp: 'https,http' },
    generateBlobSASQueryParameters: generateBlobSASQueryParametersMock,
}));

vi.mock('../config/server.config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../config/server.config.js')>();
    return {
        ...actual,
        AZURE_STORAGE_CONNECTION_STRING: null,
        AZURE_STORAGE_ACCOUNT_NAME: 'testaccount',
        AZURE_STORAGE_ACCOUNT_KEY: 'AAAA',
    };
});

// Now we can import the module under test.
const azure = await import('./azure-blob.js');

beforeEach(() => {
    vi.clearAllMocks();
    azure.__resetAzureClientForTests();
});

// ─── isAzureConfigured ───────────────────────────────────────────────────

describe('isAzureConfigured', () => {
    it('returns true when account name + key are present (the default in this test setup)', () => {
        expect(azure.isAzureConfigured()).toBe(true);
    });
});

// ─── mintUploadSas ───────────────────────────────────────────────────────

describe('mintUploadSas', () => {
    it('signs with `create`-only permission (never `write`)', () => {
        // The cardinal rule. A regression to 'cw' would let a stale-SAS
        // attacker REPLACE finalised blob content.
        azure.mintUploadSas({ container: 'attachments', blobKey: 'tasks/abc/file.png', ttlMinutes: 5 });
        expect(blobSASPermissionsParseMock).toHaveBeenCalledWith('c');
    });

    it('passes HTTPS-only protocol', () => {
        azure.mintUploadSas({ container: 'attachments', blobKey: 'k', ttlMinutes: 5 });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as { protocol: string };
        expect(args.protocol).toBe('https');
    });

    it('embeds the contentType pin into the SAS so Azure rejects mismatched uploads', () => {
        // The contentType pin is the defence: client sends a SAS-bound
        // image/png, then attempts to PUT with Content-Type: text/html
        // → Azure rejects with 403. A regression dropping this would
        // let the client lie about the MIME on upload.
        azure.mintUploadSas({
            container: 'attachments',
            blobKey: 'k',
            ttlMinutes: 5,
            contentType: 'image/png',
        });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as { contentType?: string };
        expect(args.contentType).toBe('image/png');
    });

    it('builds an HTTPS URL with the SAS query string + percent-encoded blob path', () => {
        const result = azure.mintUploadSas({
            container: 'attachments',
            blobKey: 'tasks/abc/file with spaces.png',
            ttlMinutes: 5,
        });
        expect(result.url.startsWith('https://testaccount.blob.core.windows.net/attachments/')).toBe(true);
        // Path encoding: spaces escaped, but `/` separators preserved.
        expect(result.url).toContain('/tasks/abc/file%20with%20spaces.png');
        // SAS query string is appended.
        expect(result.url).toContain('?sig=stubbed-sas-token');
    });

    it('returns an `expires_at` Date matching the requested TTL (within a small skew tolerance)', () => {
        const before = Date.now();
        const { expires_at } = azure.mintUploadSas({
            container: 'c',
            blobKey: 'k',
            ttlMinutes: 10,
        });
        const after = Date.now();
        // The TTL is 10 min from "now" — pin that the returned expiry
        // sits within the test's wall-clock window plus 10 minutes.
        const expiryMs = expires_at.getTime();
        expect(expiryMs).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 100);
        expect(expiryMs).toBeLessThanOrEqual(after + 10 * 60 * 1000 + 100);
    });

    it('uses a back-skewed startsOn so 30s of NTP drift between server + Azure does not invalidate fresh SAS', () => {
        // Pin the 30s clock-skew tolerance. Without it, an Azure clock
        // 5s ahead of ours would reject newly-minted SAS as "not yet
        // valid". 30s is comfortably above realistic drift.
        const before = Date.now();
        azure.mintUploadSas({ container: 'c', blobKey: 'k', ttlMinutes: 5 });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as { startsOn: Date };
        const startsOnMs = args.startsOn.getTime();
        expect(startsOnMs).toBeLessThanOrEqual(before);
        // No more than ~31s back (allow tiny fuzz for the clock between
        // these two reads).
        expect(before - startsOnMs).toBeLessThan(35_000);
    });
});

// ─── mintDownloadSas ─────────────────────────────────────────────────────

describe('mintDownloadSas', () => {
    it('signs with `read`-only permission', () => {
        azure.mintDownloadSas({ container: 'c', blobKey: 'k', ttlMinutes: 5 });
        expect(blobSASPermissionsParseMock).toHaveBeenCalledWith('r');
    });

    it('omits Content-Disposition when no fileName is supplied', () => {
        azure.mintDownloadSas({ container: 'c', blobKey: 'k', ttlMinutes: 5 });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as {
            contentDisposition?: string;
        };
        expect(args.contentDisposition).toBeUndefined();
    });

    it('pins `attachment; filename="..."` when a fileName is supplied (XSS defence)', () => {
        // The cardinal rule for downloads: forcing `attachment` makes
        // browsers save instead of render. An uploaded HTML/SVG file
        // CANNOT execute in the application origin even if the upload
        // path one day admits the MIME type.
        azure.mintDownloadSas({
            container: 'c',
            blobKey: 'k',
            ttlMinutes: 5,
            fileName: 'safe-name.png',
        });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as { contentDisposition: string };
        expect(args.contentDisposition).toBe('attachment; filename="safe-name.png"');
    });

    it('escapes quote + backslash in filenames so RFC 6266 quoted-string is not terminated early', () => {
        // A filename containing `"` or `\` would otherwise close the
        // header value early and let the rest leak as new headers.
        // The implementation replaces both with `_`.
        azure.mintDownloadSas({
            container: 'c',
            blobKey: 'k',
            ttlMinutes: 5,
            fileName: 'evil"; X-Hostile: yes\\.png',
        });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as { contentDisposition: string };
        expect(args.contentDisposition).not.toContain('"; X-Hostile');
        expect(args.contentDisposition).not.toContain('\\');
        expect(args.contentDisposition).toContain('_');
    });

    it('strips ASCII control bytes (\\r, \\n) from filenames — header-injection defence', () => {
        // A `\r\n` injection in a filename would split the response
        // header into a fake second header. The strip removes the
        // line-break bytes so the remaining text stays inside the
        // quoted-string and cannot escape into a new header.
        azure.mintDownloadSas({
            container: 'c',
            blobKey: 'k',
            ttlMinutes: 5,
            fileName: 'evil\r\nX-Injected: yes.png',
        });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as { contentDisposition: string };
        // The CR/LF are stripped — that's the actual injection vector.
        expect(args.contentDisposition).not.toContain('\r');
        expect(args.contentDisposition).not.toContain('\n');
        // The remaining text "X-Injected: yes" is harmless because it
        // stays inside the `filename="..."` quoted-string and never
        // reaches the header parser as a new header line.
        expect(args.contentDisposition.startsWith('attachment; filename="')).toBe(true);
        expect(args.contentDisposition.endsWith('"')).toBe(true);
    });

    it('falls back to "download" when the cleaned filename is empty', () => {
        // E.g. if the entire filename was control bytes that got stripped.
        azure.mintDownloadSas({
            container: 'c',
            blobKey: 'k',
            ttlMinutes: 5,
            fileName: '\x00\x01\x02',
        });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as { contentDisposition: string };
        expect(args.contentDisposition).toBe('attachment; filename="download"');
    });

    it('caps the filename at 255 chars so an oversized name does not blow the header limit', () => {
        const oversize = 'x'.repeat(500) + '.png';
        azure.mintDownloadSas({ container: 'c', blobKey: 'k', ttlMinutes: 5, fileName: oversize });
        const args = generateBlobSASQueryParametersMock.mock.calls[0]![0] as { contentDisposition: string };
        // Prefix `attachment; filename="` (21 chars) + 255 + `"` = 277.
        expect(args.contentDisposition.length).toBeLessThanOrEqual(280);
    });
});

// ─── headBlob 404 mapping ────────────────────────────────────────────────

describe('headBlob', () => {
    /**
     * Pin the 404 → `{exists: false}` mapping by injecting a per-test
     * `getProperties` stub. This is the branch `finalize` relies on to
     * reject metadata-only spoofs cleanly.
     */
    const setHeadStub = (props: () => Promise<unknown>) => {
        setContainerStub({
            getBlobClient: () => ({ getProperties: props }),
        });
    };

    it('returns `exists: false` when Azure surfaces 404', async () => {
        setHeadStub(async () => {
            throw Object.assign(new Error('not found'), { statusCode: 404 });
        });

        const result = await azure.headBlob('container', 'key');
        expect(result).toEqual({ exists: false });
    });

    it('propagates non-404 errors so the caller can decide retry/502', async () => {
        setHeadStub(async () => {
            throw Object.assign(new Error('5xx'), { statusCode: 503 });
        });

        await expect(azure.headBlob('c', 'k')).rejects.toMatchObject({ statusCode: 503 });
    });

    it('returns `{exists, size, contentType}` from a successful HEAD', async () => {
        setHeadStub(async () => ({ contentLength: 12_345, contentType: 'image/png' }));

        const result = await azure.headBlob('c', 'k');
        expect(result).toEqual({ exists: true, size: 12_345, contentType: 'image/png' });
    });
});

// ─── Exported error classes ──────────────────────────────────────────────

describe('exported error classes', () => {
    it('AzureNotConfiguredError has its name set (so log lines tag it correctly)', () => {
        const err = new azure.AzureNotConfiguredError('test');
        expect(err.name).toBe('AzureNotConfiguredError');
        expect(err).toBeInstanceOf(Error);
    });

    it('BlobNotFoundError has its name set', () => {
        const err = new azure.BlobNotFoundError('test');
        expect(err.name).toBe('BlobNotFoundError');
        expect(err).toBeInstanceOf(Error);
    });
});

// ─── ensureBlobCorsRules ─────────────────────────────────────────────────

describe('ensureBlobCorsRules', () => {
    it('sets a single CORS rule joining the explicit origins, preserving other props', async () => {
        await azure.ensureBlobCorsRules([
            'https://app.example.com',
            'https://app.example.com', // dup → de-duped
            ' https://staging.example.com ', // trimmed
        ]);
        expect(setPropertiesMock).toHaveBeenCalledTimes(1);
        const props = setPropertiesMock.mock.calls[0]![0] as {
            logging: unknown;
            cors: { allowedOrigins: string; allowedMethods: string }[];
        };
        // getProperties result is preserved (logging untouched).
        expect(props.logging).toEqual({ read: true });
        expect(props.cors).toHaveLength(1);
        expect(props.cors[0].allowedOrigins).toBe('https://app.example.com,https://staging.example.com');
        expect(props.cors[0].allowedMethods).toBe('GET,HEAD,PUT,OPTIONS');
    });

    it('is a no-op when only a wildcard / empty origins are given (never sets * CORS)', async () => {
        await azure.ensureBlobCorsRules(['*', '', '  ']);
        expect(setPropertiesMock).not.toHaveBeenCalled();
    });
});
