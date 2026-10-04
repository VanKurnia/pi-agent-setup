---
name: daily-report
description: Menyusun laporan harian kerja (daily work report) dalam Bahasa Indonesia formal dengan istilah teknis tetap dalam Bahasa Inggris. Format WhatsApp siap kirim dengan section Progress dan Kendala sebagai wajib, serta On Going Task dan Backlog sebagai opsional. Tidak melakukan penyimpanan otomatis ke vault.
disable_model_invocation: true
---

# Laporan Harian Kerja — Daily Report

Skill ini membantu penyusunan laporan harian kerja dalam **Bahasa Indonesia formal** dengan **istilah teknis tetap dalam Bahasa Inggris**, dalam format WhatsApp yang rapi dan konsisten.

## Aturan Bahasa

- Gunakan Bahasa Indonesia formal dan baku (EYD) untuk seluruh narasi.
- Istilah teknis, nama `project`, `module`, `field`, `code literal`, dan status pekerjaan wajib menggunakan Bahasa Inggris dan ditulis dalam format `code` (contoh: `email service`, `Assignment`, `toggle`, `backfill db`).
- Status pekerjaan:
  - `Done` — untuk pekerjaan yang telah selesai.
  - `In Progress` — untuk pekerjaan yang sedang berlangsung.
- Hindari bahasa informal, singkatan tidak baku, dan percampuran bahasa yang tidak perlu.

## Format Laporan

Skill ini menghasilkan dua varian format untuk setiap laporan:
- **WhatsApp Format** — format dengan markdown WhatsApp (`*`, `_`, `>`, `` ` ``) siap kirim ke WhatsApp.
- **Web Format** — format polos tanpa formatting WhatsApp, cocok untuk web, email, atau dokumentasi.

### Format WhatsApp

#### Format Wajib (WhatsApp)

Struktur dasar laporan hanya terdiri dari `Progress` dan `Kendala`:

```text
*Progress :*
> _*Hari, DD Bulan YYYY*_
*Nama Project/Module*
- _*Done*_ — Deskripsi pekerjaan yang telah diselesaikan dengan istilah teknis dalam `code`.
- _*In Progress*_ — Deskripsi pekerjaan yang sedang dikerjakan.

*Kendala :*
- Belum Ada
```

### Format Opsional

Section `On Going Task` dan `Backlog` hanya ditambahkan apabila terdapat informasi yang relevan atau diminta secara eksplisit. Jika tidak ada, tidak perlu ditampilkan.

```text
*On Going Task :*
- Deskripsi tugas yang sedang berjalan dan akan dilanjutkan.

*Backlog :*
- Deskripsi tugas tertunda atau yang direncanakan selanjutnya.
```

### Format Web (Tanpa Formatting WhatsApp)

Varian polos tanpa `*`, `_`, `>` untuk keperluan web:

```text
Progress — Hari, DD Bulan YYYY
Nama Project/Module
- Done — Deskripsi pekerjaan dengan istilah teknis tanpa backtick.
- In Progress — Deskripsi pekerjaan yang sedang dikerjakan.

Kendala:
- Belum Ada
```

## Ketentuan Format

**Untuk WhatsApp Format:**
1. **Header Progress:** Selalu diawali dengan `*Progress :*`
2. **Tanggal:** Ditulis dalam bentuk blockquote italic-bold: `> _*Hari, DD Bulan YYYY*_` (contoh: `> _*Rabu, 02 September 2026*_`)
3. **Nama Project:** Ditulis tebal tanpa bullet: `*MHI*`, `*Recruitment*`
4. **Item Pekerjaan:** Diawali dengan `- _*Done*_ —` atau `- _*In Progress*_ —` menggunakan em-dash (`—`)
5. **Kendala:** Ditulis sebagai `*Kendala :*` diikuti `- Belum Ada` jika tidak ada kendala
6. Gunakan tanda hubung panjang `—` sebagai pemisah, bukan `|`, `:` atau `->`
7. Gunakan `code literal` (backtick) untuk istilah teknis (hanya pada WhatsApp Format)

**Untuk Web Format:**
1. Tanpa `*`, `_`, `>`, dan tanpa backtick
2. Header polos: `Progress — Hari, DD Bulan YYYY` dan `Kendala:`
3. Item: `- Done —` / `- In Progress —`

## Contoh Penerapan

```text
*Progress :*
> _*Rabu, 02 September 2026*_
*MHI*
- _*Done*_ — Menyiapkan `email service` yang dapat digunakan oleh seluruh `module` MHI untuk pengiriman email.
- _*Done*_ — Implementasi `default signature template` Endo pada pratinjau email.
*Recruitment*
- _*Done*_ — Perbaikan `bug` pada `toggle notifikasi whatsapp reminder` kandidat yang tidak tampil melalui `backfill db` dan `rebuild js assets`.
- _*Done*_ — Perbaikan `bug` pada `link zoom` yang tidak muncul pada whatsapp reminder H-2 jam sebelum interview online.
- _*Done*_ — Refaktor dan dedup `reminder helper func`.
- _*In Progress*_ — Pembaruan halaman `nilai tes` dan `pelamar dalam proses` agar diurutkan berdasarkan perubahan status terkini.

*Kendala :*
- Belum Ada
```

Contoh dengan section opsional:

```text
*Progress :*
> _*Selasa, 02 September 2026*_
*MHI*
- _*Done*_ — Refaktor modul `Assignment` terkait query dan kalkulasi durasi kerja.

*On Going Task :*
- Pengujian dan persiapan `trial` lanjutan MHI minggu depan.

*Backlog :*
- Implementasi `serial number` untuk material dan aksesoris.

*Kendala :*
- Belum Ada
```

## Alur Kerja Agent

1. **Identifikasi user dan aktivitas hari ini (otomatis `C:/laragon/www/` termasuk submodule & worktree)** — Sebelum bertanya, agent wajib:
   - Membaca `current user` via `git config user.name` dan `git config user.email` (global).
   - Melakukan auto-detect semua project Git di `C:/laragon/www/` **secara rekursif**:
     - Top-level: setiap subdirektori di `C:/laragon/www/` yang memiliki `.git` (file atau direktori, termasuk `worktree` dengan `gitdir:`).
     - Submodule & worktree: untuk setiap repo yang ditemukan, cek `git submodule status` dan `git worktree list` serta path `mhi` / `.git/modules/*`; deteksi juga `C:/laragon/www/hrisv2/mhi` (submodule `mhi` dengan `gitdir: ../.git/modules/mhi`) dan `C:/laragon/www/hrisv2-mhi` (worktree) beserta submodule-nya `C:/laragon/www/hrisv2-mhi/mhi`. **Jangan abaikan parent**: jika submodule memiliki aktivitas hari ini, parent tetap dipertahankan sebagai entri terpisah dan ditandai memiliki `submodule pointer change`.
     - Untuk setiap repo/submodule/worktree yang ditemukan, jalankan `git config user.name/email` (per repo), `git status --porcelain` (termasuk `M mhi` untuk parent yang menandakan `submodule pointer` berubah), `git diff --submodule --stat`, dan `git log --all --author="<user>" --since="today" --oneline` untuk menemukan branch dengan aktivitas hari ini (`commit`, `staged`, `unstaged`, `untracked`, termasuk perubahan pointer submodule).
   - Menyusun daftar rekomendasi gabungan dalam format `project/branch` dengan prefix yang jelas (mis. `hrisv2/ivan-stage`, `hrisv2/mhi/main`, `hrisv2-mhi/mhi/feature-phinx`, `recruitment/main`) — beri prioritas pada branch dengan commit terbanyak hari ini dan `current branch` yang memiliki perubahan belum commit. **Abaikan parent dengan status `M mhi` (pointer submodule) jika commit submodule sudah tercakup** — parent hanya ditampilkan jika memiliki commit/staged/unstaged di luar pointer submodule atau diminta eksplisit.
   - **Fallback:** Jika tidak ada project Git yang terdeteksi di `C:/laragon/www/` atau tidak ada aktivitas hari ini, lanjutkan ke langkah 2 dengan mode tanya manual (`ask_user_question` untuk `project dir` terlebih dahulu).
2. **Tanya branch dengan rekomendasi** — Ajukan `ask_user_question` yang berisi daftar rekomendasi `project/branch` hari ini sebagai `options` (beri label `(Recommended)` pada entri dengan aktivitas terbanyak hari ini). Aktifkan `multiSelect: true` agar pengguna dapat memilih beberapa `project/branch` sekaligus. Jika fallback, tanyakan `project dir` terlebih dahulu, lalu branch di dalamnya. Sertakan opsi `Lainnya` untuk input manual.
3. **Ambil perubahan aktual dari project/branch terpilih** — Untuk setiap `project/branch` yang dipilih:
   - Tentukan `repo path` = `C:/laragon/www/<project>` (untuk submodule gunakan path lengkap mis. `C:/laragon/www/hrisv2/mhi` atau `C:/laragon/www/hrisv2-mhi/mhi`).
   - Jalankan `git status`, `git diff --staged`, dan `git diff` untuk membaca `staged` dan `unstaged changes` (termasuk `untracked files`) pada repo tersebut. **Abaikan `M mhi` pointer change pada parent** jika commit submodule sudah tercakup dalam laporan — jangan tampilkan sebagai `In Progress` kecuali diminta eksplisit.
   - Jalankan `git log --oneline <branch> --not origin/main --author="<user>" --since="today"` dan `git diff --stat origin/main..branch` untuk membaca `committed changes` khusus user hari ini pada repo tersebut. Jika yang dipilih adalah parent dan submodule-nya juga dipilih, gabungkan keduanya dan beri label terpisah (`HRIS` untuk parent, `MHI` untuk submodule), tetapi hilangkan duplikasi pointer.
   - Jika multiple project/branch, gabungkan hasil dari semua repo/branch lalu sederhanakan menjadi poin-poin kecil yang padat, hilangkan duplikasi, dan kelompokkan per `project`/`module`.
4. Merapikan bahasa menjadi Bahasa Indonesia formal tanpa mengubah istilah teknis menjadi Bahasa Indonesia.
5. Memformat laporan sesuai template wajib `Progress` dan `Kendala`.
6. Menambahkan `On Going Task` dan `Backlog` hanya jika pengguna menyertakan atau memintanya secara eksplisit atau jika `unstaged`/`staged` menunjukkan pekerjaan yang masih `In Progress`.
7. Menampilkan hasil akhir dalam dua varian: `whatsapp` (WhatsApp Format) dan `text` (Web Format) agar mudah disalin sesuai kebutuhan.
8. **Tidak melakukan penyimpanan otomatis** ke dalam vault, file, atau direktori mana pun. Agent hanya menampilkan hasil di dalam percakapan.

## Larangan

- Dilarang menyimpan laporan secara otomatis ke `Journal/Work/` atau direktori lain.
- Dilarang mengubah istilah teknis menjadi Bahasa Indonesia.
- Dilarang menambahkan section di luar ketentuan wajib (`Progress`, `Kendala`) dan opsional (`On Going Task`, `Backlog`) yang telah ditetapkan.
