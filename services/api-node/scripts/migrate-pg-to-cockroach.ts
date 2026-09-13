/**
 * PropertyTour360 Database Data Migrator: PostgreSQL -> CockroachDB
 * 
 * Transfers all table data from an existing PostgreSQL database into CockroachDB
 * in exact topological dependency order to ensure foreign key integrity.
 * 
 * Usage:
 *   npx tsx scripts/migrate-pg-to-cockroach.ts [options]
 * 
 * Options:
 *   --source-url <url>    Source PostgreSQL connection string (defaults to OLD_DATABASE_URL or fallback)
 *   --target-url <url>    Target CockroachDB connection string (defaults to DATABASE_URL)
 *   --batch-size <num>    Number of rows per insert batch (default: 200)
 *   --truncate            Truncate target tables before migration (in reverse dependency order)
 *   --verify-only         Skip migration and only compare row counts between source and target
 *   --dry-run             Read and report row counts from source without writing to target
 *   --help                Show this help message
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const { Pool } = pg;

// 44 Models in strict topological dependency order
export const TABLES_IN_DEPENDENCY_ORDER: string[] = [
  // 1. Independent core entities
  'Organization',
  'User',
  'OtpCode',
  'Property',
  'CatalogueAsset',
  'Material',
  'Product',

  // 2. Depend on level 1
  'ProductVariant',       // -> Product
  'Unit',                 // -> Property

  // 3. Depend on Unit / User
  'CaptureSession',       // -> Unit, User
  'DesignProject',        // -> Unit, CaptureSession
  'ProgressProject',      // -> Unit, User

  // 4. Spatial hierarchy
  'SpatialFloor',         // -> ProgressProject
  'SpatialRoom',          // -> ProgressProject, SpatialFloor
  'Room',                 // -> CaptureSession, SpatialRoom

  // 5. Assets & Captures
  'Asset',                // -> CaptureSession, Room, SpatialRoom
  'CaptureConnection',    // -> CaptureSession, Room
  'Tour',                 // -> Unit, CaptureSession

  // 6. Child workflows & uploads
  'Hotspot',              // -> Tour, Room
  'Lead',                 // -> Tour
  'ResumableUpload',      // -> CaptureSession, Room, Asset
  'ProcessingJob',        // -> CaptureSession, Asset, DesignProject
  'DesignVersion',        // -> DesignProject, User
  'DesignComment',        // -> DesignProject, User
  'DesignApproval',       // -> DesignProject, User
  'AuditEvent',           // -> User
  'CapturePackage',       // -> CaptureSession
  'Measurement',          // -> Room
  'GeometryProposal',     // -> Room
  'ModelReview',          // -> DesignProject, User
  'DesignOption',         // -> DesignProject
  'ExportRecord',         // -> DesignProject
  'ClientShareLink',      // -> DesignProject

  // 7. Chunks & parts
  'ResumableUploadPart',  // -> ResumableUpload

  // 8. Progress intelligence & spatial captures
  'CaptureSnapshot',          // -> ProgressProject, SpatialRoom, SpatialFloor, CaptureSession, Asset, DesignProject, User
  'CaptureRegistration',      // -> ProgressProject, CaptureSnapshot
  'DesignRealityAlignment',  // -> ProgressProject, CaptureSnapshot, DesignProject
  'DesignRealityEvaluation', // -> ProgressProject, CaptureSnapshot, DesignProject
  'ProgressAnalysisRun',     // -> ProgressProject, CaptureSnapshot, DesignProject
  'ProjectIssue',            // -> ProgressProject, CaptureSnapshot, DesignProject, SpatialFloor, SpatialRoom, User
  'ProjectReport',           // -> ProgressProject, CaptureSnapshot, User

  // 9. Issues & Decisions
  'IssueEvent',              // -> ProjectIssue, User
  'AiObservation',           // -> ProgressProject, CaptureSnapshot, SpatialFloor, SpatialRoom, Asset, ProjectIssue
  'ObservationDecision'      // -> AiObservation, User
];

function loadEnv() {
  const candidates = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(process.cwd(), '../.env')
  ];
  for (const envPath of candidates) {
    if (existsSync(envPath)) {
      const content = readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!process.env[key]) {
            process.env[key] = val;
          }
        }
      }
      break;
    }
  }
}

function parseArgs() {
  loadEnv();
  const args = process.argv.slice(2);
  const options = {
    sourceUrl: process.env.OLD_DATABASE_URL || '',
    targetUrl: process.env.DATABASE_URL || '',
    batchSize: 200,
    truncate: false,
    verifyOnly: false,
    dryRun: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--source-url' && i + 1 < args.length) {
      options.sourceUrl = args[++i];
    } else if (arg === '--target-url' && i + 1 < args.length) {
      options.targetUrl = args[++i];
    } else if (arg === '--batch-size' && i + 1 < args.length) {
      options.batchSize = parseInt(args[++i], 10) || 200;
    } else if (arg === '--truncate') {
      options.truncate = true;
    } else if (arg === '--verify-only') {
      options.verifyOnly = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    }
  }

  // When running on the host machine outside Docker, automatically map internal Docker hostnames to localhost
  if (options.targetUrl && options.targetUrl.includes('@cockroach:')) {
    options.targetUrl = options.targetUrl.replace('@cockroach:', '@localhost:');
  }
  if (options.sourceUrl && options.sourceUrl.includes('@postgres:')) {
    options.sourceUrl = options.sourceUrl.replace('@postgres:', '@localhost:');
  }

  return options;
}

function printHelp() {
  console.log(`
PropertyTour360 Database Migrator (PostgreSQL -> CockroachDB)
=============================================================
Usage:
  npx tsx scripts/migrate-pg-to-cockroach.ts [options]

Options:
  --source-url <url>    Source PostgreSQL connection string
                        (Default: process.env.OLD_DATABASE_URL)
  --target-url <url>    Target CockroachDB connection string
                        (Default: process.env.DATABASE_URL)
  --batch-size <num>    Rows per insert batch (default: 200)
  --truncate            Truncate target tables before migration (in reverse FK order)
  --verify-only         Compare row counts between source and target without writing
  --dry-run             Read and count rows from source without inserting into target
  -h, --help            Show this help dialog

Examples:
  # Check data counts without modifying anything:
  npx tsx scripts/migrate-pg-to-cockroach.ts --verify-only

  # Run migration using environment variables from .env:
  npx tsx scripts/migrate-pg-to-cockroach.ts

  # Migrate with explicit URLs and clean target:
  npx tsx scripts/migrate-pg-to-cockroach.ts \\
    --source-url "postgresql://propertytour:password@localhost:5432/propertytour360?sslmode=disable" \\
    --target-url "postgresql://root@localhost:26257/propertytour360?sslmode=disable" \\
    --truncate
`);
}

async function getExistingTables(pool: pg.Pool): Promise<Set<string>> {
  const result = await pool.query(`
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
  `);
  return new Set(result.rows.map((r: { table_name: string }) => r.table_name));
}

async function getTableColumns(pool: pg.Pool, tableName: string): Promise<string[]> {
  const result = await pool.query(`
    SELECT column_name
    FROM information_schema.columns 
    WHERE table_schema = 'public' 
      AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  return result.rows.map((r: { column_name: string }) => r.column_name);
}

async function getTableRowCount(pool: pg.Pool, tableName: string): Promise<number> {
  try {
    const result = await pool.query(`SELECT COUNT(*)::text as count FROM "${tableName}"`);
    return parseInt(result.rows[0].count, 10);
  } catch (err: any) {
    return -1;
  }
}

async function run() {
  const options = parseArgs();

  if (options.help) {
    printHelp();
    return;
  }

  console.log('\n======================================================');
  console.log('   PropertyTour360 Database Migrator (PG -> CockroachDB)');
  console.log('======================================================\n');

  if (!options.sourceUrl) {
    console.error('❌ Error: Source PostgreSQL URL is missing.');
    console.error('   Please provide --source-url or define OLD_DATABASE_URL in .env');
    console.error('   Example: --source-url postgresql://propertytour:password@localhost:5432/propertytour360?sslmode=disable\n');
    process.exit(1);
  }

  if (!options.targetUrl) {
    console.error('❌ Error: Target CockroachDB URL is missing.');
    console.error('   Please provide --target-url or define DATABASE_URL in .env');
    console.error('   Example: --target-url postgresql://root@localhost:26257/propertytour360?sslmode=disable\n');
    process.exit(1);
  }

  console.log(`Source (PostgreSQL)  : ${options.sourceUrl.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Target (CockroachDB) : ${options.targetUrl.replace(/:[^:@]+@/, ':****@')}`);
  console.log(`Batch Size           : ${options.batchSize}`);
  console.log(`Truncate Target First: ${options.truncate ? 'YES' : 'NO'}`);
  console.log(`Mode                 : ${options.verifyOnly ? 'VERIFY ONLY' : options.dryRun ? 'DRY RUN' : 'FULL MIGRATE'}\n`);

  const sourcePool = new Pool({
    connectionString: options.sourceUrl,
    connectionTimeoutMillis: 10000
  });

  const targetPool = new Pool({
    connectionString: options.targetUrl,
    connectionTimeoutMillis: 10000
  });

  try {
    // 1. Pre-flight connectivity check
    process.stdout.write('Checking connection to source PostgreSQL... ');
    try {
      await sourcePool.query('SELECT 1');
      console.log('CONNECTED ✓');
    } catch (err: any) {
      console.log('FAILED ❌');
      console.error(`\nCould not connect to PostgreSQL source database:\n${err.message}`);
      console.error('\nPlease ensure PostgreSQL is running and accessible at the specified URL.\n');
      process.exit(1);
    }

    process.stdout.write('Checking connection to target CockroachDB... ');
    try {
      await targetPool.query('SELECT 1');
      console.log('CONNECTED ✓\n');
    } catch (err: any) {
      console.log('FAILED ❌');
      console.error(`\nCould not connect to CockroachDB target database:\n${err.message}`);
      console.error('\nPlease ensure CockroachDB is running and accessible at the specified URL.');
      console.error('Tip: You can start CockroachDB via: docker compose up -d cockroach cockroach-init\n');
      process.exit(1);
    }

    // 2. Verify target tables exist
    const sourceTables = await getExistingTables(sourcePool);
    const targetTables = await getExistingTables(targetPool);

    console.log(`Found ${sourceTables.size} tables in source PostgreSQL.`);
    console.log(`Found ${targetTables.size} tables in target CockroachDB.\n`);

    if (targetTables.size === 0 && !options.verifyOnly) {
      console.warn('⚠️ Warning: Target CockroachDB has 0 tables.');
      console.warn('   Please ensure you have initialized the CockroachDB schema first:');
      console.warn('   Run: npx prisma db push (in services/api-node)\n');
    }

    // If verify-only mode requested
    if (options.verifyOnly) {
      await printVerificationAudit(sourcePool, targetPool);
      return;
    }

    // 3. Truncate target tables if requested
    if (options.truncate && !options.dryRun) {
      console.log('🧹 Truncating target tables in reverse dependency order...');
      const reverseTables = [...TABLES_IN_DEPENDENCY_ORDER].reverse();
      for (const table of reverseTables) {
        if (targetTables.has(table)) {
          try {
            await targetPool.query(`TRUNCATE TABLE "${table}" CASCADE`);
            console.log(`   ✓ Truncated "${table}"`);
          } catch (tErr: any) {
            console.warn(`   ⚠️ Could not truncate "${table}": ${tErr.message}`);
          }
        }
      }
      console.log('Target tables truncated successfully.\n');
    }

    // 4. Execute migration in topological dependency order
    console.log('🚀 Starting Data Migration...');
    console.log('------------------------------------------------------');

    let totalMigratedRows = 0;

    for (const tableName of TABLES_IN_DEPENDENCY_ORDER) {
      if (!sourceTables.has(tableName)) {
        continue;
      }

      const totalRows = await getTableRowCount(sourcePool, tableName);
      if (totalRows === 0) {
        console.log(`[ ] ${tableName.padEnd(28)} : 0 rows (empty, skipped)`);
        continue;
      }

      if (options.dryRun) {
        console.log(`[DRY-RUN] ${tableName.padEnd(22)} : ${totalRows} rows to migrate`);
        totalMigratedRows += totalRows;
        continue;
      }

      if (!targetTables.has(tableName)) {
        console.error(`❌ Error: Target table "${tableName}" does not exist in CockroachDB!`);
        console.error('   Please run: npx prisma db push');
        continue;
      }

      const columns = await getTableColumns(sourcePool, tableName);
      if (columns.length === 0) {
        console.warn(`⚠️ Warning: No columns found for table "${tableName}"`);
        continue;
      }

      process.stdout.write(`[➜] Migrating ${tableName.padEnd(24)} (${totalRows} rows)... `);

      const quotedCols = columns.map(c => `"${c}"`).join(', ');
      let offset = 0;
      let insertedCount = 0;

      while (offset < totalRows) {
        const fetchQuery = `
          SELECT * FROM "${tableName}" 
          ORDER BY "id" 
          LIMIT ${options.batchSize} OFFSET ${offset}
        `;
        const res = await sourcePool.query(fetchQuery);
        if (res.rows.length === 0) break;

        // Build parameterized batch INSERT
        const rowValues: any[] = [];
        const valuePlaceholders: string[] = [];

        for (let r = 0; r < res.rows.length; r++) {
          const row = res.rows[r];
          const placeholders: string[] = [];

          for (let c = 0; c < columns.length; c++) {
            const colName = columns[c];
            let val = row[colName];

            // Normalize JSON / Objects / BigInt
            if (val !== null && typeof val === 'object' && !(val instanceof Date) && !Buffer.isBuffer(val)) {
              val = JSON.stringify(val);
            }

            rowValues.push(val);
            placeholders.push(`$${rowValues.length}`);
          }

          valuePlaceholders.push(`(${placeholders.join(', ')})`);
        }

        const insertQuery = `
          INSERT INTO "${tableName}" (${quotedCols})
          VALUES ${valuePlaceholders.join(', ')}
          ON CONFLICT ("id") DO NOTHING
        `;

        await targetPool.query(insertQuery, rowValues);
        insertedCount += res.rows.length;
        offset += options.batchSize;
      }

      console.log(`DONE ✓ (${insertedCount} inserted)`);
      totalMigratedRows += insertedCount;
    }

    console.log('------------------------------------------------------');
    console.log(`🎉 Migration Completed! Total rows migrated: ${totalMigratedRows}\n`);

    // 5. Run post-migration verification audit
    await printVerificationAudit(sourcePool, targetPool);

  } finally {
    await sourcePool.end().catch(() => {});
    await targetPool.end().catch(() => {});
  }
}

async function printVerificationAudit(sourcePool: pg.Pool, targetPool: pg.Pool) {
  console.log('\n======================================================');
  console.log('           Database Row Count Verification Audit       ');
  console.log('======================================================');
  console.log(
    'Table Name'.padEnd(28) + 
    'PostgreSQL'.padStart(12) + 
    'CockroachDB'.padStart(14) + 
    'Status'.padStart(10)
  );
  console.log('-'.repeat(64));

  let totalPg = 0;
  let totalCr = 0;
  let matches = 0;
  let mismatches = 0;

  for (const tableName of TABLES_IN_DEPENDENCY_ORDER) {
    const pgCount = await getTableRowCount(sourcePool, tableName);
    const crCount = await getTableRowCount(targetPool, tableName);

    if (pgCount < 0 && crCount < 0) continue;

    const pgStr = pgCount >= 0 ? pgCount.toString() : 'N/A';
    const crStr = crCount >= 0 ? crCount.toString() : 'N/A';

    let status = 'MATCH ✓';
    if (pgCount !== crCount) {
      status = 'MISMATCH ❌';
      mismatches++;
    } else {
      matches++;
    }

    if (pgCount > 0 || crCount > 0) {
      console.log(
        tableName.padEnd(28) + 
        pgStr.padStart(12) + 
        crStr.padStart(14) + 
        status.padStart(10)
      );
    }

    if (pgCount > 0) totalPg += pgCount;
    if (crCount > 0) totalCr += crCount;
  }

  console.log('-'.repeat(64));
  console.log(
    'TOTAL ROWS'.padEnd(28) + 
    totalPg.toString().padStart(12) + 
    totalCr.toString().padStart(14) + 
    (mismatches === 0 ? 'ALL MATCH ✓' : `${mismatches} DIFFS ⚠️`).padStart(10)
  );
  console.log('======================================================\n');
}

run().catch((err) => {
  console.error('Fatal migration error:', err);
  process.exit(1);
});
