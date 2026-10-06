# Aturan Wajib Bekerja di Repo Ini

## Main Rule
1. Dilarang berasumsi dan wajib selalu ikuti official docs/website/github dari pi:
   - pelajari dokumentasi lokal di `{User Global Path}\node_modules\@earendil-works\pi-coding-agent\docs`.
   - website resmi [pi.dev](https://pi.dev).
   - GitHub [earendil-works/pi](https://github.com/earendil-works/pi).
2. Sederhanakan implementasi kode tanpa mengubah intended behavior: hilangkan abstraksi prematur, duplikasi, dan kode defensif berlebih agar tetap clean dan maintainable.
3. Jangan pernah mengimplementasikan abstraksi atau mekanisme di luar official way tanpa persetujuan atau permintaan eksplisit dari user.

## Extensions Creations
1. Usahakan pembuatan extension dalam bentuk single file, atau jika terpaksa berupa direktori, batasi di bawah 5 file .ts.
2. Dilarang menggunakan file .js dan dilarang membuat duplikat dependency node_modules sendiri yang bloated jika sudah tersedia di parent directory.
3. Dilarang mendefinisikan ulang fungsi atau logic yang sudah tersedia di `agent/extensions/shared/` atau bawaan (built-in) official repo pi.
4. Ketika suatu extension di-update, lakukan analisis blast radius ke `agent/skills/` dan `agent/prompts/`, serta pastikan selalu memperbarui referensi terkait yang ikut terdampak.

## Git Rules
1. Jangan pernah push atau lakukan operasi git apapun kecuali diminta atau atas izin eksplisit dari user.
