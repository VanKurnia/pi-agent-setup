# 02 — Hardening: db_status probe, /db-status, guidelines, docs

Status: DONE (worker 09-10-26, gates re-verified by orchestrator)
Prioritas: P2 | Effort: S–M | Risiko: LOW

## Masalah

Setelah wiring 01, model bisa jalan tanpa tahu *kenapa* default itu dipilih.
Tanpa introspeksi + probe koneksi yang akurat, debugging ("kok pakai db yang
salah?" / "db-nya hidup atau tidak?") tetap butuh baca `db-config.json` manual
+ `SELECT 1` manual dengan kredensial paste-an.

## Desain

Tetap di file yang sama, tanpa file `.ts` baru (satu shared helper + satu tool
+ satu command wrapper):

1. **`probeConnection` helper di `shared/db.ts`** (single source of truth,
   dipakai tool + command — tanpa duplikasi logika probe):
   - sqlite: `new DatabaseSync(entry.connection)` → `prepare("SELECT 1 AS ping").get()` → `close()`.
   - mysql: `await import("mysql2/promise")` (lazy, pola yang sama seperti
     `query_mysql` saat ini) → `createConnection(uri)` → `execute("SELECT 1 AS ping")` → `end()`.
   - Return `{ ok: boolean, latencyMs: number, error?: string }` — `error`
     adalah pesan driver yang disanitasi (tanpa URI/password).
   - Timeout: bungkus dengan `Promise.race` + ~5s agar command tidak gantung
     saat host tidak reachable (contoh `eis` di `192.168.0.83`).
   - Mask helper: `mysql://user:***@host:port/db` untuk semua output manusia.

2. **`db_status` tool (model-callable)** di `db-viewer/index.ts` — model tidak
   bisa memanggil slash-command, jadi probe harus berupa tool:
   - `annotations: { readOnlyHint: true, idempotentHint: true }`, plus
     `outputSchema` + `structuredContent` (parity plan 036 agar `codemode`
     terima typed data, bukan cuma Markdown).
   - No required params (opsional `driver?: sqlite|mysql` untuk filter).
     Resolve via resolver 01 untuk `ctx.cwd`, probe match per-driver + list
     semua nama koneksi (masked).
   - `description`: "Check database connectivity for the closest-dir defaults
     from db-config.json. Returns reachability + latency per driver without
     running user queries."

3. **`/db-status` command** (tiru `/obsidian-status`: `ctx.ui.notify`, tanpa
   `setEditorText`) — thin wrapper di atas helper yang sama. Output: `cwd`
   saat ini, match per-driver (nama + directory + `default` marker + `ok`
   + `latencyMs`), dan daftar nama koneksi. Tidak pernah print password/URI
   penuh (masked). Read-only, tanpa UI custom.

4. **Guidelines + descriptions** (copy-paste untuk eksekutor): pastikan
   `description` kedua query tool menyebut no-credentials behavior:
   - sqlite `description`: "Execute safe, read-only SELECT queries on a local
     SQLite database file. Omit dbPath to use the closest-dir default from
     db-config.json."
   - mysql `description`: "Execute safe, read-only queries on a MySQL database.
     Omit connectionString to use the closest-dir default from db-config.json."
   - param `dbPath`/`connectionString`: "Omit to use closest-dir default from
     db-config.json; pass a connection name, path, or full URI to override."
   - `promptGuidelines` kedua tool + `db_status`: ganti kalimat `.env`/
     `ask_user_question` yang sudah kedaluwarsa jadi "Omit dbPath/
     connectionString to use the closest-dir default from db-config.json; pass
     an explicit value to override."
   - `promptSnippet` tetap pendek ("Query SQLite/MySQL databases" / "Check DB connectivity").

5. **Blast-radius check** (wajib AGENTS.md rule 4): grep ulang
   `query_sqlite|query_mysql|db-config|db-viewer` di `agent/skills/` dan
   `agent/prompts/`. Saat direncanakan (09-10-26): nol match, jadi tidak ada
   referensi yang perlu diupdate. Kalau saat eksekusi muncul match (skill baru),
   update referensi yang menyebut cara lama (wajib isi dbPath/URI manual).

6. **Docs**: satu baris di `README.md` tabel `db-viewer` (kolom Description)
   + contoh `db-config.example.json` sudah cukup (tidak perlu contoh baru).

## Yang tidak perlu

- `/db-use` interaktif / switcher — model cukup override via param.
- Monitoring kontinu / reconnect / pool — probe sekali jalan per panggilan.
- Write-probe (`INSERT`/`CREATE`) — `SELECT 1 AS ping` cukup, jaga read-only contract.
- Output URI/password penuh di tool/command — masked selalu, kecuali entry match
  terdekat di pesan `before_agent_start` 01 (yang memang butuh URI penuh untuk dipakai tool).
- `/sqlite-schema` + `/mysql-schema` diubah untuk ikut auto-resolve — sengaja
  tidak: command schema butuh argumen eksplisit supaya tidak ambigu.
- Widget / statusline DB aktif — overkill untuk prefill diam-diam.

## Acceptance criteria

- [ ] `/db-status` dari tiap `directory` di config menampilkan match yang sama
      dengan resolver 01 (hris / recruitment / hris-test / eis) + `ok: true`
      untuk yang reachable (hris/recruitment/hris-test lokal) dengan `latencyMs`.
- [ ] Host unreachable (contoh `eis` `192.168.0.83` saat offline) → `ok: false` +
      pesan error sanitasi dalam ≤~5s, tanpa hang, tanpa secret leak.
- [ ] `db_status` tool mengembalikan `structuredContent` yang sama dengan teks
      (parity 036): `{ cwd, matches: [{ driver, name, ok, latencyMs }], connections: string[] }`.
- [ ] Tidak ada URI/password penuh di output `/db-status` maupun di pesan
      `before_agent_start` untuk non-match entries.
- [ ] `promptGuidelines` tidak lagi menyuruh cari `.env` untuk kredensial DB.
- [ ] Grep skills/prompts tercatat hasilnya di laporan eksekusi.
- [ ] `npx tsc --noEmit` exit 0; eslint + prettier pass.

## STOP conditions

- Probe mysql menggantung tanpa timeout / melebihi ~5s → stop, perbaiki timeout
  dulu (jangan land tanpa batas).
- `ctx.ui.notify` tidak tersedia di mode non-TUI untuk command ini → stop,
  jadikan notify-only tanpa `setEditorText` (jangan tambah custom UI).
- Owner minta masking dimatikan (butuh URI penuh di `/db-status`) → stop,
  itu keputusan exposure secret, bukan default eksekutor.
