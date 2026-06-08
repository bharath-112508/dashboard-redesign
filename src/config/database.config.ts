import mongoose from 'mongoose';

import { DB_URI } from './server.config.js';
import logger from '../utils/logger.js';

const connectDB = async () => {
    try {
        const connection = await mongoose.connect(DB_URI);
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
