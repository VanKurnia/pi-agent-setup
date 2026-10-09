# 01 — Auto-inject closest-dir db-config ke db-viewer tools

Status: DONE (worker 09-10-26, gates re-verified by orchestrator)
Prioritas: P1 | Effort: S–M | Risiko: LOW

## Masalah

`agent/extensions/db-viewer/index.ts` tidak memakai `agent/db-config.json` sama sekali.
`query_sqlite` wajib `dbPath`, `query_mysql` wajib `connectionString` — model harus
paste full path/URI tiap call. `shared/db.ts` sudah punya `readDbConfig()` +
`findDbConnectionByValue()` tapi zero callers (grep 09-10-26). `db-config.json`
(yang berisi `hris` default, `recruitment`, `hris-test`, `eis` + field `directory`)
jadi dead config.

## Desain (official-way only)

Jangan bikin mekanisme baru. Tiru tiga pola yang sudah ada di repo:

1. **Inject sekali per session** — pola `obsidian-suite.ts` (`pi.on("before_agent_start")`
   return `{ message: { customType, content, display: false } }` + dedup via
   `ctx.sessionManager.getBranch()`). Bedanya: pesan berisi koneksi terdekat untuk
   `ctx.cwd` saat itu, bukan vault index.
2. **Prefill tapi overridable** — jadikan `dbPath` / `connectionString`
   `Type.Optional`. Di dalam `execute()` (yang menerima `ExtensionToolContext`
   = `ExtensionContext` + `executeTool`, punya `ctx.cwd` per
   `types.d.ts:213-221`), kalau param kosong → resolve dari config untuk cwd
   tersebut. Kalau param diisi (nama koneksi, path, atau URI penuh) → pakai itu
   apa adanya. Tidak ada `tool_call` handler tambahan — satu tempat resolve di
   `execute()` cukup dan lebih sederhana (aturan AGENTS.md: hilangkan abstraksi
   prematur). `tool_call` mutation (`types.d.ts:940-945`, "mutate in place, no
   re-validation") sengaja TIDAK dipakai supaya tidak ada dua jalur prefill.
3. **Closest-parent match** — pola `/workdir` di
   `session-mgr/session-ops.ts:265-277` (`findParent`: normalisasi + longest
   `startsWith(n + "/")` prefix wins). Resolver DB memakai skor yang sama,
   bedanya: kandidat = entries `db-config.json` per-driver (bukan session cwds),
   exact match (`cwd == directory`) dihitung sebagai hit terbaik (bukan di-skip
   seperti `findParent` yang parent-only untuk render forest), plus fallback
   `default: true`. Normalizer-nya WAJIB reuse yang canonical (lihat Step 0) —
   dilarang nulis normalizer ketiga (AGENTS.md #3).

### Step 0: Promosikan `normalizeDir` ke `shared/` (wajib sebelum resolver)

Keadaan saat ini: `normalizeDir(p) = p.replace(/\\/g, "/").toLowerCase()`
 didefinisikan di `session-mgr/session-ops.ts:34`, dipakai 4 situs di file yang
 sama (`:224, :231, :266-271, :304`) + diimpor oleh `cleanup.ts:32-38`
 (`from "./session-ops.js"`). `shared/text-format.ts` sudah menjadi rumah
 canonical untuk helper path lintas-extension (`shortenHome`, diimpor oleh
 `session-mgr` + `subagents/src/render.ts`) — jadi promosi ke sana mengikuti
 preseden, bukan lokasi baru.

1. Pindah byte-identical implementation ke `shared/text-format.ts` + doc comment
   satu baris (lowercase = intent case-insensitive Windows, sama seperti perilaku
   `/workdir` saat ini; jangan "perbaiki" jadi conditional `win32` — itu
   perubahan perilaku di luar scope).
2. Di `session-ops.ts`: hapus definisi lokal, ganti dengan
   `import { normalizeDir } from "../shared/text-format.js"` + tambah
   `export { normalizeDir };` re-export satu baris. `cleanup.ts` TIDAK disentuh
   (tetap `from "./session-ops.js"`, tetap jalan via re-export).
3. Resolver DB di `shared/db.ts` impor dari `./text-format.js` (satu direktori,
   bukan cross-extension import).

**Verify**: `grep -rn "function normalizeDir" agent/extensions/` → tepat 1 hasil
 (`shared/text-format.ts`); `npx tsc --noEmit` → exit 0; `/workdir` smoke test:
 `flattenForest(buildForest(...))` ordering tidak berubah (tidak ada perubahan
 skor, hanya pindah lokasi definisi).

### Resolver (tambah di `shared/db.ts`, reuse cache mtime yang sudah ada)

```ts
resolveClosestConnection(cwd: string, driver: "sqlite" | "mysql"): DbConnection | undefined
resolveConnectionValue(input: string | undefined, cwd: string, driver): DbConnection | { passthrough: string } | undefined
```

Aturan match (deterministik, reuse `normalizeDir` canonical dari Step 0):

1. Normalisasi via `normalizeDir(resolve(p))` untuk cwd maupun `directory` —
   JANGAN inline `replace`/`toLowerCase` baru. Skor persis `findParent`:
   `norm.startsWith(n + "/")` (plus `norm === n` sebagai exact-hit terbaik).
   Bukan `startsWith` mentah supaya `C:/foo-bar` tidak match `C:/foo`.
2. Menang = prefix terpanjang. Tie → `default: true` dulu, lalu nama alfabetis.
3. Tidak ada prefix match → fallback `default: true` untuk driver itu.
4. `resolveConnectionValue`: `undefined`/kosong → (2–3); input == `name`
   (case-insensitive) → entry itu; selain itu → passthrough (path/URI eksplisit,
   tidak divalidasi terhadap config — ini jalur override model).

### Perubahan `db-viewer/index.ts`

- `query_sqlite.parameters.dbPath` → `Type.Optional(Type.String(...))`,
  deskripsi baru: "Omit to use closest-dir default from db-config.json; pass a
  connection name, path, or full URI to override."
- `query_mysql.parameters.connectionString` → sama, untuk driver mysql.
- Di tiap `execute()`: ganti `_ctx` jadi `ctx`, panggil
  `resolveConnectionValue(params.dbPath ?? params.connectionString, ctx.cwd ?? process.cwd(), driver)`.
  Kalau unresolved → return `isError: true` dengan pesan yang me-list nama
  koneksi yang tersedia (dari `readDbConfig()`), bukan throw.
- Tambah `pi.on("before_agent_start")` sekali (di bawah `export default function`):
  resolve kedua driver untuk `ctx.cwd`, return persistent message
  `customType: "db-viewer-connections"` berisi max ~15 baris (nama + driver +
  directory + default marker; connectionString penuh HANYA untuk match terdekat,
  bukan semua entry — batasi exposure secret). Dedup persis pola obsidian-suite:
  cek `getBranch()` sudah ada `customType` itu, dan flag modul `hasInjected`.
  `display: false`.
- `promptGuidelines` kedua tool: ganti kalimat `.env`/`ask_user_question` jadi
  "Omit dbPath/connectionString to use the closest-dir default from
  db-config.json; pass an explicit value to override."
- Tidak tambah file `.ts` baru. Scope = 4 file: `shared/text-format.ts`
  (+`normalizeDir` pindahan, Step 0), `session-mgr/session-ops.ts` (ganti definisi
  jadi import + re-export), `shared/db.ts` (resolver), `db-viewer/index.ts`
  (wiring). `session-mgr/cleanup.ts` sengaja TIDAK masuk scope (tetap impor via
  re-export, nol edit). Tiap extension tetap dalam batas AGENTS.md (<5 `.ts`).

## Yang tidak perlu

- `tool_call` auto-fill handler — redundan dengan resolve di `execute()`.
- Env-var override (`DB_*`) — `db-config.json` sudah single source of truth.
- UI picker / `/db-use` interaktif — di luar kebutuhan "prefill diam-diam".
- Enkripsi secret di config — di luar scope; file sudah gitignored.
- Ubah `query-safe.ts`, truncation, markdown formatter.

## Acceptance criteria

- [ ] Dari cwd `C:/laragon/www/hrisv2/mhi`, `query_mysql` tanpa `connectionString`
      memakai koneksi `hris`; dari `C:/Users/Ivan/Documents/Recruitment` memakai
      `recruitment`; sqlite dari `C:/Users/Ivan/Documents/HRIS` memakai `hris-test`.
- [ ] Param eksplisit (nama / path / URI) selalu menang atas default.
- [ ] Tanpa config atau tanpa match + tanpa default → error message me-list nama tersedia.
- [ ] `before_agent_start` menginject tepat 1 pesan per session, tidak duplikat
      setelah `/reload` / resume (cek branch).
- [ ] Step 0: `grep -rn "function normalizeDir"` tepat 1 (shared); `cleanup.ts`
      tanpa edit tetap typecheck (via re-export); ordering `/workdir` tidak berubah.
- [ ] `npx tsc --noEmit` exit 0; eslint + prettier pass untuk 4 file scope.
- [ ] Blast-radius: grep `query_sqlite|query_mysql|db-config` di
      `agent/skills/` + `agent/prompts/` dicatat (saat direncanakan: nol match).

## STOP conditions

- Step 0 mengubah urutan `/workdir` forest atau memecah `cleanup.ts` import →
  stop, revert promosi (resolver tidak boleh land di atas normalizer ganda).
- Import `shared/text-format.js` dari `session-ops.ts` menimbulkan cycle di
  jiti loader → stop, fallback: tetap re-export tanpa import cycle (lapor).

- `ExtensionToolContext` ternyata tidak membawa `cwd` di runtime (cek
  `types.d.ts:269` + uji live) → stop, jangan fallback ke `process.cwd()` diam-diam.
- `Type.Optional` membuat `codemode` `structuredContent` contract berubah → stop.
- Ada permintaan mengenkripsi / menyembunyikan connectionString dari model —
  bertentangan dengan kebutuhan tool (model butuh URI penuh) → stop, minta keputusan owner.
