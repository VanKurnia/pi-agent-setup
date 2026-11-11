# Aturan Wajib Bekerja di Repo Ini

## Main Rule
1. Dilarang berasumsi dan wajib selalu ikuti official docs/website/github dari pi:
   - pelajari dokumentasi lokal di `{User Global Path}\node_modules\@earendil-works\pi-coding-agent\docs`.
   - website resmi [pi.dev](https://pi.dev).
   - GitHub [earendil-works/pi](https://github.com/earendil-works/pi).
2. Sederhanakan implementasi kode tanpa mengubah intended behavior: hilangkan abstraksi prematur, duplikasi, dan kode defensif berlebih agar tetap clean dan maintainable.
3. Jangan pernah mengimplementasikan abstraksi atau mekanisme di luar official way tanpa persetujuan atau permintaan eksplisit dari user.

## Vite+ Docs (sumber utama, wajib diikuti sebelum `vp create`/`migrate`)
- `https://viteplus.dev/llms-full.txt` (dokumen utama untuk agen) dan `https://viteplus.dev/guide`.
- Alur baru: `https://viteplus.dev/guide/create` + `https://viteplus.dev/guide/upgrade` (cek `vp toolchain --global`, Node `^22.18.0 || ^24.11.0 || >=26.0.0`).
- Alur migrasi/upgrade: `https://viteplus.dev/guide/migrate`, `/guide/migrate-rules`, `/guide/vitest-v5`, ditambah upstream `https://vitest.dev/guide/migration/` dan `https://github.com/rolldown/tsdown/releases/tag/v0.23.0`.
- Jalankan CLI target tanpa instal dulu: `npx --package=vite-plus@<ver> vp <cmd>` (preview tambah `--registry=https://registry-bridge.viteplus.dev`).

## Extensions Creations
1. Usahakan pembuatan extension dalam bentuk single file, atau jika terpaksa berupa direktori, batasi di bawah 5 file `.ts`.
2. Dilarang menggunakan file .js dan dilarang membuat duplikat dependency `node_modules` sendiri yang bloated jika sudah tersedia di parent directory.
3. Dilarang mendefinisikan ulang fungsi atau logic yang sudah tersedia di `agent/extensions/shared/` atau bawaan (built-in) official repo pi.
4. Ketika suatu extension di-update, lakukan analisis blast radius ke `agent/skills/` dan `agent/prompts/`, serta pastikan selalu memperbarui referensi terkait yang ikut terdampak.
5. `index.ts` = registrasi saja; target <150 baris. Nol top-level side effect: tanpa fs/spawn/timer/net/alloc besar.
6. Kode yang hanya jalan saat dipanggil → file sendiri + `await import("./x.ts")` di `execute`/`handler`. Wajib jika ≥100 baris atau menarik `node:fs|os|path|child_process`, session projection, spawn, editor/UI.
7. Import statis saat registrasi: boleh `import type`, `Type` typebox, schema params kecil, konstanta kecil. Selebihnya langgar #6.
8. Split per peran: `index.ts` (register) · `tool-body.ts`/`<tool>-tool.ts` (payload) · `settings-ui.ts`/`settings-command.ts` · `config.ts`/`om.ts`/`compaction.ts` (domain I/O). Acuan: `herdr-subagents/index.ts` (26 baris).
9. Import relatif wajib `.ts`, jangan `.js`.
10. Lintas extension: `import type` saja; runtime lewat `agent/extensions/shared/` atau API global-backed (loader beri instance modul per-extension); jangan import runtime dari ext ter-disable.
11. Gate I/O mahal di call time, bukan boot (contoh `herdrProtocolProblem()` → pesan upgrade, bukan unknown-method). Aksi advisory (toast, pane tail, rename) wajib `try/catch`.
12. Klaim hemat boot tanpa angka = dilarang; ukur dengan `.script/bench-extensions.mjs`.

## Git Rules
1. Jangan pernah push atau lakukan operasi git apapun kecuali diminta atau atas izin eksplisit dari user.
