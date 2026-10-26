/**
 * Main Entry Point
 */

// Load environment variables
require('dotenv').config();

import { validateConfig } from './config/database.config';
import { validateMigrationConfig, getMigrationDescription } from './config/migration.config';
import { logger } from './utils/logger';
import { runMigration } from './migrations/data-conversion.migration';

/**
 * Main application entry point
 */
async function main(): Promise<void> {
  try {
    // Print banner
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║     MSSQL to Oracle Database Converter v1.0                ║');
    console.log('║     Data Migration Tool                                    ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');

    // Validate configurations
    logger.info('Validating configuration...', 'Main');

    if (!validateConfig()) {
      logger.error('Database configuration validation failed', undefined, 'Main');
      process.exit(1);
    }

    if (!validateMigrationConfig()) {
      logger.error('Migration configuration validation failed', undefined, 'Main');
      process.exit(1);
    }

    // Log migration description
    const migrationDesc = getMigrationDescription();
    logger.info(migrationDesc, 'Main');

    // Run migration
    logger.info('Starting migration process...', 'Main');
    await runMigration();

    logger.info('Migration completed successfully!', 'Main');
    process.exit(0);
  } catch (error) {
    logger.error('Application failed', error as Error, 'Main');
    process.exit(1);
  }
}

// Run application
main();
