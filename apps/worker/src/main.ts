import { Worker } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';
import { readConfig } from '@uni/config';
import { queueNames } from '@uni/shared';

const config = readConfig();
const log = pino({ name: 'uni-mail-worker' });
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null, lazyConnect: true });
const workers: Worker[] = [];

async function main() {
  await connection.connect();
  await connection.ping();
  for (const name of queueNames) {
    const worker = new Worker(name, async (job) => {
      // Reject accidental production work until each processor is implemented.
      throw new Error(`Processor for ${job.queueName} is not implemented`);
    }, { connection, autorun: true });
    worker.on('failed', (job, error) => log.error({ queue: name, jobId: job?.id, error: error.message }, 'job failed'));
    worker.on('error', (error) => log.error({ queue: name, error: error.message }, 'worker error'));
    workers.push(worker);
  }
  log.info({ queues: queueNames }, 'worker ready');
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.all(workers.map((worker) => worker.close()));
  await connection.quit();
  log.info('worker stopped');
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
main().catch((error: unknown) => { log.error({ error: String(error) }, 'worker startup failed'); process.exit(1); });
