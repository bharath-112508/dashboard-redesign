import type { Request, Response, NextFunction } from 'express';

import { NESTED_PATH_TOPIC_MAP, PATH_TOPIC_MAP, REALTIME_TOPICS } from '../constants/realtime.js';
import { publish } from '../services/realtime.service.js';
import logger from '../utils/logger.js';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * After a successful mutating request, publish a data-less change event for
 * the topic derived from the request's first path segment. One interceptor
 * covers every web-app write across all modules. Slack-driven writes bypass
 * HTTP routes and emit explicitly in the interactive controller.
 *
 * Best-effort: registered on `res.on('finish')` and wrapped so a publish
 * failure can never affect the HTTP response.
 */
export const realtimeEmit = (req: Request, res: Response, next: NextFunction): void => {
    if (MUTATING.has(req.method)) {
        // Capture the topic NOW — `req.path` is correct at middleware entry. By
        // the time `res.on('finish')` fires, Express has mutated `req.url` while
        // descending nested routers, so reading the path then is unreliable.
        const segments = req.path.split('/').filter(Boolean);
        const topic = segments[0] ? PATH_TOPIC_MAP[segments[0]] : undefined;
        if (topic) {
            // A nested sub-resource (`/tasks/:id/comments`) adds its own topic.
            // Only under tasks: a DevOps request's comments are not task comments.
            const nested = segments[2] && topic === REALTIME_TOPICS.TASKS ? NESTED_PATH_TOPIC_MAP[segments[2]] : undefined;
            const topics = nested && nested !== topic ? [topic, nested] : [topic];
            res.on('finish', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) publish(topics);
                } catch (err) {
                    logger.warn({ err, code: 'REALTIME_EMIT_FAILED' }, 'realtime emit middleware failed');
                }
            });
        }
    }
    next();
};
