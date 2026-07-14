import 'dotenv/config';
process.env.NODE_ENV ??= 'development';
const { default: mongoose } = await import('mongoose');
const { BlobServiceClient } = await import('@azure/storage-blob');
const { archiveDay } = await import('../src/services/audit-archive.service.ts');

const TARGET_DAYS = ['2026-04-10', '2026-05-15', '2026-06-12']; // empty past dates; chronological for the chain
const COUNTS = { '2026-04-10': 28, '2026-05-15': 41, '2026-06-12': 33 };

await mongoose.connect(process.env.MONGO_URI);
const db = mongoose.connection.db;
console.log('DB =', db.databaseName);

// 1) ensure the audit-archives container exists
const svc = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
const created = await svc.getContainerClient('audit-archives').createIfNotExists();
console.log('container audit-archives:', created.succeeded ? 'CREATED' : 'already exists');

// 2) backdate throwaway audit rows onto the empty target days (clone real rows, new _id + created_at)
const logs = db.collection('audit_logs');
const templates = await logs.find({}).limit(50).toArray();
if (templates.length === 0) { console.log('no audit_logs to clone from — abort'); process.exit(1); }
for (const day of TARGET_DAYS) {
  const existing = await logs.countDocuments({ created_at: { $gte: new Date(`${day}T00:00:00+05:30`), $lte: new Date(`${day}T23:59:59+05:30`) } });
  if (existing > 0) { console.log(`  ${day}: ${existing} real rows already here — SKIPPING (won't touch real data)`); continue; }
  const n = COUNTS[day];
  const docs = [];
  for (let i = 0; i < n; i++) {
    const t = templates[i % templates.length];
    const hh = String(9 + (i % 9)).padStart(2,'0'); const mm = String((i*7) % 60).padStart(2,'0');
    docs.push({ ...t, _id: new mongoose.Types.ObjectId(),
      created_at: new Date(`${day}T${hh}:${mm}:00+05:30`), updated_at: new Date(`${day}T${hh}:${mm}:00+05:30`) });
  }
  await logs.insertMany(docs);
  console.log(`  ${day}: inserted ${n} backdated rows`);
}

// 3) archive each day (chronological → builds the tamper-evident chain), which uploads to blob + deletes the backdated rows
for (const day of TARGET_DAYS) {
  const r = await archiveDay(day);
  console.log(`  archived ${day}: rows=${r.row_count} bytes=${r.file_size_bytes} sha=${(r.sha256_hash||'').slice(0,16)}… ${r.skipped_reason?('skip:'+r.skipped_reason):''}`);
}

console.log('audit_archives total now:', await db.collection('audit_archives').countDocuments());
console.log('audit_logs total now:', await logs.countDocuments());
await mongoose.disconnect();
