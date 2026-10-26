/**
 * Batch Processor Utility - Handles batch processing logic
 */

export interface BatchProcessorOptions {
  batchSize: number;
  onBatch: (batch: any[], batchNumber: number) => Promise<void>;
  onError?: (error: Error, batchNumber: number, batch: any[]) => void;
  onComplete?: (totalBatches: number) => void;
  maxRetries?: number;
}

export class BatchProcessor {
  /**
   * Process data in batches
   */
  static async processBatches<T>(items: T[], options: BatchProcessorOptions): Promise<void> {
    const { batchSize, onBatch, onError, onComplete, maxRetries = 3 } = options;

    if (items.length === 0) {
      onComplete?.(0);
      return;
    }

    const totalBatches = Math.ceil(items.length / batchSize);
    let batchNumber = 0;

    for (let i = 0; i < items.length; i += batchSize) {
      batchNumber++;
      const batch = items.slice(i, i + batchSize);

      let retryCount = 0;
      let success = false;

      while (retryCount < maxRetries && !success) {
        try {
          await onBatch(batch, batchNumber);
          success = true;
        } catch (error) {
          retryCount++;
          if (retryCount >= maxRetries) {
            onError?.(error as Error, batchNumber, batch);
            throw error;
          }
          // Exponential backoff
          await this.delay(Math.pow(2, retryCount) * 1000);
        }
      }
    }

    onComplete?.(totalBatches);
  }

  /**
   * Delay helper
   */
  static delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Split array into chunks
   */
  static chunk<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  /**
   * Parallel batch processing
   */
  static async processParallel<T>(
    items: T[],
    batchSize: number,
    processor: (batch: T[]) => Promise<void>,
    concurrency: number = 3
  ): Promise<void> {
    const batches = this.chunk(items, batchSize);
    const results: Promise<void>[] = [];

    for (let i = 0; i < batches.length; i += concurrency) {
      const concurrentBatches = batches.slice(i, i + concurrency);
      const promises = concurrentBatches.map((batch) => processor(batch));
      results.push(...promises);

      if (results.length >= concurrency) {
        await Promise.all(results.splice(0, concurrency));
      }
    }

    if (results.length > 0) {
      await Promise.all(results);
    }
  }
}
