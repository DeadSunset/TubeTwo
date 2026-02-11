export class BatchQueue {
  constructor({ batchSize = 10, onProgress = () => {} } = {}) {
    this.batchSize = batchSize;
    this.onProgress = onProgress;
    this.items = [];
    this.index = 0;
    this.paused = false;
    this.cancelled = false;
  }

  add(task) { this.items.push(task); }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  cancel() { this.cancelled = true; }

  async run() {
    let done = 0;
    while (this.index < this.items.length && !this.cancelled) {
      if (this.paused) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      const slice = this.items.slice(this.index, this.index + this.batchSize);
      await Promise.all(slice.map((task) => task().catch(() => null)));
      this.index += slice.length;
      done += slice.length;
      this.onProgress({ done, total: this.items.length });
      await new Promise((r) => setTimeout(r));
    }
    return { done, total: this.items.length, cancelled: this.cancelled };
  }
}
