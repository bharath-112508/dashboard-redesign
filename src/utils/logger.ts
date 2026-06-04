import { createRequire } from 'node:module';
import pino, { type LoggerOptions } from 'pino';
import { APPLICATIONINSIGHTS_CONNECTION_STRING, LOG_LEVEL, NODE_ENV } from '../config/server.config.js';

const localRequire = createRequire(import.meta.url);

const isProduction = NODE_ENV === 'production';

const baseOptions: LoggerOptions = {
    level: LOG_LEVEL,
    base: { service: 'viljetech-platform-backend', env: NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
        paths: [
            'req.headers.authorization',
            'req.headers.cookie',
            'req.body.password',
            'req.body.current_password',
            'req.body.new_password',
            'req.body.refresh_token',
            'password',
            'token',
            'refresh_token',
            'authorization',
        ],
        remove: true,
    },
    formatters: {
        level: (label) => ({ level: label }),
    },
};

// ─── Application Insights wiring (V2-OPS-3) ─────────────────────────────
//
// When `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, ship every pino
// log line to Azure Application Insights via the official SDK's
// `trackTrace` / `trackException` channels — log telemetry stays in
// the same place as request / dependency telemetry, dashboards line
// up, and the standard App Insights UI works ("Logs → traces").
//
// When the env var is null (dev, test, any non-Azure deploy), this
// whole block is a no-op: the SDK is never initialised, no telemetry
// client is constructed, and the logger behaves exactly as before
// (pino-pretty in dev, stdout JSON in prod).
//
// The SDK setup is intentionally narrow: console / request / dep
// auto-collection are NOT enabled here. The richer auto-instrumentation
// path (the official `applicationinsights.setup(...).start()` defaults
// or `useAzureMonitor`) was considered but rejected for now — it adds
// a ~1 MB cold-start hit + duplicate request-logging surface area.
// Re-enable later if "Application Map" / dependency waterfalls become
// worth the cost. See V2-OPS-3 in PENDING_WORK.md.

interface AppInsightsBridge {
    write: (chunk: string) => void;
}

const buildAppInsightsBridge = (connectionString: string): AppInsightsBridge | null => {
    try {
        // Dynamic require via `createRequire` so the SDK never loads
        // when the env var is null (saves ~1 MB + ~100 ms cold start
        // on dev, test, and any deploy that doesn't ship telemetry).
        // The sync require keeps the logger module's top-level
        // synchronous so every consumer sees a ready instance —
        // dynamic `import()` would force the entire module to be
        // async, rippling through every importer.
        const appInsights = localRequire('applicationinsights') as typeof import('applicationinsights');

        appInsights
            .setup(connectionString)
            // We ship pino lines explicitly below — let App Insights
            // not double-capture console output.
            .setAutoCollectConsole(false)
            // Skip the SDK's built-in HTTP + dep auto-collection for
            // now (see block comment above). We can re-enable later.
            .setAutoCollectRequests(false)
            .setAutoCollectDependencies(false)
            .setAutoCollectExceptions(false)
            // v3 signature is `(value, collectExtendedMetrics)`; both
            // off so the SDK doesn't sample perf counters either.
            .setAutoCollectPerformance(false, false)
            // Buffer + retry on intermittent network issues so a brief
            // ingestion outage doesn't drop log lines on the floor.
            .setUseDiskRetryCaching(true)
            .start();

        const client = appInsights.defaultClient;
        const KnownSeverityLevel = appInsights.KnownSeverityLevel;

        const severityFor = (level: unknown): string => {
            // pino numeric levels: trace=10, debug=20, info=30, warn=40, error=50, fatal=60
            // App Insights v3 severity is a string ("Verbose" / "Information" / "Warning" / "Error" / "Critical").
            const lvl = typeof level === 'number' ? level : Number(level);
            if (lvl <= 20) return KnownSeverityLevel.Verbose;
            if (lvl === 40) return KnownSeverityLevel.Warning;
            if (lvl === 50) return KnownSeverityLevel.Error;
            if (lvl >= 60) return KnownSeverityLevel.Critical;
            return KnownSeverityLevel.Information;
        };

        return {
            write: (chunk: string) => {
                // pino emits one JSON object per line. Parse + forward.
                // If parse fails (very unlikely — pino is well-formed
                // by construction), swallow so we never break the
                // application's log pipeline.
                let obj: Record<string, unknown>;
                try {
                    obj = JSON.parse(chunk) as Record<string, unknown>;
                } catch {
                    return;
                }

                const message = typeof obj.msg === 'string' ? obj.msg : '(log)';
                const severity = severityFor(obj.level);

                // Trace for every line — gives a queryable log stream
                // in App Insights "Logs → traces".
                client.trackTrace({
                    message,
                    severity,
                    properties: obj,
                });

                // Errors also surface as exceptions so the App
                // Insights "Failures" view picks them up. The err
                // shape comes from pino's serializers (see consumers
                // that pass `{ err }`).
                if (typeof obj.level === 'number' && obj.level >= 50) {
                    const errLike = obj.err as { message?: string; stack?: string } | undefined;
                    if (errLike) {
                        const exception = new Error(errLike.message ?? message);
                        if (errLike.stack) exception.stack = errLike.stack;
                        client.trackException({ exception, properties: obj });
                    }
                }
            },
        };
    } catch (err) {
        // SDK bootstrap failed (bad connection string, network at
        // boot, version mismatch). Surface to stderr once so an
        // operator notices, then fall through to the no-op path —
        // the application keeps running with stdout-only logging.
        process.stderr.write(
            `logger: Application Insights bootstrap failed — falling back to stdout only. ${
                err instanceof Error ? err.message : String(err)
            }\n`
        );
        return null;
    }
};

const appInsightsBridge = APPLICATIONINSIGHTS_CONNECTION_STRING
    ? buildAppInsightsBridge(APPLICATIONINSIGHTS_CONNECTION_STRING)
    : null;

const buildLogger = () => {
    // App Insights wired: multistream to stdout JSON + AI. We give
    // up the pino-pretty dev experience in this branch — if a
    // developer sets the env var locally, they're testing the AI
    // integration and want raw JSON anyway.
    if (appInsightsBridge) {
        const streams: pino.StreamEntry[] = [
            { stream: process.stdout },
            { stream: { write: appInsightsBridge.write } as NodeJS.WritableStream },
        ];
        return pino(baseOptions, pino.multistream(streams));
    }

    // No App Insights: keep the existing dev / prod split.
    if (isProduction) {
        return pino(baseOptions);
    }
    return pino({
        ...baseOptions,
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
                translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
                ignore: 'pid,hostname,service,env',
                singleLine: false,
            },
        },
    });
};

const logger = buildLogger();

export default logger;

/** Human-readable duration from milliseconds (e.g. "4h 30m", "2m 15s"). */
export const formatMs = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return m === 1 ? '1 minute' : `${m} minutes`;
    const h = Math.floor(m / 60);
    const rm = m % 60;
    const hLabel = h === 1 ? '1 hour' : `${h} hours`;
    return rm > 0 ? `${hLabel} ${rm}m` : hLabel;
};
