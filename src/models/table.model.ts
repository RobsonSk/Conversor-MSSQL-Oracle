/**
 * Table Model - Represents database table structure
 */

export interface ColumnDefinition {
  name: string;
  dataType: string;
  maxLength?: number;
  precision?: number;
  scale?: number;
  nullable: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  defaultValue?: string;
}

export interface TableDefinition {
  name: string;
  schema?: string;
  columns: ColumnDefinition[];
  primaryKey?: string[];
  totalRows: number;
  processedRows: number;
  failedRows: number;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
  lastProcessedId?: string | number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TableMapping {
  sourceTable: string;
  targetTable: string;
  columnMappings: {
    sourceColumn: string;
    targetColumn: string;
    sourceType: string;
    targetType: string;
    transformer?: string; // Custom transformation function name
  }[];
  skipColumns?: string[];
}

export class Table implements TableDefinition {
  name: string;
  schema?: string;
  columns: ColumnDefinition[];
  primaryKey?: string[];
  totalRows: number;
  processedRows: number;
  failedRows: number;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
  lastProcessedId?: string | number;
  createdAt: Date;
  updatedAt: Date;

  constructor(data: Partial<TableDefinition>) {
    this.name = data.name || '';
    this.schema = data.schema || 'dbo';
    this.columns = data.columns || [];
    this.primaryKey = data.primaryKey || [];
    this.totalRows = data.totalRows || 0;
    this.processedRows = data.processedRows || 0;
    this.failedRows = data.failedRows || 0;
    this.status = data.status || 'pending';
    this.lastProcessedId = data.lastProcessedId;
    this.createdAt = data.createdAt || new Date();
    this.updatedAt = data.updatedAt || new Date();
  }

  /**
   * Get completion percentage
   */
  getProgress(): number {
    if (this.totalRows === 0) return 0;
    return Math.round((this.processedRows / this.totalRows) * 100);
  }

  /**
   * Get successful rows count
   */
  getSuccessfulRows(): number {
    return this.processedRows - this.failedRows;
  }

  /**
   * Get success rate percentage
   */
  getSuccessRate(): number {
    if (this.processedRows === 0) return 100;
    return Math.round((this.getSuccessfulRows() / this.processedRows) * 100);
  }

  /**
   * Update progress
   */
  updateProgress(processedRows: number, failedRows: number = 0, lastId?: string | number): void {
    this.processedRows = processedRows;
    this.failedRows = failedRows;
    this.lastProcessedId = lastId;
    this.updatedAt = new Date();
  }

  /**
   * Mark table as completed
   */
  markCompleted(): void {
    this.status = 'completed';
    this.updatedAt = new Date();
  }

  /**
   * Mark table as failed
   */
  markFailed(): void {
    this.status = 'failed';
    this.updatedAt = new Date();
  }
}
