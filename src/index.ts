import express from 'express';
import cors, { type CorsOptions } from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { ulid } from 'ulid';
import { StatusCodes } from 'http-status-codes';

import { PORT, CORS_ORIGINS, NODE_ENV } from './config/server.config.js';
import connectDB, { disconnectDB } from './config/database.config.js';
import appRoutes from './routes/index.js';
import { globalErrorHandler } from './middlewares/error-handler.middleware.js';
import { generalRateLimiter } from './middlewares/rate-limit.middleware.js';
import { API_PREFIX, ERROR_CODES } from './constants/index.js';
import { ok } from './utils/api-response.js';
import logger from './utils/logger.js';
import { seedDefaultLeaveTypes } from './services/leave-type.service.js';

const app = express();

app.set('trust proxy', 1);

app.use(
    pinoHttp({
        logger,
        genReqId: (req, res) => {
            const incoming = (req.headers['x-request-id'] as string | undefined) ?? ulid();
            res.setHeader('x-request-id', incoming);
            return incoming;
        },
        customLogLevel: (_req, res, err) => {
            if (err || res.statusCode >= 500) return 'error';
            if (res.statusCode >= 400) return 'warn';
            return 'info';
        },
    })
);

app.use(helmet());

const corsOptions: CorsOptions = {
    origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) {
            return callback(null, true);
        }
        return callback(new Error(`CORS: origin ${origin} not allowed`));
    },
    credentials: false,
};
app.use(cors(corsOptions));

app.use(compression());

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

app.use(API_PREFIX, generalRateLimiter);

app.get('/health', (_req, res) => {
    return ok(res, { status: 'ok', env: NODE_ENV });
});

app.use(API_PREFIX, appRoutes);

app.use('/{*path}', (_req, res) => {
    return res
        .status(StatusCodes.NOT_FOUND)
        .json({ error: { code: ERROR_CODES.RESOURCE_NOT_FOUND, message: 'Route not found' } });
});

app.use(globalErrorHandler);

const startServer = async () => {
    try {
        await connectDB();

        // Make sure the seven canonical leave types exist (idempotent).
        // Admin-tweaked rows are preserved via $setOnInsert.
        await seedDefaultLeaveTypes();

        const server = app.listen(PORT, () => {
            logger.info({ port: PORT, env: NODE_ENV, api_prefix: API_PREFIX }, 'Server is running');
        });

        const shutdown = (signal: string) => {
            logger.info({ signal }, 'Shutdown signal received, closing gracefully');
            server.close(async () => {
                logger.info('HTTP server closed');
                await disconnectDB();
                process.exit(0);
            });

            setTimeout(() => {
                logger.error('Could not close connections in time, forcefully shutting down');
                process.exit(1);
            }, 10000);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));

        process.on('unhandledRejection', (reason) => {
            logger.error({ reason }, 'Unhandled promise rejection');
        });
        process.on('uncaughtException', (err) => {
            logger.fatal({ err }, 'Uncaught exception');
            process.exit(1);
        });
    } catch (error) {
        logger.error({ err: error }, 'Failed to start server');
        process.exit(1);
    }
};

startServer();
