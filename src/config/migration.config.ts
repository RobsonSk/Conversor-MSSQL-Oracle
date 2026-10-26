/**
 * Migration Configuration
 */

require('dotenv').config();

import { oracleConfig } from './database.config';

export type MigrationMode = 'full' | 'test' | 'resume' | 'incremental' | 'delta';

export interface MigrationConfig {
  mode: MigrationMode;
  targetTable?: string;
  batchSize: number;
  maxRetries: number;
  disableConstraints: boolean;
  disableGlobalConstraints: boolean;
  disableIndexes: boolean;
  autoResume: boolean;
  validateDataTypes: boolean;
  logErrors: boolean;
  errorLogTable: string;
  concurrency: number;
  autoAddColumns: boolean;
  useTruncate: boolean;
  dateColumns: string[];
  fastReloadThreshold: number;
  incrementalLookbackMinutes: number;
  incrementalCutoff?: string;
}

function getArgValue(argName: string): string | undefined {
  const args = process.argv;
  const eqPrefix = `--${argName}=`;

  // Search backwards so user-supplied CLI arguments override earlier defaults
  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i].startsWith(eqPrefix)) {
      const val = args[i].substring(eqPrefix.length).trim();
      if (val && val !== 'TABLE_NAME') {
        return val;
      }
    }
    if (args[i] === `--${argName}` && i + 1 < args.length) {
      const val = args[i + 1].trim();
      if (val && val !== 'TABLE_NAME') {
        return val;
      }
    }
  }
  return undefined;
}

const cliMode = getArgValue('mode') as MigrationMode | undefined;
const cliTable = getArgValue('table');
const cliSince = getArgValue('since') || getArgValue('period') || getArgValue('cutoff');
const cliConcurrency = getArgValue('concurrency');
const cliBatchSize = getArgValue('batch-size') || getArgValue('batchSize');

const defaultDateColumns = [
  'DATA_ALTERACAO',
  'DT_ALTERACAO',
  'DATA_MODIFICACAO',
  'DT_MODIFICACAO',
  'UPDATED_AT',
  'DATA_CADASTRO',
  'DT_CADASTRO',
  'CREATED_AT',
  'DATA_ATUALIZACAO',
  'DT_ATUALIZACAO',
  'DAT_ALTERACAO',
  'DAT_CADASTRO',
  'DATA_HORA',
  'DTHR_ALTERACAO',
  'DAT_ULT_ATU',
  'DAT_ULTIMA_ALTERACAO'
];

const rawEnvTable = process.env.TARGET_TABLE?.trim();
const resolvedTargetTable =
  cliTable || (rawEnvTable && rawEnvTable !== 'TABLE_NAME' ? rawEnvTable : undefined);

export const migrationConfig: MigrationConfig = {
  mode: cliMode || (process.env.MIGRATION_MODE as MigrationMode) || 'full',
  targetTable: resolvedTargetTable,
  batchSize: parseInt(cliBatchSize || process.env.BATCH_SIZE || '25000', 10),
  maxRetries: parseInt(process.env.MAX_RETRIES || '3', 10),
  disableConstraints: process.env.DISABLE_CONSTRAINTS !== 'false',
  disableGlobalConstraints: process.env.DISABLE_GLOBAL_CONSTRAINTS !== 'false',
  disableIndexes: process.env.DISABLE_INDEXES !== 'false',
  autoResume: process.env.AUTO_RESUME === 'true',
  validateDataTypes: process.env.VALIDATE_DATA_TYPES === 'true',
  logErrors: process.env.LOG_ERRORS === 'true',
  errorLogTable: 'migration_errors',
  concurrency: parseInt(cliConcurrency || process.env.CONCURRENCY || '4', 10),
  autoAddColumns: process.env.AUTO_ADD_COLUMNS !== 'false',
  useTruncate: process.env.USE_TRUNCATE !== 'false',
  dateColumns: process.env.DATE_COLUMNS
    ? process.env.DATE_COLUMNS.split(',').map((c) => c.trim().toUpperCase())
    : defaultDateColumns,
  fastReloadThreshold: parseInt(process.env.FAST_RELOAD_THRESHOLD || '50000', 10),
  incrementalLookbackMinutes: parseInt(process.env.INCREMENTAL_LOOKBACK_MINUTES || '30', 10),
  incrementalCutoff: cliSince || process.env.INCREMENTAL_CUTOFF || process.env.INCREMENTAL_START_DATE || undefined,
};

/**
 * Validate migration configuration
 */
export function validateMigrationConfig(): boolean {
  if (
    migrationConfig.mode === 'test' &&
    (!migrationConfig.targetTable || migrationConfig.targetTable === 'TABLE_NAME')
  ) {
    console.error(
      'ERRO: O modo teste requer o nome de uma tabela válida. Exemplo: npm run migrate:test -- --table=GER_REVENDA ou TARGET_TABLE=GER_REVENDA no .env'
    );
    return false;
  }

  if (migrationConfig.batchSize < 100) {
    console.warn('WARNING: Batch size is very small (< 100), consider increasing for better performance');
  }

  if (migrationConfig.batchSize > 100000) {
    console.warn('WARNING: Batch size is very large (> 100000), consider decreasing to avoid memory issues');
  }

  if (migrationConfig.concurrency < 1) {
    console.error('ERROR: Concurrency must be a positive integer >= 1');
    return false;
  }

  if (migrationConfig.concurrency > oracleConfig.pool.max) {
    console.warn(
      `WARNING: Concurrency (${migrationConfig.concurrency}) is higher than Oracle connection pool max size (${oracleConfig.pool.max}). Some tasks might block waiting for connections.`
    );
  }

  return true;
}

/**
 * Get migration description
 */
export function getMigrationDescription(): string {
  switch (migrationConfig.mode) {
    case 'full':
      return 'Full database migration (High-Performance Streaming Bulk) - all tables will be migrated';
    case 'incremental':
    case 'delta':
      return 'Incremental/Delta migration - only changes and new records will be synchronized';
    case 'test':
      return `Test migration - only table '${migrationConfig.targetTable}' will be migrated`;
    case 'resume':
      return 'Resuming from last checkpoint';
    default:
      return 'Unknown migration mode';
  }
}

/**
 * Get checkpoint file path
 */
export function getCheckpointFilePath(): string {
  return `./checkpoints/migration-checkpoint.json`;
}

