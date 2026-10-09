# db-viewer auto-inject — plan index

Goal: `agent/db-config.json` jadi sumber default kredensial untuk semua tools di
`agent/extensions/db-viewer/`. Saat pi init, agen otomatis tahu koneksi terdekat
dari `cwd` — tidak perlu cari `.env` / tanya user lagi. Model tetap bisa override
dengan mengisi param eksplisit.

## Status

- [x] 01 — wiring inti (resolver + optional params + `before_agent_start` inject)
- [x] 02 — hardening (commands, guidelines, blast-radius skills/prompts)
- [x] 03 — save credentials (db_save, parent-dedup, probe gate)

## File map

- `01-auto-inject-closest-dir.md` — perubahan perilaku. Wajib dulu.
- `02-commands-guidelines-hardening.md` — `/db-status`, guidelines, docs. Independen, bisa paralel setelah 01.
- `03-save-credentials-with-parent-dedup.md` — `db_save` tool (write path pertama). Setelah 01+02.

## Kontrak yang tidak berubah

- Read-only tetap untuk query path: `shared/query-safe.ts` tidak disentuh. (`db_save` adalah write path terpisah dengan `destructiveHint: true`.)
- Truncation `resolveMaxRows` (default 200, clamp 1–1000), `formatRowsToMarkdown`,
  `toJsonRows` (bigint→string) tidak berubah.
- `agent/db-config.json` tetap gitignored, seeded dari `db-config.example.json` oleh `install.sh:156-159`.
- Aturan `AGENTS.md`: ≤5 `.ts`, reuse `shared/`, tanpa `.js`, tanpa git ops, blast-radius ke `skills/` + `prompts/`.

## Verifikasi global (berlaku untuk semua plan)

- `npx tsc --noEmit` → exit 0
- `npx eslint agent/extensions/db-viewer/ agent/extensions/shared/db.ts` → 0 errors
- `npx prettier --check agent/extensions/db-viewer/index.ts agent/extensions/shared/db.ts` → pass
