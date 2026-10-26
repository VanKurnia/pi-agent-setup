---
description: Generate daftar perubahan dari commit SHA, rentang, atau branch dalam Bahasa Indonesia formal
argument-hint: "<sha|from..to|branch>"
---
Buat daftar perubahan (changelog) dari riwayat git berikut: $@

## Cara Menentukan Sumber Perubahan

Tentukan mode dari argumen di atas tanpa bertanya ulang kecuali argumen kosong:

1. **Satu SHA** (contoh: `a1b2c3d`): baca hanya commit tersebut.
   - `git show --stat <sha>` lalu `git show <sha> --format=`
2. **Rentang SHA** (contoh: `a1b2c3d..e4f5g6h`, `a1b2c3d...e4f5g6h`, atau `a1b2c3d e4f5g6h`): baca hanya perubahan dalam rentang tersebut.
   - `git log --oneline <from>.. <to>` lalu `git diff <from>..<to> --stat` dan `git diff <from>..<to>`
3. **Nama branch tanpa SHA** (contoh: `feature/login`): baca sejak awal branch dibuat.
   - Tentukan base: `git merge-base <branch> main` (jika gagal, coba `master`, lalu `develop`).
   - Jika merge-base tidak ada (branch tanpa relasi), gunakan commit pertama branch: `git log --reverse --format=%H <branch> | head -1`.
   - Lalu: `git log --oneline <base>..<branch>` dan `git diff <base>..<branch> --stat` + diff isi bila perlu.
   - Jangan sertakan perubahan dari base branch itu sendiri.

Jika argumen kosong, beri tahu pengguna cara pakai dan berhenti:
`/generate-changelog <sha> | <from>..<to> | <branch>`

Gunakan shell tool yang tersedia (`powershell` di Windows, `bash` di Unix) untuk perintah `git` di atas. Jangan memanggil `git` sebagai nama tool.

## Aturan Penulisan (Wajib)

1. **Tulis seolah perubahan adalah hal baru, bukan data historis.** Dilarang menyebut SHA, hash, nama author, tanggal commit, atau frasa seperti "pada commit", "riwayat", "telah dilakukan pada". Tulis dalam bentuk kini: "Menambahkan...", "Memperbaiki...", "Mengubah...".
2. **Bahasa Indonesia formal** untuk seluruh narasi. **Bahasa Inggris hanya untuk tech term** (contoh: `endpoint`, `request`, `cache`, `query`, `middleware`, nama fungsi/kelas/variabel, nama file). Jangan terjemahkan tech term ke Bahasa Indonesia.
3. Kelompokkan hasil bila relevan: **Ditambahkan**, **Diperbaiki**, **Diubah**, **Dihapus**. Lewati kelompok yang kosong. Jika perubahan kecil/satu commit, satu daftar tanpa kelompok boleh dipakai.
4. Setiap poin menjelaskan **apa** dan **dampak/fungsi** secara singkat, tanpa detail diff mentah. Sebutkan nama file/komponen hanya jika membantu.

## Format Keluaran

```markdown
## Ringkasan
[satu paragraf singkat: apa yang berubah secara keseluruhan]

## Daftar Perubahan
### Ditambahkan
- Menambahkan [fitur/komponen] untuk [tujuan] pada [lokasi/tech term bila perlu].
### Diperbaiki
- Memperbaiki [masalah] sehingga [dampak].
### Diubah
- Mengubah [sebelumnya menjadi apa] untuk [alasan].
### Dihapus
- Menghapus [hal yang dihapus] karena [alasan].
```
