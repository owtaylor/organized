class Barrier {
  resolve: (() => void) | undefined;
  reject: ((err: unknown) => void) | undefined;
  promise: Promise<void> | undefined;

  constructor(private which: string) {
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }
}

class Synchronization {
  private barriers = new Map<string, Barrier>();

  private getBarrier(which: string): Barrier {
    let barrier = this.barriers.get(which);
    if (!barrier) {
      barrier = new Barrier(which);
      this.barriers.set(which, barrier);
    }
    return barrier;
  }

  async wait(which: string): Promise<void> {
    const barrier = this.getBarrier(which);
    await barrier.promise;
  }

  signal(which: string) {
    const barrier = this.getBarrier(which);
    barrier.resolve?.();
  }

  _rejectAll(err: unknown) {
    for (const barrier of this.barriers.values()) {
      barrier.reject?.(err);
    }
  }
}

export default async function runInParallel(
  ...jobs: ((sync: Synchronization) => Promise<void>)[]
): Promise<void> {
  const sync = new Synchronization();

  try {
    await Promise.all(jobs.map((job) => job(sync)));
  } catch (err) {
    // Release anyone stuck at a checkpoint
    sync._rejectAll(new Error("One of the parallel jobs failed"));
    throw err; // Propagate original failure
  }
}
