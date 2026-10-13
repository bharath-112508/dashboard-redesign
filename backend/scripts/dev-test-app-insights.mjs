#!/usr/bin/env node
/** Dev-only: confirm the App Insights logger bridge wires correctly. */
import 'dotenv/config';
import logger from '../src/utils/logger.ts';

logger.info('AI bridge boot OK');
logger.warn({ subscription_id: 'abc' }, 'warn via bridge');
logger.error({ err: new Error('boom'), context: 'smoke' }, 'error via bridge');
// Give the SDK a moment to enqueue + flush before exit
await new Promise((r) => setTimeout(r, 300));
