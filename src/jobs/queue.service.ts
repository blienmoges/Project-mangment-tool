import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, JobsOptions, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

export type QueueName = 'notifications' | 'deadlines';
type Processor = (job: Job) => Promise<unknown>;

const ADD_TIMEOUT_MS = 2000;

/**
 * BullMQ queues on Redis (API Design, "Background jobs"):
 *  - notifications: sends each email / SMS delivery, retried 3 times with growing waits;
 *  - deadlines: delayed jobs for the exact moment of each reminder, overdue alert and missed phase, plus the
 *    15-minute safety sweep.
 * The API never fails because Redis is down: adding a job times out quickly and the sweep catches up.
 * JOBS_ENABLED=false runs without Redis (development): see DeadlinesService for the in-process fallback.
 * RUN_WORKERS=false keeps this process from processing jobs (for a separate worker process later).
 */
@Injectable()
export class QueueService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('Queues');
  readonly enabled: boolean;
  private readonly runWorkers: boolean;
  private readonly url: string;
  private producer?: IORedis;
  private readonly queues = new Map<QueueName, Queue>();
  private readonly processors = new Map<QueueName, Processor>();
  private readonly workers: Worker[] = [];
  /** BullMQ does not close connections it was given, so they are closed here on shutdown. */
  private readonly connections: IORedis[] = [];

  constructor(config: ConfigService) {
    this.enabled = config.get('JOBS_ENABLED') !== 'false';
    this.runWorkers = config.get('RUN_WORKERS') !== 'false';
    this.url = config.get('REDIS_URL') ?? 'redis://localhost:6379';
    if (this.enabled) {
      // Producers fail fast when Redis is unreachable instead of waiting (BullMQ's advice for queues).
      this.producer = new IORedis(this.url, { enableOfflineQueue: false, maxRetriesPerRequest: 1 });
      this.producer.on('error', (e) => this.warnOnce('redis', `Redis: ${e.message}`));
      for (const name of ['notifications', 'deadlines'] as QueueName[]) {
        const q = new Queue(name, { connection: this.producer });
        q.on('error', (e) => this.warnOnce(`queue-${name}`, `Queue ${name}: ${e.message}`));
        this.queues.set(name, q);
      }
    }
  }

  private readonly lastWarned = new Map<string, number>();

  /** While Redis is down every connection retries constantly; log each kind of problem at most once a minute. */
  private warnOnce(key: string, message: string) {
    const now = Date.now();
    if (now - (this.lastWarned.get(key) ?? 0) < 60_000) return;
    this.lastWarned.set(key, now);
    this.logger.warn(message);
  }

  /** Called by the services that handle a queue's jobs, before the app finishes starting. */
  process(queue: QueueName, processor: Processor) {
    this.processors.set(queue, processor);
  }

  onApplicationBootstrap() {
    if (!this.enabled || !this.runWorkers) return;
    for (const [name, processor] of this.processors) {
      const connection = new IORedis(this.url, { maxRetriesPerRequest: null }); // required by BullMQ workers
      this.connections.push(connection);
      connection.on('error', (e) => this.warnOnce(`redis-${name}`, `Redis (worker ${name}): ${e.message}`));
      const worker = new Worker(name, processor, { connection, concurrency: 5 });
      worker.on('failed', (job, err) => this.logger.warn(`${name} job ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`));
      worker.on('error', (err) => this.warnOnce(`worker-${name}`, `${name} worker: ${err.message}`));
      this.workers.push(worker);
    }
    this.logger.log(`Workers running for: ${[...this.processors.keys()].join(', ')}`);
  }

  /** Adds a job. Returns false (and logs) instead of throwing when the queue is off or Redis is unreachable. */
  async add(queue: QueueName, name: string, data: object, opts: JobsOptions = {}) {
    const q = this.queues.get(queue);
    if (!q) return false;
    try {
      await withTimeout(
        q.add(name, data, {
          removeOnComplete: { age: 24 * 3600, count: 10_000 },
          removeOnFail: { age: 7 * 24 * 3600 },
          ...opts,
          delay: Math.max(0, Math.round(opts.delay ?? 0)),
        }),
        ADD_TIMEOUT_MS,
      );
      return true;
    } catch (e) {
      this.logger.warn(`Could not queue ${queue}/${name} (${opts.jobId ?? 'no id'}): ${(e as Error).message}`);
      return false;
    }
  }

  /** Removes a waiting or delayed job, if it exists. */
  async remove(queue: QueueName, jobId: string) {
    const q = this.queues.get(queue);
    if (!q) return;
    try {
      await withTimeout(q.remove(jobId), ADD_TIMEOUT_MS);
    } catch (e) {
      this.logger.warn(`Could not remove ${queue}/${jobId}: ${(e as Error).message}`);
    }
  }

  /** A repeating job (the safety sweep), registered once however often the app restarts. */
  async every(queue: QueueName, schedulerId: string, ms: number, name: string) {
    const q = this.queues.get(queue);
    if (!q) return false;
    try {
      await withTimeout(q.upsertJobScheduler(schedulerId, { every: ms }, { name, data: {}, opts: { removeOnComplete: true, removeOnFail: { age: 24 * 3600 } } }), ADD_TIMEOUT_MS);
      return true;
    } catch (e) {
      this.logger.warn(`Could not schedule ${schedulerId}: ${(e as Error).message}`);
      return false;
    }
  }

  async onModuleDestroy() {
    await Promise.allSettled(this.workers.map((w) => w.close()));
    await Promise.allSettled([...this.queues.values()].map((q) => q.close()));
    for (const c of this.connections) c.disconnect();
    this.producer?.disconnect();
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

/** BullMQ job ids may not contain ":". */
export const jobId = (...parts: (string | number)[]) => parts.join('_');
