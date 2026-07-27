import { Queue } from 'bullmq';
import { redis } from './redis.js';

export const visionQueue = new Queue('vision-jobs', { connection: redis });
