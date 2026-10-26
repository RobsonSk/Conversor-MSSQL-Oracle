/**
 * Error Model - Tracks migration errors
 */

export enum ErrorType {
  CONNECTION = 'CONNECTION_ERROR',
  SCHEMA = 'SCHEMA_ERROR',
  TYPE_CONVERSION = 'TYPE_CONVERSION_ERROR',
  VALIDATION = 'VALIDATION_ERROR',
  CONSTRAINT = 'CONSTRAINT_VIOLATION',
  DATA_INTEGRITY = 'DATA_INTEGRITY_ERROR',
  UNKNOWN = 'UNKNOWN_ERROR',
}

export interface ErrorDetail {
  id: string;
  type: ErrorType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  source: string; // table name
  rowId?: string | number;
  column?: string;
  value?: any;
  expectedFormat?: string;
  actualFormat?: string;
  timestamp: Date;
  recoverable: boolean;
  retryCount?: number;
  stack?: string;
}

export class MigrationError implements ErrorDetail {
  id: string;
  type: ErrorType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  source: string;
  rowId?: string | number;
  column?: string;
  value?: any;
  expectedFormat?: string;
  actualFormat?: string;
  timestamp: Date;
  recoverable: boolean;
  retryCount?: number;
  stack?: string;

  constructor(data: Partial<ErrorDetail>) {
    this.id = data.id || `ERR-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.type = data.type || ErrorType.UNKNOWN;
    this.severity = data.severity || 'MEDIUM';
    this.message = data.message || 'Unknown error occurred';
    this.source = data.source || 'unknown';
    this.rowId = data.rowId;
    this.column = data.column;
    this.value = data.value;
    this.expectedFormat = data.expectedFormat;
    this.actualFormat = data.actualFormat;
    this.timestamp = data.timestamp || new Date();
    this.recoverable = data.recoverable !== undefined ? data.recoverable : true;
    this.retryCount = data.retryCount || 0;
    this.stack = data.stack;
  }

  /**
   * Get error summary
   */
  getSummary(): string {
    let summary = `[${this.type}] ${this.message}`;
    if (this.source) summary += ` (Table: ${this.source})`;
    if (this.rowId) summary += ` (Row ID: ${this.rowId})`;
    if (this.column) summary += ` (Column: ${this.column})`;
    return summary;
  }

  /**
   * Get detailed error report
   */
  getDetailedReport(): string {
    const report = [
      `Error ID: ${this.id}`,
      `Type: ${this.type}`,
      `Severity: ${this.severity}`,
      `Message: ${this.message}`,
      `Source: ${this.source}`,
      this.rowId ? `Row ID: ${this.rowId}` : null,
      this.column ? `Column: ${this.column}` : null,
      this.value ? `Value: ${JSON.stringify(this.value)}` : null,
      this.expectedFormat ? `Expected Format: ${this.expectedFormat}` : null,
      this.actualFormat ? `Actual Format: ${this.actualFormat}` : null,
      `Timestamp: ${this.timestamp.toISOString()}`,
      `Recoverable: ${this.recoverable}`,
      this.retryCount ? `Retry Count: ${this.retryCount}` : null,
      this.stack ? `Stack:\n${this.stack}` : null,
    ];

    return report.filter((line) => line !== null).join('\n');
  }

  /**
   * Increment retry count
   */
  incrementRetry(): void {
    this.retryCount = (this.retryCount || 0) + 1;
  }

  /**
   * Check if error is critical
   */
  isCritical(): boolean {
    return this.severity === 'CRITICAL' && !this.recoverable;
  }
}
