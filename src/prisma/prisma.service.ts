import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AsyncLocalStorage } from 'async_hooks';

type Hook = () => unknown | Promise<unknown>;
const afterCommitStore = new AsyncLocalStorage<Hook[]>();
const logger = new Logger('AfterCommit');

/**
 * Runs `hook` once the surrounding PrismaService.tx() transaction has committed (never if it rolls back).
 * Used for work that must not happen before the data is saved: queueing emails and SMS, WebSocket pushes, jobs.
 * Outside tx() the hook runs on the next tick.
 */
export function afterCommit(hook: Hook) {
  const hooks = afterCommitStore.getStore();
  if (hooks) hooks.push(hook);
  else setImmediate(() => runHook(hook));
}

async function runHook(hook: Hook) {
  try {
    await hook();
  } catch (e) {
    logger.error(e instanceof Error ? e.stack : String(e));
  }
}

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** $transaction that also runs the afterCommit() hooks registered inside it, after a successful commit. */
  async tx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeout?: number }): Promise<T> {
    const hooks: Hook[] = [];
    const result = await afterCommitStore.run(hooks, () => this.$transaction(fn, options));
    for (const hook of hooks) await runHook(hook);
    return result;
  }
}
