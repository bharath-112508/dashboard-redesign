import 'dotenv/config';
process.env.NODE_ENV ??= 'development';
const { default: mongoose } = await import('mongoose');
const { archiveDay } = await import('../src/services/audit-archive.service.ts');
await mongoose.connect(process.env.MONGO_URI);
for (const day of ['2026-04-10','2026-05-15','2026-06-12']) {
  console.log('ARCHIVING', day, new Date().toISOString());
  try { const r = await archiveDay(day); console.log('  DONE', day, 'rows='+r.row_count, 'bytes='+r.file_size_bytes, 'sha='+(r.sha256_hash||'').slice(0,16)); }
  catch(e){ console.log('  FAILED', day, String(e?.message||e).slice(0,160)); }
}
console.log('ALL DONE');
await mongoose.disconnect();
