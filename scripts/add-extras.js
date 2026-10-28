// Appends prisma/sql/extras.sql to the newest migration (run once, after
// `npx prisma migrate dev --name init --create-only`).
const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'prisma', 'migrations');
const extras = fs.readFileSync(path.join(__dirname, '..', 'prisma', 'sql', 'extras.sql'), 'utf8');
const MARKER = '-- ===== extras.sql';

const folders = fs.existsSync(migrationsDir)
  ? fs.readdirSync(migrationsDir).filter((f) => fs.statSync(path.join(migrationsDir, f)).isDirectory()).sort()
  : [];
if (!folders.length) {
  console.error('No migration found. First run: npx prisma migrate dev --name init --create-only');
  process.exit(1);
}
const file = path.join(migrationsDir, folders[folders.length - 1], 'migration.sql');
const current = fs.readFileSync(file, 'utf8');
if (current.includes(MARKER)) {
  console.log('Extras already added to', path.relative(process.cwd(), file));
} else {
  fs.writeFileSync(file, current + '\n\n' + extras);
  console.log('Added extras to', path.relative(process.cwd(), file));
  console.log('Now run: npx prisma migrate dev');
}

