/**
 * Incremental Sync Service - Determines and manages delta synchronization strategies
 */

import { Table } from '../models/table.model';
import { oracleConnector } from '../connectors/oracle.connector';
import { migrationConfig } from '../config/migration.config';

export type SyncStrategyType = 'DATE_DELTA' | 'ID_DELTA' | 'FAST_RELOAD' | 'FULL_MERGE';

export interface SyncPlan {
  strategy: SyncStrategyType;
  whereClause?: string;
  dateColumn?: string;
  pkColumns: string[];
  lastSyncTimestamp?: string;
  lastMaxId?: any;
  needsTruncate: boolean;
  description: string;
}

export class IncrementalSyncService {
  /**
   * Plan synchronization strategy for a table
   */
  async planSync(table: Table, lastCheckpointData?: any): Promise<SyncPlan> {
    const pkColumns = table.columns.filter((c) => c.isPrimaryKey).map((c) => c.name);
    const dateColumn = this.detectDateColumn(table);

    // 1. Estratégia Baseada em Data/Timestamp de Auditoria
    if (dateColumn) {
      let cutOffDate: Date | null = null;

      // Verifica se há data no checkpoint salvo
      const tableCheckpoint = lastCheckpointData?.tables?.[table.name];
      if (tableCheckpoint?.lastSyncTimestamp) {
        cutOffDate = new Date(tableCheckpoint.lastSyncTimestamp);
      }

      // Se não há no checkpoint, busca o MAX(dateColumn) diretamente no Oracle
      if (!cutOffDate || isNaN(cutOffDate.getTime())) {
        const oracleMaxDate = await oracleConnector.getMaxValue(table.name, dateColumn);
        if (oracleMaxDate) {
          cutOffDate = new Date(oracleMaxDate);
        }
      }

      if (cutOffDate && !isNaN(cutOffDate.getTime())) {
        // Aplica margem de segurança (lookback) em minutos
        const lookbackMs = (migrationConfig.incrementalLookbackMinutes || 30) * 60 * 1000;
        const adjustedDate = new Date(cutOffDate.getTime() - lookbackMs);
        const formattedDate = this.formatDateForSql(adjustedDate);

        return {
          strategy: 'DATE_DELTA',
          whereClause: `[${dateColumn}] >= '${formattedDate}'`,
          dateColumn,
          pkColumns,
          lastSyncTimestamp: new Date().toISOString(),
          needsTruncate: false,
          description: `Date delta sync on [${dateColumn}] >= '${formattedDate}' (${pkColumns.length > 0 ? 'MERGE / Upsert' : 'APPEND'})`,
        };
      }
    }

    // 2. Estratégia Baseada em Chave Primária Numérica / Identity (Sem coluna de data)
    const singleNumericPk = this.getSingleNumericPk(table);
    if (singleNumericPk) {
      const oracleMaxId = await oracleConnector.getMaxValue(table.name, singleNumericPk);

      if (oracleMaxId !== null && oracleMaxId !== undefined) {
        return {
          strategy: 'ID_DELTA',
          whereClause: `[${singleNumericPk}] > ${oracleMaxId}`,
          pkColumns: [singleNumericPk],
          lastMaxId: oracleMaxId,
          needsTruncate: false,
          description: `Numeric ID delta sync on [${singleNumericPk}] > ${oracleMaxId} (APPEND new rows)`,
        };
      }
    }

    // 3. Estratégia para Tabelas Pequenas sem Data (Fast Reload)
    const rowCount = table.totalRows;
    if (rowCount <= migrationConfig.fastReloadThreshold) {
      return {
        strategy: 'FAST_RELOAD',
        pkColumns,
        needsTruncate: true,
        description: `Fast Reload (Truncate + Bulk Stream) for small table (${rowCount} rows <= ${migrationConfig.fastReloadThreshold})`,
      };
    }

    // 4. Estratégia para Tabelas com PK Composta / Alfanumérica sem Data
    if (pkColumns.length > 0) {
      return {
        strategy: 'FULL_MERGE',
        pkColumns,
        needsTruncate: false,
        description: `Full Merge Upsert (No date column found, syncing rows by PK [${pkColumns.join(', ')}])`,
      };
    }

    // 5. Fallback para Tabelas Grandes sem PK e sem Data: Fast Reload
    return {
      strategy: 'FAST_RELOAD',
      pkColumns: [],
      needsTruncate: true,
      description: `Fast Reload fallback (Table has no PK and no Date column)`,
    };
  }

  /**
   * Detect date/timestamp column for incremental tracking
   */
  private detectDateColumn(table: Table): string | undefined {
    const configuredNames = migrationConfig.dateColumns || [];

    // Prioridade 1: Buscar colunas que coincidem com os nomes de auditoria configurados
    for (const configured of configuredNames) {
      const found = table.columns.find((col) => col.name.toUpperCase() === configured);
      if (found) {
        return found.name;
      }
    }

    // Prioridade 2: Buscar colunas do tipo DATETIME/DATE que contenham termos típicos
    const dateTypes = ['DATETIME', 'DATETIME2', 'DATE', 'SMALLDATETIME', 'DATETIMEOFFSET'];
    const candidates = table.columns.filter((c) =>
      dateTypes.some((dt) => c.dataType.toUpperCase().startsWith(dt))
    );

    const typicalTerms = ['ALTERA', 'MODIF', 'UPDATE', 'CADAST', 'CREATE', 'HORA'];
    for (const col of candidates) {
      const upper = col.name.toUpperCase();
      if (typicalTerms.some((term) => upper.includes(term))) {
        return col.name;
      }
    }

    return undefined;
  }

  /**
   * Get single numeric primary key column if present
   */
  private getSingleNumericPk(table: Table): string | undefined {
    const pks = table.columns.filter((c) => c.isPrimaryKey);
    if (pks.length === 1) {
      const pk = pks[0];
      const numericTypes = ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'NUMERIC'];
      if (numericTypes.some((nt) => pk.dataType.toUpperCase().startsWith(nt))) {
        return pk.name;
      }
    }
    return undefined;
  }

  /**
   * Format date for SQL Server string literal: YYYY-MM-DD HH:mm:ss
   */
  private formatDateForSql(date: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const yyyy = date.getFullYear();
    const mm = pad(date.getMonth() + 1);
    const dd = pad(date.getDate());
    const hh = pad(date.getHours());
    const min = pad(date.getMinutes());
    const ss = pad(date.getSeconds());
    return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss}`;
  }
}

export const incrementalSyncService = new IncrementalSyncService();
