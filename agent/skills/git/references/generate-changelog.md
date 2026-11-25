# Generate Changelog

Daftar perubahan dari riwayat git, dalam Bahasa Indonesia formal.

## Sumber Perubahan

Tentukan mode dari argumen tanpa bertanya ulang; argumen kosong berarti beri tahu cara pakai lalu berhenti:

`/skill:git generate-changelog <sha> | <from>..<to> | <branch>`

1. **Satu SHA** — `git show --stat <sha>`, lalu `git show <sha> --format=`.
2. **Rentang** — `<from>..<to>`, `<from>...<to>`, atau `<from> <to>`: `git log --oneline <from>..<to>`, lalu `git diff <from>..<to> --stat` dan isi diffnya.
3. **Branch tanpa SHA** — base dari `git merge-base <branch> main`, fallback `master` lalu `develop`; tanpa relasi, commit pertama branch (`git log --reverse --format=%H <branch>` baris pertama). Lalu `git log --oneline <base>..<branch>` dan `git diff <base>..<branch>`. Perubahan dari base branch tidak termasuk.

## Aturan Penulisan

1. Tulis seolah perubahan adalah hal baru, bukan data historis: tanpa SHA, hash, author, tanggal, atau frasa seperti "pada commit", "riwayat", "telah dilakukan pada". Bentuk kini: "Menambahkan...", "Memperbaiki...", "Mengubah...".
2. Bahasa Indonesia formal untuk narasi. Bahasa Inggris hanya untuk tech term (`endpoint`, `cache`, `query`, `middleware`, nama fungsi/kelas/variabel, nama file) — jangan diterjemahkan.
3. Kelompokkan bila relevan: **Ditambahkan**, **Diperbaiki**, **Diubah**, **Dihapus**; lewati kelompok yang kosong. Perubahan kecil atau satu commit boleh satu daftar tanpa kelompok.
4. Setiap poin menyebut **apa** dan **dampak/fungsinya** secara singkat, tanpa detail diff mentah. Nama file atau komponen hanya bila membantu.

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
