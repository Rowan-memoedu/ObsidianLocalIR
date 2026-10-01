/** Serialize a latest-state operation and drain requests arriving during an await. */
export class CoalescedAsyncTask {
  private requested = false;
  private running: Promise<void> | null = null;

  constructor(private readonly work: () => Promise<void>) {}

  request(): Promise<void> {
    this.requested = true;
    if (!this.running) {
      this.running = Promise.resolve().then(async () => {
        try {
          while (this.requested) {
            this.requested = false;
            await this.work();
          }
        } finally {
          // Clear synchronously with the final pending check, not in a later .finally().
          this.running = null;
        }
      });
    }
    return this.running;
  }
}
