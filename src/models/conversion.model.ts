/**
 * Conversion Model - Tracks migration progress
 */

import { MigrationMode } from '../config/migration.config';

export interface ConversionCheckpoint {
  tableId: string;
  tableName: string;
  lastProcessedId?: string | number;
  processedRows: number;
  failedRows: number;
  batchNumber: number;
  timestamp: Date;
}

export interface ConversionStats {
  totalTables: number;
  completedTables: number;
  skippedTables: number;
  failedTables: number;
  totalRows: number;
  processedRows: number;
  successfulRows: number;
  failedRows: number;
  skippedRows: number;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  averageRowsPerSecond?: number;
  errorCount: number;
  warningCount: number;
}

export interface MigrationSession {
  id: string;
  mode: MigrationMode;
  targetTable?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
  startTime: Date;
  endTime?: Date;
  checkpoints: ConversionCheckpoint[];
  stats: ConversionStats;
  lastError?: string;
}

export class Conversion implements MigrationSession {
  id: string;
  mode: MigrationMode;
  targetTable?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'paused';
  startTime: Date;
  endTime?: Date;
  checkpoints: ConversionCheckpoint[];
  stats: ConversionStats;
  lastError?: string;

  constructor(id: string, mode: MigrationMode, targetTable?: string) {
    this.id = id;
    this.mode = mode;
    this.targetTable = targetTable;
    this.status = 'pending';
    this.startTime = new Date();
    this.checkpoints = [];
    this.stats = {
      totalTables: 0,
      completedTables: 0,
      skippedTables: 0,
      failedTables: 0,
      totalRows: 0,
      processedRows: 0,
      successfulRows: 0,
      failedRows: 0,
      skippedRows: 0,
      startTime: new Date(),
      errorCount: 0,
      warningCount: 0,
    };
  }

  /**
   * Start the migration
   */
  start(): void {
    this.status = 'running';
    this.stats.startTime = new Date();
  }

  /**
   * Complete the migration
   */
  complete(): void {
    this.status = 'completed';
    this.endTime = new Date();
    this.calculateStats();
  }

  /**
   * Fail the migration
   */
  fail(error: string): void {
    this.status = 'failed';
    this.endTime = new Date();
    this.lastError = error;
    this.calculateStats();
  }

  /**
   * Pause the migration
   */
  pause(): void {
    this.status = 'paused';
  }

  /**
   * Add checkpoint
   */
  addCheckpoint(checkpoint: ConversionCheckpoint): void {
    this.checkpoints.push(checkpoint);
  }

  /**
   * Get latest checkpoint
   */
  getLatestCheckpoint(): ConversionCheckpoint | undefined {
    return this.checkpoints[this.checkpoints.length - 1];
  }

  /**
   * Calculate and update stats
   */
  private calculateStats(): void {
    if (this.endTime && this.stats.startTime) {
      this.stats.duration = this.endTime.getTime() - this.stats.startTime.getTime();
      this.stats.averageRowsPerSecond = this.stats.processedRows / (this.stats.duration / 1000);
    }
  }

  /**
   * Update progress
   */
  updateProgress(
    totalTables: number,
    completedTables: number,
    totalRows: number,
    processedRows: number,
    failedRows: number
  ): void {
    this.stats.totalTables = totalTables;
    this.stats.completedTables = completedTables;
    this.stats.totalRows = totalRows;
    this.stats.processedRows = processedRows;
    this.stats.failedRows = failedRows;
    this.stats.successfulRows = processedRows - failedRows;
  }

  /**
   * Get completion percentage
   */
  getProgress(): number {
    if (this.stats.totalTables === 0) return 0;
    return Math.round((this.stats.completedTables / this.stats.totalTables) * 100);
  }

  /**
   * Get overall success rate
   */
  getSuccessRate(): number {
    if (this.stats.processedRows === 0) return 100;
    return Math.round((this.stats.successfulRows / this.stats.processedRows) * 100);
  }
}
