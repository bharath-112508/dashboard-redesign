import pino, { type LoggerOptions } from 'pino';
import { LOG_LEVEL, NODE_ENV } from '../config/server.config.js';

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

const logger = pino(
    isProduction
        ? baseOptions
        : {
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
          }
);

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
