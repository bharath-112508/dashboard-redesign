import mongoose from 'mongoose';

import { DB_URI } from './server.config.js';
import logger from '../utils/logger.js';

const connectDB = async () => {
    try {
        // H20 — explicit connection options. Mongoose's bare
        // `connect(DB_URI)` falls back to driver defaults that are
        // wrong for a hosted API:
        //
        //  - `serverSelectionTimeoutMS` default = 30_000 means a Mongo
        //    blackhole at boot delays the failed health probe by 30 s
        //    AND every in-request lookup by 30 s. 5 s lets the boot
        //    surface a clean failure faster and keeps request
        //    timeouts (H16: 30 s) usefully tighter.
        //  - `socketTimeoutMS` default = `undefined` (effectively
        //    infinite) means a hung connection in the pool blocks a
        //    request forever. 45 s caps it.
        //  - `maxPoolSize` default = 100. Cosmos / Atlas connection
        //    ceilings on small tiers can be far below 100; cap to 50
        //    so a sudden burst doesn't trip the cluster's connection
        //    limit.
        //  - `retryWrites` is on by default in modern drivers; spelled
        //    out so an audit can confirm at a glance.
        const connection = await mongoose.connect(DB_URI, {
            serverSelectionTimeoutMS: 5_000,
            socketTimeoutMS: 45_000,
            maxPoolSize: 50,
            retryWrites: true,
        });
        logger.info({ host: connection.connection.host, db: connection.connection.name }, 'Database connected');
    } catch (error) {
        logger.error({ err: error }, 'Database connection failed');
        process.exit(1);
    }
};

export const disconnectDB = async (): Promise<void> => {
    try {
        // L1 — explicit `force=false` makes the graceful intent grep-able.
        // The default is already `false`, but spelling it out documents
        // the choice and pairs with C7's await-before-disconnect change:
        // we WANT mongoose to drain in-flight ops, not yank them away.
        await mongoose.connection.close(false);
        logger.info('Database connection closed');
    } catch (error) {
        logger.error({ err: error }, 'Error while closing database connection');
    }
};

mongoose.connection.on('disconnected', () => logger.warn('Mongo disconnected'));
mongoose.connection.on('reconnected', () => logger.info('Mongo reconnected'));

export default connectDB;
