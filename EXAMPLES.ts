/**
 * Example Usage - Data Conversion Migration
 * 
 * This file demonstrates how to use the migration tool
 * in different scenarios
 */

import { runMigration } from './src/migrations/data-conversion.migration';

/**
 * Example 1: Full Migration
 * 
 * Set environment variable: MIGRATION_MODE=full
 * 
 * This will migrate all tables from MSSQL to Oracle
 */
async function example1_fullMigration() {
  process.env.MIGRATION_MODE = 'full';
  console.log('Running full database migration...');
  await runMigration();
}

/**
 * Example 2: Test Single Table
 * 
 * Set environment variables:
 * - MIGRATION_MODE=test
 * - TARGET_TABLE=YourTableName
 * 
 * This will migrate only the specified table for testing
 */
async function example2_testMode() {
  process.env.MIGRATION_MODE = 'test';
  process.env.TARGET_TABLE = 'users'; // Change to your table name
  console.log('Running test migration for single table...');
  await runMigration();
}

/**
 * Example 3: Resume from Checkpoint
 * 
 * Set environment variable: MIGRATION_MODE=resume
 * 
 * This will resume from the last completed table
 */
async function example3_resumeMigration() {
  process.env.MIGRATION_MODE = 'resume';
  console.log('Resuming migration from checkpoint...');
  await runMigration();
}

/**
 * Example 4: Custom Configuration
 * 
 * Configure different settings for your specific needs
 */
async function example4_customConfig() {
  process.env.MIGRATION_MODE = 'test';
  process.env.TARGET_TABLE = 'products';
  process.env.BATCH_SIZE = '10000'; // Larger batches for performance
  process.env.DISABLE_CONSTRAINTS = 'true';
  process.env.DISABLE_INDEXES = 'true';
  process.env.MAX_RETRIES = '5'; // More retries for unstable network
  console.log('Running custom configured migration...');
  await runMigration();
}

// Choose which example to run
// Uncomment the example you want to test
// example1_fullMigration().catch(console.error);
// example2_testMode().catch(console.error);
// example3_resumeMigration().catch(console.error);
// example4_customConfig().catch(console.error);
