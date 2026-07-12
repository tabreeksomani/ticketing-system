// scripts/lint-migrations.js
// Static analysis linter to prevent destructive or non-backward-compatible database changes

const fs = require('fs');
const path = require('path');

const PROHIBITED_OPERATIONS = [
  {
    regex: /\bDROP\s+TABLE\b/i,
    message: "DROP TABLE is prohibited to prevent destructive data loss."
  },
  {
    regex: /\bDROP\s+COLUMN\b/i,
    message: "DROP COLUMN is prohibited. Columns should be deprecated in code first, and dropped later during scheduled maintenance."
  },
  {
    regex: /\bALTER\s+TABLE\s+.*\s+DROP\s+/i,
    message: "Dropping constraints or columns via ALTER TABLE ... DROP is prohibited without verification."
  },
  {
    regex: /\bRENAME\s+COLUMN\b/i,
    message: "RENAME COLUMN is prohibited. Renaming columns breaks backward compatibility for older, active application versions."
  },
  {
    regex: /\bRENAME\s+TO\b/i,
    message: "RENAME TO (table rename) is prohibited. Renaming tables breaks active queries in the running codebase."
  },
  {
    regex: /\bALTER\s+COLUMN\s+.*\s+TYPE\b/i,
    message: "Changing column data types is prohibited. Create a new column with the new type instead to avoid type mismatch crashes."
  },
  {
    regex: /\bALTER\s+COLUMN\s+.*\s+SET\s+DATA\s+TYPE\b/i,
    message: "Changing column data types is prohibited. Create a new column with the new type instead to avoid type mismatch crashes."
  },
  {
    regex: /\bCREATE\s+INDEX\b(?!.*\bCONCURRENTLY\b)/i,
    message: "CREATE INDEX without CONCURRENTLY is prohibited because it locks table writes. Use CREATE INDEX CONCURRENTLY instead."
  },
  {
    regex: /\bTRUNCATE\b/i,
    message: "TRUNCATE TABLE is prohibited to prevent accidental bulk data destruction."
  },
  {
    regex: /\bADD\s+COLUMN\s+.*\bNOT\s+NULL\b(?!.*\bDEFAULT\b)/i,
    message: "Adding a NOT NULL column without a DEFAULT value is prohibited on existing tables. Add it as nullable first, backfill data, and then set NOT NULL."
  }
];

const BYPASS_COMMENT = "safety-bypass: allow-destructive-operations";

function lintFile(filePath) {
  const filename = path.basename(filePath);
  const sql = fs.readFileSync(filePath, 'utf8');

  // 1. Check for the safety bypass comment
  if (sql.includes(BYPASS_COMMENT)) {
    console.log(`⚠️  [WARNING] Safety bypass detected in ${filename}. Skipping safety validation.`);
    return true;
  }

  // 2. Strip single-line (--) and multi-line (/* */) comments to avoid flagging comments
  const cleanSql = sql
    .replace(/--.*$/gm, '') 
    .replace(/\/\*[\s\S]*?\*\//g, '');

  // 3. Scan for prohibited patterns
  for (const operation of PROHIBITED_OPERATIONS) {
    if (operation.regex.test(cleanSql)) {
      console.error(`\n❌ [MIGRATION ERROR] Validation failed in ${filename}:`);
      console.error(`   👉 ${operation.message}`);
      console.error(`\n   If this change is genuinely intended (e.g. dropping a temporary table),`);
      console.error(`   add the following comment at the top of the file to bypass this check:`);
      console.error(`   -- ${BYPASS_COMMENT}`);
      console.error(`   Or run the migration with the --force flag override.\n`);
      return false;
    }
  }

  return true;
}

function runLinter() {
  const migrationsDir = path.join(__dirname, '../migrations');
  if (!fs.existsSync(migrationsDir)) {
    console.log("No migrations directory found. Skipping check.");
    process.exit(0);
  }

  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Linting ${files.length} database migration file(s)...`);

  let allPassed = true;
  for (const file of files) {
    const filePath = path.join(migrationsDir, file);
    const passed = lintFile(filePath);
    if (!passed) {
      allPassed = false;
    }
  }

  if (!allPassed) {
    process.exit(1);
  }

  console.log("✅ All migration files passed safety checks.");
  process.exit(0);
}

if (require.main === module) {
  runLinter();
} else {
  module.exports = {
    PROHIBITED_OPERATIONS,
    lintFile,
    BYPASS_COMMENT
  };
}
