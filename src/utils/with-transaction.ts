import mongoose, { type ClientSession } from 'mongoose';

import logger from './logger.js';

/**
 * Wraps a multi-document write in a Mongo transaction so partial
 * failures roll back instead of leaving orphans.
 *
 *   const user = await withTransaction(async (session) => {
 *     const u = await User.create([input], { session });
 *     await LeaveBalance.create(rows.map(r => ({ ...r, user_id: u[0]._id })), { session });
 *     return u[0];
 *   });
 *
 * Every write inside the callback MUST pass the `{ session }` option
 * — this is how Mongoose enrolls the operation in the transaction.
 * Forgetting it silently writes outside the transaction (no error,
 * just no rollback). The callback's return value is the resolved
 * value of the outer promise.
 *
 * Topology requirement: transactions need a replica set. MongoDB
 * Atlas is always a replica set; local dev with a standalone `mongod`
 * needs `--replSet rs0` + an `rs.initiate()` one-time setup. We log
 * a warning at startup if the topology doesn't support transactions
 * (see `index.ts` startup hook), and the helper itself will throw
 * the standard Mongoose error if called against a standalone.
 *
 * Idempotency: `session.withTransaction()` retries on
 * `TransientTransactionError` and `UnknownTransactionCommitResult`
 * (Mongo driver default). The callback may run more than once on a
 * commit-conflict; keep it pure (no external side effects beyond
 * the writes in `session`). Audit-log writes are inside the
 * transaction in this codebase, so they retry too — that's
 * intentional, otherwise a retried tx would lose its audit row.
 */
export const withTransaction = async <T>(
    callback: (session: ClientSession | null) => Promise<T>
): Promise<T> => {
    // If we can't open a session at all (no connection / mocked
    // Mongoose in tests), run the callback without one. The caller
    // loses atomicity guarantees but keeps functional correctness —
    // matches the pre-helper behaviour. Production environments
    // (Atlas / replica set) get the real transaction.
    //
    // The readyState check is critical: `startSession()` against an
    // unconnected Mongoose buffers the operation for 10s before
    // throwing (the default `bufferTimeoutMS`). In tests where the
    // models are vi.mock'd and there's no real connection, that
    // would hang every test that flows through here. Bypass the
    // wait by checking the connection state up-front.
    if (mongoose.connection.readyState !== 1) {
        return callback(null);
    }
    let session: ClientSession;
    try {
        session = await mongoose.startSession();
    } catch (err) {
        logger.warn(
            { err },
            'withTransaction: startSession failed; running callback without a session (no atomicity)'
        );
        return callback(null);
    }

    try {
        let result: T | undefined;
        try {
            await session.withTransaction(async () => {
                result = await callback(session);
            });
        } catch (err) {
            // Standalone Mongo (no replica set) rejects the BEGIN
            // with `Transaction numbers are only allowed on a replica
            // set member`. Detect and fall back; matches the
            // "best-effort sequential" pre-helper behaviour for
            // local-dev standalone deployments.
            const message = err instanceof Error ? err.message : String(err);
            if (/replica set|not supported|sessions are not supported/i.test(message)) {
                logger.warn(
                    { err },
                    'withTransaction: topology does not support transactions; falling back to non-atomic sequential writes'
                );
                return callback(null);
            }
            throw err;
        }
        return result as T;
    } catch (err) {
        // Other errors (callback threw, commit conflict exceeded
        // retry budget, etc.) propagate. Log a structured entry so
        // the operator's stack trace pinpoints the tx, then re-throw
        // unchanged — service-layer handlers expect the original
        // AppError / Mongoose error.
        logger.error(
            { err },
            'withTransaction: callback failed; transaction aborted'
        );
        throw err;
    } finally {
        await session.endSession();
    }
};

