# Recall Parent History dari Child Subagent

Status: TODO

## Masalah

Child subagent mulai dari session kosong. Tool `recall` milik child hanya membaca `ctx.sessionManager` miliknya sendiri (`blackhole/index.ts`) — jadi child tidak bisa drill-down ke history parent (`#N` expand, isi file di entry tertentu, hex-ID observasi parent). Snapshot VCC (lihat `pass parent context window via vcc blackhole.md`) menutup ~90% kebutuhan, tapi bukan pengganti drill-down dalam.

## Desain

Jangan minta model mengisi `parent_session_id` manual — rapuh (model harus copy opaque id). Carrier-nya dispatcher, bukan model:

1. **Session-map di dispatcher.** Tepat setelah `createAgentSession` return di `runAttempt` (`subagents/src/run.ts`), catat `Map<childSessionId, parentSessionId>`. Hapus di `finally { session.dispose() }` yang sudah ada. ~15 baris.
2. **`recall` resolve identitas saat eksekusi.** Kunci map dengan `ctx.sessionManager.getSessionId()`. Param opsional `source: current | parent` sebagai override; default tetap `current` — parent selalu eksplisit, tidak pernah implisit.
3. **Dua jalur baca:**
   - Observasi/refleksi parent (hex-ID): gratis — `readPendingState(parentSessionId)` baca file JSON di disk, sudah works lintas session (`blackhole/om.ts`).
   - Full history + `touched files` parent: baca via registry manager yang masih hidup di memory. Bisa karena child dan parent satu proses (`createAgentSession` me-load extension yang sama, `sdk.js`), dan parent sedang blocked nunggu hasil — live-read ≈ frozen read, tidak ada divergensi T0.

## Yang Tidak Perlu

- Frozen-file copy (`<childId>-parent.json` di disk). Redundan: parent yang blocked sudah de facto frozen. Tambah I/O + cap management tanpa pembeli.
- Background worker / state live bersama. Eksekusi tetap sinkron seperti hari ini.

## Sinyal Kebutuhan

Implement ini kalau observasi menunjukkan child sering mentok ("snapshot tidak cukup") padahal info ada di parent history. Kalau snapshot selalu cukup, file ini tetap TODO.

## Acceptance Criteria

- [ ] Default `recall` tetap membaca session sendiri (backward compatible).
- [ ] `source=parent` membaca history + OM parent, tanpa mengubah session mana pun.
- [ ] Tidak ada id yang harus dihafal/dicopy model — pemetaan dipegang dispatcher.
- [ ] Cap 4000 chars yang sudah ada berlaku untuk hasil parent.
- [ ] Map dibersihkan saat child dispose (tidak ada leak antar run).

## Hubungan dengan PR Snapshot

File `pass parent context window via vcc blackhole.md` = konteks datar saat delegasi. File ini = drill-down dalam saat dibutuhkan. Keduanya independen — urutan eksekusi bisa dioptimalkan nanti.
