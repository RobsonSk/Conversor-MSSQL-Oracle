/**
 * Pending Adjustments Service
 * Manages rows that fail insertion due to schema discrepancies (e.g. ORA-12899 string length, ORA-01400 nullability)
 * Preserves original data with 100% fidelity without alteration for post-migration adjustments.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

export interface PendingRowAdjustment {
  id: string;
  tableName: string;
  columnName?: string;
  actualLength?: number;
  maxLength?: number;
  errorNum?: number;
  errorMessage: string;
  rowData: Record<string, any>;
  timestamp: string;
}

export class PendingAdjustmentsService {
  private static instance: PendingAdjustmentsService;
  private filePath: string;
  private dataErrorLogPath: string;

  private constructor() {
    const logsDir = path.resolve(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
    this.filePath = path.join(logsDir, 'pending-adjustments.json');
    this.dataErrorLogPath = path.join(logsDir, 'data-errors.log');
  }

  static getInstance(): PendingAdjustmentsService {
    if (!PendingAdjustmentsService.instance) {
      PendingAdjustmentsService.instance = new PendingAdjustmentsService();
    }
    return PendingAdjustmentsService.instance;
  }

  /**
   * Parse column name and lengths from Oracle error messages (e.g. ORA-12899 or ORA-01400)
   */
  parseOracleError(errorMessage: string): {
    columnName?: string;
    actualLength?: number;
    maxLength?: number;
  } {
    if (!errorMessage) return {};

    // ORA-12899: value too large for column "SCHEMA"."TABLE"."COLUMN" (actual: 70, maximum: 30)
    // ORA-12899: valor muito grande para a coluna "CNP"."GER_PARAM_CORINGA"."VALOR" (real: 70, máximo: 30)
    const ora12899Match = errorMessage.match(
      /ORA-12899:\s*[^"]*(?:"[^"]+"\.)*(?:"[^"]+"\.)*"([^"]+)"\s*\((?:real|actual):\s*(\d+),\s*(?:m[áa]ximo|maximum):\s*(\d+)\)/i
    );
    if (ora12899Match) {
      return {
        columnName: ora12899Match[1].toUpperCase(),
        actualLength: parseInt(ora12899Match[2], 10),
        maxLength: parseInt(ora12899Match[3], 10),
      };
    }

    // ORA-01400: cannot insert NULL into ("SCHEMA"."TABLE"."COLUMN")
    // ORA-01400: não é possível inserir NULL em ("SCHEMA"."TABLE"."COLUMN")
    const ora1400Match = errorMessage.match(/ORA-01400:\s*[^"]+(?:"[^"]+"\.)*(?:"[^"]+"\.)*"([^"]+)"/i);
    if (ora1400Match) {
      return {
        columnName: ora1400Match[1].toUpperCase(),
      };
    }

    return {};
  }

  /**
   * Record a failed row adjustment preserving full untruncated row data
   */
  recordAdjustment(adjustment: PendingRowAdjustment): void {
    try {
      // 1. Append to human-readable data-errors.log
      const logLine = `[${adjustment.timestamp}] TABLE: ${adjustment.tableName} | COLUMN: ${adjustment.columnName || 'N/A'} | ERROR: ${adjustment.errorMessage} | DATA: ${JSON.stringify(adjustment.rowData)}\n`;
      fs.appendFileSync(this.dataErrorLogPath, logLine, 'utf-8');

      // 2. Append to pending-adjustments.json
      let adjustments: PendingRowAdjustment[] = [];
      if (fs.existsSync(this.filePath)) {
        try {
          const content = fs.readFileSync(this.filePath, 'utf-8');
          adjustments = JSON.parse(content);
        } catch (_) {
          adjustments = [];
        }
      }

      // Check if duplicate entry already exists (same table, same row data JSON)
      const rowDataStr = JSON.stringify(adjustment.rowData);
      const exists = adjustments.some(
        (a) => a.tableName === adjustment.tableName && JSON.stringify(a.rowData) === rowDataStr
      );

      if (!exists) {
        adjustments.push(adjustment);
        fs.writeFileSync(this.filePath, JSON.stringify(adjustments, null, 2), 'utf-8');
      }

      logger.warn(
        `[Pending Adjustment] Marked row in ${adjustment.tableName} due to: ${adjustment.errorMessage}. Full row preserved in logs/pending-adjustments.json`,
        'PendingAdjustmentsService'
      );
    } catch (err) {
      logger.error('Failed to record pending adjustment', err as Error, 'PendingAdjustmentsService');
    }
  }

  /**
   * Get all pending adjustments
   */
  getAllAdjustments(): PendingRowAdjustment[] {
    try {
      if (!fs.existsSync(this.filePath)) return [];
      const content = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch {
      return [];
    }
  }

  /**
   * Remove resolved adjustments by IDs
   */
  removeAdjustments(resolvedIds: string[]): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const adjustments = this.getAllAdjustments();
      const remaining = adjustments.filter((a) => !resolvedIds.includes(a.id));
      fs.writeFileSync(this.filePath, JSON.stringify(remaining, null, 2), 'utf-8');
    } catch (err) {
      logger.error('Failed to update pending adjustments after resolution', err as Error, 'PendingAdjustmentsService');
    }
  }
}

export const pendingAdjustmentsService = PendingAdjustmentsService.getInstance();
