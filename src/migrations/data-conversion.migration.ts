/**
 * Data Conversion Migration - Main migration executor
 */

import * as fs from 'fs';
import * as path from 'path';
import { migrationConfig, getCheckpointFilePath } from '../config/migration.config';
import { mssqlConnector } from '../connectors/mssql.connector';
import { oracleConnector } from '../connectors/oracle.connector';
import { schemaService } from '../services/schema.service';
import { dataTransformationService } from '../services/data-transformation.service';
import { dataInsertionService } from '../services/data-insertion.service';
import { incrementalSyncService, SyncPlan } from '../services/incremental-sync.service';
import { Conversion } from '../models/conversion.model';
import { ConversionCheckpoint } from '../models/conversion.model';
import { Table } from '../models/table.model';
import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';
import { TypeMapper } from '../utils/type-mapper';
import { ddlService } from '../services/ddl.service';

export class DataConversionMigration {
  private session: Conversion;
  private checkpointPath: string;
  private checkpointQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.session = new Conversion(uuidv4(), migrationConfig.mode, migrationConfig.targetTable);
    this.checkpointPath = getCheckpointFilePath();
    this.ensureCheckpointDirectory();
  }

  /**
   * Ensure checkpoint directory exists
   */
  private ensureCheckpointDirectory(): void {
    const dir = path.dirname(this.checkpointPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Migrate old timestamped checkpoint if the main checkpoint doesn't exist (only in non-full modes)
    if (migrationConfig.mode !== 'full' && !fs.existsSync(this.checkpointPath)) {
      try {
        const files = fs.readdirSync(dir);
        const checkpointFiles = files
          .filter(
            (file) =>
              file.startsWith('migration-') &&
              file.endsWith('-checkpoint.json') &&
              file !== 'migration-checkpoint.json'
          )
          .map((file) => ({
            name: file,
            path: path.join(dir, file),
            time: fs.statSync(path.join(dir, file)).mtime.getTime(),
          }));

        if (checkpointFiles.length > 0) {
          checkpointFiles.sort((a, b) => b.time - a.time);
          const latestFile = checkpointFiles[0].path;
          fs.copyFileSync(latestFile, this.checkpointPath);
          logger.info(
            `Migrated existing checkpoint file ${checkpointFiles[0].name} to active checkpoint`,
            'DataConversionMigration'
          );
        }
      } catch (error) {
        logger.warn('Failed to migrate existing checkpoint files', 'DataConversionMigration');
      }
    }
  }

  /**
   * Clean logs, fixes, and active checkpoints for a clean new full migration
   */
  private cleanMigrationArtifacts(): void {
    const dirsToClean = [
      path.resolve(process.cwd(), 'logs'),
      path.resolve(process.cwd(), 'log'),
      path.resolve(process.cwd(), 'fixes'),
    ];

    for (const dir of dirsToClean) {
      if (fs.existsSync(dir)) {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            const filePath = path.join(dir, file);
            try {
              if (fs.statSync(filePath).isDirectory()) {
                fs.rmSync(filePath, { recursive: true, force: true });
              } else {
                fs.unlinkSync(filePath);
              }
            } catch (_) {
              try {
                fs.writeFileSync(filePath, '');
              } catch (__) {}
            }
          }
        } catch (_) {}
      } else {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (_) {}
      }
    }

    // Ensure logs and fixes directories exist
    for (const dir of [path.resolve(process.cwd(), 'logs'), path.resolve(process.cwd(), 'fixes')]) {
      if (!fs.existsSync(dir)) {
        try {
          fs.mkdirSync(dir, { recursive: true });
        } catch (_) {}
      }
    }

    // Remove loose error log in project root if any
    const rootErrorLog = path.resolve(process.cwd(), 'errors.log');
    if (fs.existsSync(rootErrorLog)) {
      try {
        fs.unlinkSync(rootErrorLog);
      } catch (_) {
        try {
          fs.writeFileSync(rootErrorLog, '');
        } catch (__) {}
      }
    }

    // Reset active checkpoint
    if (fs.existsSync(this.checkpointPath)) {
      try {
        fs.unlinkSync(this.checkpointPath);
      } catch (_) {}
    }
  }

  /**
   * Execute migration based on mode
   */
  async execute(): Promise<void> {
    try {
      if (migrationConfig.mode === 'full') {
        this.cleanMigrationArtifacts();
        logger.clearLogs();
        logger.info('Cleaned logs and fixes folders - Starting fresh full migration', 'DataConversionMigration');
      }

      logger.info(`Starting data conversion migration - Mode: ${migrationConfig.mode}`, 'DataConversionMigration');
      this.session.start();

      // Connect to both databases
      await this.connectToDatabases();

      // Check if Oracle database is completely clean (0 user tables)
      const isClean = await ddlService.isOracleClean();
      if (isClean && migrationConfig.autoCreateTables) {
        logger.warn(
          'Oracle database is completely clean (0 tables found). Automatically generating and applying DDL from MSSQL...',
          'DataConversionMigration'
        );
        const targetTable = migrationConfig.mode === 'test' ? migrationConfig.targetTable : undefined;
        const tablesMeta = await ddlService.extractMetadata(targetTable);
        if (tablesMeta.length > 0) {
          const ddlResult = ddlService.generateOracleDDL(tablesMeta);
          ddlService.saveDDLToFile('./ddl/oracle_schema.sql', ddlResult.sqlScript);
          const applyResult = await ddlService.applyDDLToOracle(ddlResult, { filterExisting: false });
          logger.info(
            `Clean Oracle setup complete: created ${applyResult.tablesCreated} tables, ${applyResult.pksCreated} PKs, ${applyResult.fksCreated} FKs.`,
            'DataConversionMigration'
          );
        }
      }

      // Load or create checkpoint
      let checkpoint = await this.loadCheckpoint();

      // Get tables to process
      let tablesToProcess = await this.getTablesToProcess();

      // Only filter from checkpoint if in RESUME mode (or explicitly asked via --resume)
      const isResume = migrationConfig.mode === 'resume' || process.argv.includes('--resume');

      if (isResume && checkpoint) {
        logger.info(
          `Resume mode: filtering out previously completed tables (${checkpoint.completedTables?.length || 0})`,
          'DataConversionMigration'
        );
        tablesToProcess = this.filterTablesFromCheckpoint(tablesToProcess, checkpoint);
      } else if (migrationConfig.mode === 'full') {
        logger.info(
          `Full migration mode: starting clean migration for ALL ${tablesToProcess.length} tables`,
          'DataConversionMigration'
        );
        // Reset completedTables in checkpoint so this full run tracks all tables cleanly
        if (checkpoint) {
          checkpoint.completedTables = [];
        }
      }

      this.session.stats.totalTables = tablesToProcess.length;

      // If global constraints disabling is enabled (default true) and not in test mode,
      // disable all constraints and triggers across the whole schema upfront for maximum speed and zero deadlocks.
      if (migrationConfig.disableGlobalConstraints && migrationConfig.mode !== 'test') {
        logger.info('Disabling all constraints and triggers across Oracle schema...', 'DataConversionMigration');
        await oracleConnector.disableAllSchemaConstraints();
      }

      const concurrency = migrationConfig.mode === 'test' ? 1 : Math.max(1, migrationConfig.concurrency);
      logger.info(`Processing ${tablesToProcess.length} tables (concurrency: ${concurrency})`, 'DataConversionMigration');

      // Sort tables by row count descending so large tables start first in workers
      if (concurrency > 1) {
        tablesToProcess.sort((a, b) => b.totalRows - a.totalRows);
      }

      let currentIdx = 0;
      let hasError = false;
      let firstError: Error | null = null;

      const worker = async (_workerId: number): Promise<void> => {
        while (currentIdx < tablesToProcess.length && !hasError) {
          const index = currentIdx++;
          if (index >= tablesToProcess.length) break;
          const table = tablesToProcess[index];

          try {
            const syncPlan = await this.migrateTable(table, checkpoint);
            await this.saveCheckpoint(table, syncPlan);
          } catch (error) {
            logger.error(`Failed to migrate table ${table.name}`, error as Error, 'DataConversionMigration');
            table.markFailed();

            if (migrationConfig.mode === 'test') {
              hasError = true;
              firstError = error as Error;
              throw error; // Stop on test mode
            }
          }
        }
      };

      const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
      await Promise.all(workers);

      if (hasError && firstError) {
        throw firstError;
      }

      // Re-enable all constraints across schema with NOVALIDATE if global constraints were disabled
      if (migrationConfig.disableGlobalConstraints && migrationConfig.mode !== 'test') {
        logger.info('Re-enabling all constraints across Oracle schema with NOVALIDATE...', 'DataConversionMigration');
        await oracleConnector.enableAllSchemaConstraints();
      }

      // Disconnect and summarize
      await this.disconnectFromDatabases();
      this.session.complete();
      this.generateReport();
    } catch (error) {
      // Ensure constraints are re-enabled even on failure if global constraints were disabled
      if (migrationConfig.disableGlobalConstraints && migrationConfig.mode !== 'test') {
        try {
          await oracleConnector.enableAllSchemaConstraints();
        } catch (_) { }
      }
      logger.error('Migration failed', error as Error, 'DataConversionMigration');
      this.session.fail((error as Error).message);
      throw error;
    }
  }

  /**
   * Connect to both databases
   */
  private async connectToDatabases(): Promise<void> {
    logger.info('Connecting to databases...', 'DataConversionMigration');

    await mssqlConnector.connect();
    logger.info('Connected to MSSQL', 'DataConversionMigration');

    await oracleConnector.connect();
    logger.info('Connected to Oracle', 'DataConversionMigration');
  }

  /**
   * Disconnect from both databases
   */
  private async disconnectFromDatabases(): Promise<void> {
    logger.info('Disconnecting from databases...', 'DataConversionMigration');

    await mssqlConnector.disconnect();
    await oracleConnector.disconnect();

    logger.info('Disconnected from databases', 'DataConversionMigration');
  }

  /**
   * Get tables to process based on mode
   */
  private async getTablesToProcess(): Promise<Table[]> {
    if (migrationConfig.mode === 'test' && migrationConfig.targetTable) {
      logger.info(`Test mode: retrieving schema for table ${migrationConfig.targetTable}`, 'DataConversionMigration');
      const table = await schemaService.getTableSchema(migrationConfig.targetTable);
      return [table];
    }

    logger.info('Retrieving all tables from source database', 'DataConversionMigration');
    const tables = await schemaService.getSourceTables();
    return tables;
  }

  /**
   * Filter tables from checkpoint
   */
  private filterTablesFromCheckpoint(tables: Table[], checkpointData: any): Table[] {
    return tables.filter((table) => {
      const isCompleted = checkpointData.completedTables?.includes(table.name);
      return !isCompleted;
    });
  }

  private async migrateTable(table: Table, checkpointData?: any): Promise<SyncPlan | undefined> {
    logger.info(`Starting migration of table ${table.name} (${table.totalRows} rows)`, 'DataConversionMigration');

    table.status = 'in-progress';

    try {
      // Fetch columns and metadata that exist in the target Oracle table
      let oracleMeta = await oracleConnector.getTableColumnsMetadata(table.name);
      let oracleColumns = Array.from(oracleMeta.keys());

      if (oracleColumns.length === 0 && migrationConfig.autoCreateTables) {
        logger.info(
          `Target table ${table.name} does not exist in Oracle database. Auto-creating table structure from MSSQL...`,
          'DataConversionMigration'
        );
        try {
          const meta = await ddlService.extractMetadata(table.name);
          if (meta.length > 0) {
            const ddlResult = ddlService.generateOracleDDL(meta);
            await ddlService.applyDDLToOracle(ddlResult, { filterExisting: true });
            oracleMeta = await oracleConnector.getTableColumnsMetadata(table.name);
            oracleColumns = Array.from(oracleMeta.keys());
          }
        } catch (err) {
          logger.warn(
            `Could not auto-create table ${table.name} in Oracle: ${(err as Error).message}`,
            'DataConversionMigration'
          );
        }
      }

      if (oracleColumns.length === 0) {
        logger.warn(
          `Target table ${table.name} does not exist in Oracle database. Skipping migration for this table.`,
          'DataConversionMigration'
        );
        table.status = 'skipped';
        this.session.stats.skippedTables++;
        try {
          fs.appendFileSync(
            './logs/skipped-tables.log',
            `${new Date().toISOString()} - ${table.name} (not found in Oracle)\n`
          );
        } catch (_) {}
        return undefined;
      }

      if (oracleColumns.length > 0) {
        // Detect columns present in MSSQL but missing in Oracle
        const missingCols = table.columns.filter(
          (col) => !oracleColumns.includes(col.name.toUpperCase())
        );

        if (missingCols.length > 0) {
          if (migrationConfig.autoAddColumns) {
            logger.info(
              `Table ${table.name} has ${missingCols.length} columns in MSSQL missing in Oracle. Auto-adding them...`,
              'DataConversionMigration'
            );

            for (const col of missingCols) {
              const oracleDataType = TypeMapper.getMappedType(
                col.dataType,
                col.maxLength,
                col.precision,
                col.scale
              );

              const nullability = col.nullable ? '' : ' NOT NULL';
              const alterSql = `ALTER TABLE "${table.name.toUpperCase()}" ADD ("${col.name.toUpperCase()}" ${oracleDataType}${nullability})`;

              logger.info(`Adding column: ${col.name} (${oracleDataType}) to Oracle table ${table.name}`, 'DataConversionMigration');
              await oracleConnector.executeQuery(alterSql);
            }

            logger.info(`Successfully added missing columns to Oracle table ${table.name}`, 'DataConversionMigration');
          } else {
            logger.warn(
              `Table ${table.name} has ${missingCols.length} columns in MSSQL that are missing in Oracle. They will be ignored during migration. Check logs/missing-columns.log for details.`,
              'DataConversionMigration'
            );

            // Log missing columns to separate log file
            logger.logMissingColumns(
              table.name,
              missingCols.map((col) => ({ name: col.name, dataType: col.dataType }))
            );

            // Filter out the missing columns from the table definition
            table.columns = table.columns.filter((col) =>
              oracleColumns.includes(col.name.toUpperCase())
            );
          }
        }
      }

      // Determine synchronization strategy and plan
      let syncPlan: SyncPlan | undefined;
      const isIncremental = migrationConfig.mode === 'incremental' || migrationConfig.mode === 'delta';

      if (isIncremental) {
        syncPlan = await incrementalSyncService.planSync(table, checkpointData);
        logger.info(`[Sync Strategy: ${table.name}] ${syncPlan.description}`, 'DataConversionMigration');
      }

      const shouldClearData = isIncremental ? (syncPlan?.needsTruncate ?? false) : true;

      // Prepare table (Disable constraints and optionally truncate)
      await dataInsertionService.prepareTableForInsertion(table, shouldClearData);

      // Process data via high-speed TDS streaming (O(N) sequential scan, zero OFFSET/FETCH overhead)
      let processedRows = 0;
      let failedRows = 0;

      const columnNames = dataTransformationService.getTargetColumnNames(table);
      const useMerge = isIncremental && syncPlan && (syncPlan.strategy === 'DATE_DELTA' || syncPlan.strategy === 'FULL_MERGE') && syncPlan.pkColumns.length > 0;

      await mssqlConnector.streamTableRows(table.name, columnNames, {
        whereClause: syncPlan?.whereClause,
        batchSize: migrationConfig.batchSize,
        onBatch: async (batchRows: Record<string, any>[], batchNumber: number) => {
          if (batchRows.length === 0) return;

          // Transform and validate data, passing oracleMeta for NOT NULL sanitization
          const { valid, invalid } = await dataTransformationService.validateAndTransform(
            batchRows,
            table,
            oracleMeta
          );

          let insertedCount = 0;
          if (useMerge && syncPlan) {
            insertedCount = await dataInsertionService.mergeBatch(table.name, columnNames, syncPlan.pkColumns, valid);
          } else {
            insertedCount = await dataInsertionService.insertBatch(table.name, columnNames, valid);
          }

          const uninserted = valid.length - insertedCount;
          processedRows += insertedCount;
          failedRows += invalid + (uninserted > 0 ? uninserted : 0);

          // Update progress
          table.updateProgress(processedRows, failedRows);

          logger.info(
            `[Stream Batch ${batchNumber}] Loaded ${insertedCount} rows into ${table.name}. Total progress: ${processedRows} rows`,
            'DataConversionMigration'
          );
        },
      });

      // Finalize table (Re-enable constraints)
      await dataInsertionService.finalizeTableAfterInsertion(table);

      // Verify insertion
      const verified = await dataInsertionService.verifyInsertion(table, processedRows);

      table.markCompleted();

      if (failedRows > 0) {
        logger.warn(
          `Completed migration of table ${table.name} with ${failedRows} row(s) marked for post-migration adjustment. Processed: ${processedRows}, Failed/Pending: ${failedRows}, Verified: ${verified}. Check logs/pending-adjustments.json`,
          'DataConversionMigration'
        );
      } else {
        logger.info(
          `Completed migration of table ${table.name}. Processed: ${processedRows}, Failed: ${failedRows}, Verified: ${verified}`,
          'DataConversionMigration'
        );
      }

      this.session.stats.completedTables++;
      this.session.updateProgress(
        this.session.stats.totalTables,
        this.session.stats.completedTables,
        this.session.stats.totalRows + table.totalRows,
        this.session.stats.processedRows + processedRows,
        this.session.stats.failedRows + failedRows
      );

      return syncPlan;
    } catch (error) {
      table.markFailed();
      this.session.stats.failedTables++;
      throw error;
    }
  }

  /**
   * Save checkpoint (thread-safe queue)
   */
  private async saveCheckpoint(table: Table, syncPlan?: SyncPlan): Promise<void> {
    this.checkpointQueue = this.checkpointQueue
      .then(async () => {
        try {
          const checkpoint: ConversionCheckpoint = {
            tableId: table.name,
            tableName: table.name,
            lastProcessedId: table.lastProcessedId,
            processedRows: table.processedRows,
            failedRows: table.failedRows,
            batchNumber: Math.ceil(table.processedRows / migrationConfig.batchSize),
            timestamp: new Date(),
          };

          this.session.addCheckpoint(checkpoint);

          // Save to file
          let checkpointData: any = { completedTables: [], tables: {} };

          if (fs.existsSync(this.checkpointPath)) {
            try {
              const existing = fs.readFileSync(this.checkpointPath, 'utf-8');
              checkpointData = JSON.parse(existing);
            } catch (_) { }
          }

          if (!checkpointData.completedTables) checkpointData.completedTables = [];
          if (!checkpointData.tables) checkpointData.tables = {};

          if (!checkpointData.completedTables.includes(table.name)) {
            checkpointData.completedTables.push(table.name);
          }

          checkpointData.tables[table.name] = {
            lastSyncTimestamp: new Date().toISOString(),
            lastMaxId: syncPlan?.lastMaxId || null,
            strategy: syncPlan?.strategy || 'FULL',
            processedRows: table.processedRows,
            updatedAt: new Date().toISOString(),
          };

          const content = JSON.stringify(checkpointData, null, 2);
          fs.writeFileSync(this.checkpointPath, content);

          // Also save a timestamped backup
          try {
            const timestamp = new Date().toISOString().split('T')[0];
            const backupPath = `./checkpoints/migration-${timestamp}-checkpoint.json`;
            fs.writeFileSync(backupPath, content);
          } catch (backupError) {
            // Ignore backup writing errors, active checkpoint is the critical one
          }

          logger.debug(`Checkpoint saved for table ${table.name}`, 'DataConversionMigration');
        } catch (error) {
          logger.warn(`Failed to save checkpoint for table ${table.name}`, 'DataConversionMigration');
        }
      })
      .catch(() => {});

    await this.checkpointQueue;
  }

  /**
   * Load checkpoint
   */
  private async loadCheckpoint(): Promise<any> {
    try {
      if (migrationConfig.mode === 'full') {
        return null;
      }

      const isResumeMode = migrationConfig.mode === 'resume';
      if ((migrationConfig.autoResume || isResumeMode) && fs.existsSync(this.checkpointPath)) {
        const data = fs.readFileSync(this.checkpointPath, 'utf-8');
        const checkpoint = JSON.parse(data);

        logger.info(
          `Checkpoint loaded. Completed tables: ${checkpoint.completedTables?.length || 0}`,
          'DataConversionMigration'
        );

        return checkpoint;
      }
    } catch (error) {
      logger.warn('Failed to load checkpoint', 'DataConversionMigration');
    }

    return null;
  }

  /**
   * Generate migration report
   */
  private generateReport(): void {
    const report = `
╔════════════════════════════════════════════════════════════════╗
║              MIGRATION COMPLETION REPORT                       ║
╠════════════════════════════════════════════════════════════════╣
║ Migration ID:      ${this.session.id}
║ Mode:              ${this.session.mode}
║ Start Time:        ${this.session.startTime.toISOString()}
║ End Time:          ${this.session.endTime?.toISOString()}
║ Duration:          ${this.getDurationString()}
║
║ Tables:
║   Total:           ${this.session.stats.totalTables}
║   Completed:       ${this.session.stats.completedTables}
║   Skipped:         ${this.session.stats.skippedTables}
║   Failed:          ${this.session.stats.failedTables}
║
║ Rows:
║   Total:           ${this.session.stats.totalRows}
║   Processed:       ${this.session.stats.processedRows}
║   Successful:      ${this.session.stats.successfulRows}
║   Failed:          ${this.session.stats.failedRows}
║   Success Rate:    ${this.session.getSuccessRate()}%
║
║ Performance:
║   Rows/Second:     ${Math.round(this.session.stats.averageRowsPerSecond || 0)}
║   Status:          ${this.session.status.toUpperCase()}
╚════════════════════════════════════════════════════════════════╝
    `;

    logger.info(report, 'DataConversionMigration');

    // Save report to file
    try {
      const reportPath = `./logs/migration-report-${new Date().toISOString().split('T')[0]}.txt`;
      const dir = path.dirname(reportPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(reportPath, report);
    } catch (_) {}
  }

  /**
   * Get duration string
   */
  private getDurationString(): string {
    if (!this.session.endTime) return 'N/A';

    const duration = this.session.endTime.getTime() - this.session.startTime.getTime();
    const seconds = Math.floor((duration / 1000) % 60);
    const minutes = Math.floor((duration / (1000 * 60)) % 60);
    const hours = Math.floor((duration / (1000 * 60 * 60)) % 24);

    return `${hours}h ${minutes}m ${seconds}s`;
  }
}

export async function runMigration(): Promise<void> {
  const migration = new DataConversionMigration();
  await migration.execute();
}
