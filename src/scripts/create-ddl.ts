/**
 * CLI Script: Create Oracle DDL from MSSQL and optionally apply to Oracle
 * 
 * Usage:
 *   npm run migrate:create-ddl
 *   npm run migrate:create-ddl -- --apply
 *   npm run migrate:create-ddl -- --table=GER_REVENDA
 *   docker compose run --rm converter npm run migrate:create-ddl
 *   docker compose run --rm converter npm run migrate:create-ddl -- --apply
 */

require('dotenv').config();

import { mssqlConnector } from '../connectors/mssql.connector';
import { oracleConnector } from '../connectors/oracle.connector';
import { ddlService } from '../services/ddl.service';
import { logger } from '../utils/logger';

function getArgValue(argName: string): string | undefined {
  const args = process.argv;
  const eqPrefix = `--${argName}=`;

  for (let i = args.length - 1; i >= 0; i--) {
    if (args[i].startsWith(eqPrefix)) {
      const val = args[i].substring(eqPrefix.length).trim();
      if (val && val !== 'TABLE_NAME') return val;
    }
    if (args[i] === `--${argName}` && i + 1 < args.length) {
      const val = args[i + 1].trim();
      if (val && val !== 'TABLE_NAME') return val;
    }
  }
  return undefined;
}

const hasFlag = (flagName: string): boolean => {
  return process.argv.includes(`--${flagName}`);
};

async function run(): Promise<void> {
  const targetTable = getArgValue('table') || (process.env.TARGET_TABLE !== 'TABLE_NAME' ? process.env.TARGET_TABLE : undefined);
  const explicitApply = hasFlag('apply') || process.env.APPLY_DDL === 'true';
  const outputFile = getArgValue('file') || './ddl/oracle_schema.sql';

  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║     MSSQL to Oracle Database Converter v1.0                ║');
  console.log('║     DDL Schema Generator & Setup Tool                      ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  try {
    // 1. Connect to both databases
    logger.info('Connecting to MSSQL and Oracle...', 'CreateDDL');
    await mssqlConnector.connect();
    await oracleConnector.connect();

    // 2. Extract DDL metadata from MSSQL
    logger.info(
      targetTable ? `Extracting schema for table ${targetTable}...` : 'Extracting schema for all tables...',
      'CreateDDL'
    );
    const tablesMeta = await ddlService.extractMetadata(targetTable);

    if (tablesMeta.length === 0) {
      logger.warn('No tables found in MSSQL matching criteria.', 'CreateDDL');
      process.exit(0);
    }

    // 3. Generate Oracle DDL
    logger.info(`Generating Oracle DDL for ${tablesMeta.length} table(s)...`, 'CreateDDL');
    const ddlResult = ddlService.generateOracleDDL(tablesMeta);

    // 4. Save DDL to file
    const savedPath = ddlService.saveDDLToFile(outputFile, ddlResult.sqlScript);
    logger.info(`DDL script written to: ${savedPath}`, 'CreateDDL');

    // 5. Check Oracle clean status and determine if applying
    const isClean = await ddlService.isOracleClean();
    const shouldApply = explicitApply || isClean;

    if (isClean) {
      logger.info(
        'Oracle database is completely clean (0 tables found). Automatically applying DDL...',
        'CreateDDL'
      );
    } else if (explicitApply) {
      logger.info('Flag --apply detected. Applying missing tables, PKs and FKs to Oracle...', 'CreateDDL');
    } else {
      const existingTables = await oracleConnector.getAllTableNames();
      console.log('\n------------------------------------------------------------');
      console.log(`ℹ️  Oracle database already has ${existingTables.length} tables.`);
      console.log(`📄 DDL script generated successfully at: ${savedPath}`);
      console.log('💡 To create missing tables, PKs and FKs directly in Oracle, run:');
      console.log('   npm run migrate:create-ddl -- --apply');
      console.log('   (ou via Docker: docker compose run --rm converter npm run migrate:create-ddl -- --apply)');
      console.log('------------------------------------------------------------\n');
    }

    if (shouldApply) {
      const applyResult = await ddlService.applyDDLToOracle(ddlResult, { filterExisting: true });

      console.log('\n╔═══════════════════════════════════════════════════════════╗');
      console.log('║                   DDL EXECUTION SUMMARY                   ║');
      console.log('╠═══════════════════════════════════════════════════════════╣');
      console.log(`║ Tables Created:       ${String(applyResult.tablesCreated).padEnd(44)}║`);
      console.log(`║ Primary Keys Created: ${String(applyResult.pksCreated).padEnd(44)}║`);
      console.log(`║ Unique Keys Created:  ${String(applyResult.uqsCreated).padEnd(44)}║`);
      console.log(`║ Foreign Keys Created: ${String(applyResult.fksCreated).padEnd(44)}║`);
      console.log(`║ Errors:               ${String(applyResult.errors.length).padEnd(44)}║`);
      console.log('╚═══════════════════════════════════════════════════════════╝\n');

      if (applyResult.errors.length > 0) {
        logger.warn(
          `There were ${applyResult.errors.length} warnings/errors during DDL execution. Check logs for details.`,
          'CreateDDL'
        );
      }
    }

    await mssqlConnector.disconnect();
    await oracleConnector.disconnect();
    logger.info('DDL process finished successfully!', 'CreateDDL');
    process.exit(0);
  } catch (error) {
    logger.error('Failed to create/apply DDL', error as Error, 'CreateDDL');
    try {
      await mssqlConnector.disconnect();
      await oracleConnector.disconnect();
    } catch (_) {}
    process.exit(1);
  }
}

run();
