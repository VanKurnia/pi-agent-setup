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
1. Usahakan pembuatan extension dalam bentuk single file, atau jika terpaksa berupa direktori, batasi di bawah 5 file .ts.
2. Dilarang menggunakan file .js dan dilarang membuat duplikat dependency node_modules sendiri yang bloated jika sudah tersedia di parent directory.
3. Dilarang mendefinisikan ulang fungsi atau logic yang sudah tersedia di `agent/extensions/shared/` atau bawaan (built-in) official repo pi.
4. Ketika suatu extension di-update, lakukan analisis blast radius ke `agent/skills/` dan `agent/prompts/`, serta pastikan selalu memperbarui referensi terkait yang ikut terdampak.

## Git Rules
1. Jangan pernah push atau lakukan operasi git apapun kecuali diminta atau atas izin eksplisit dari user.
