# 03 — db_save: model-writable credentials dengan parent-dedup + probe gate

Status: DONE (worker 09-10-26, gates re-verified by orchestrator)
Prioritas: P2 | Effort: S–M | Risiko: MEDIUM (write path pertama di db-viewer)
Keputusan owner (09-10-26): probe success WAJIB sebelum write. Save tanpa probe
yang sukses ditolak (bukan warning).

## Masalah

`db-viewer` read-only penuh: model bisa memakai + mengecek koneksi, tapi tidak
bisa menyimpan kredensial cwd baru ke `agent/db-config.json`. Setiap project
baru = edit manual file oleh user.

## Desain

Satu shared helper + satu tool. Tanpa file `.ts` baru. Ini write path pertama
di extension ini — perlakukan sebagai destructive meskipun targetnya file config
lokal (gitignored).

### Helper di `shared/db.ts`

- `writeDbConfig(config: DbConfig): void` — `JSON.stringify(config, null, 2)`
  + trailing newline (samakan konvensi file saat ini), `writeFileSync` ke
  `join(getAgentDir(), "db-config.json")`, lalu invalidate `_cachedConfig`
  (set `null`) supaya `readDbConfig()` berikutnya re-read dari disk. Tidak ada
  file-locking (single-user lokal, catat sebagai batasan).
- Dedup memakai fungsi 01 yang sudah ada: untuk `(directory, driver)` yang
  diminta, panggil `resolveClosestConnection(directory, driver)` —
  hasilnya adalah "parent entry" (exact-hit termasuk: kalau `directory` sama
  persis dengan entry yang ada, resolve mengembalikan entry itu sendiri).

### `db_save` tool di `db-viewer/index.ts`

Params (TypeBox):

- `name: string` (wajib) — nama koneksi, unik case-insensitive.
- `driver: enum sqlite|mysql` (wajib).
- `connection: string` (wajib) — path file (sqlite) atau URI penuh (mysql).
- `directory?: string` — default `ctx.cwd`; harus absolute setelah `resolve()`
  (tolak relative kosong / `""`).
- `overwrite?: boolean` — default `false`; kalau `name` sudah ada dan
  `overwrite` false → error yang me-list nama yang ada.

Urutan eksekusi (strict, gagal di langkah mana pun = `isError: true`, tanpa write):

1. Validasi param + normalisasi `directory = resolve(directory ?? ctx.cwd)`.
2. Baca config (`readDbConfig()`; kalau file tidak ada → mulai dari
   `{ connections: [] }`, tulis file baru).
3. **Parent-dedup** (aturan user): resolve parent via
   `resolveClosestConnection(directory, driver)` DENGAN mengecualikan entry
   bernama `name` itu sendiri (supaya update entry sendiri tidak dianggap
   "redundan terhadap diri sendiri"). Bandingkan `normalizeDir`-style:
   sqlite bandingkan `resolve(path)` case-insensitive (normalizeDir);
   mysql bandingkan string URI persis (tanpa password-masking, nilai mentah).
   Kalau sama → return sukses-tanpa-write:
   `"Already covered by '<parentName>' (<directory>) — not saved."`
4. **Probe gate (mandatory)**: `probeConnection({ connection })` harus
   `ok: true`. Kalau gagal → error berisi sanitized message + nama entry yang
   TIDAK jadi disimpan. Tidak ada bypass flag.
5. Insert (atau replace bila `overwrite`) `{ name, driver, directory, connection }`,
   `writeDbConfig`, return masked ringkasan (nama + driver + directory +
   masked connection + catatan parent bila ada / "new root" bila tidak ada parent).

Annotations (BEDAKAN dari tool lain — ini write):

```ts
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false }
```

`description`: "Save a database connection for a working directory to
db-config.json. Probes the connection first and refuses redundant entries
already covered by a parent directory."
`outputSchema` + `structuredContent` (parity 036):
`{ saved: boolean, name, reason?: "covered-by-parent" | "probe-failed" | "saved" | "name-exists", parent?: string }`
— `connection` TIDAK pernah muncul full di output (masked selalu).

`promptGuidelines`: ["Use db_save only when the user asks to remember a database
or when a verified working connection has no covering entry in db_status.",
"db_save always probes first; unreachable credentials are rejected, never stored.",
"If the result says covered-by-parent, use the parent entry — do not re-save."]

### `/db-status` ikut tampilkan cakupan

Tidak wajib; opsional kecil: tandai entry yang meng-cover cwd lain? SKIP —
di luar kebutuhan. 02 tetap apa adanya.

## Yang tidak perlu

- Delete/rename tool (`db_remove`) — belum diminta; hapus = edit manual.
- `default: true` flag management via tool — `db_save` tidak set default;
  default tetap dikelola manual di file (hindari model menggeser default global).
- File-locking / backup rotation — single-user; `writeDbConfig` overwrite langsung.
- Enkripsi secret — file gitignored, di luar scope (sama seperti 01).

## Acceptance criteria

- [ ] Save koneksi baru yang probe-ok dari cwd tanpa covering parent → tersimpan,
      `db_status` berikutnya me-list-nya sebagai match.
- [ ] Save dengan `connection` sama persis dengan parent entry (contoh subdir dari
      `C:/laragon/www/hrisv2/mhi` dengan URI `hris` yang sama) → `saved: false`,
      `reason: covered-by-parent`, file TIDAK berubah (bandingkan md5 sebelum/sesudah).
- [ ] Save kredensial salah (contoh password `recruitment` yang saat ini ditolak
      MySQL) → `saved: false`, `reason: probe-failed`, file TIDAK berubah.
- [ ] Save dengan `name` duplikat tanpa `overwrite` → error `name-exists`, file TIDAK berubah.
- [ ] Output teks + structured TIDAK mengandung URI/password penuh (grep pola
      `mysql://root:` pada output → nol match; masked `***` ada).
- [ ] `npx tsc --noEmit` exit 0; eslint + prettier pass; blast-radius grep skills/prompts tercatat.

## STOP conditions

- `probeConnection` tidak bisa dipakai ulang untuk nilai yang belum tersimpan
  (bentuk entry-nya beda) → stop, jangan duplikasi logika probe di tool.
- Owner minta bypass probe ("force save") → stop, itu membatalkan keputusan
  09-10-26, minta persetujuan eksplisit baru.
- Permintaan menghapus/menimpa entry lain sebagai efek samping resolve → stop,
  tool ini insert-or-named-replace saja.
