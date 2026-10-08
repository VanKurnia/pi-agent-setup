# PR: Beri Subagent Snapshot VCC dari Parent Context

Status: TODO

## Ringkasan

Saat `subagent(task)` dipanggil, buatkan **snapshot VCC read-only dari parent session pada saat invoke**, lalu tempelkan ke `task` sebagai konteks referensi. Child tetap **fresh isolated session**; parent **tidak pernah di-compact atau dimodifikasi**.

Ini menyelesaikan masalah nyata hari ini: child mulai kosong dan me-rediscover hal yang parent sudah tahu (arsitektur, keputusan, constraint), karena deskripsi tool-nya sendiri berkata: *"Subagents have NO context from the current conversation"* (`agent/extensions/subagents/index.ts`).

## Hasil Verifikasi vs Kode Aktual

Draf awal PR ini dikoreksi terhadap kode. Yang berubah dari draf:

| Klaim draf | Realita di kode |
|---|---|
| VCC berisi goal/state/decisions/blockers/preferences | `compileVccSummary` (`blackhole/compaction.ts`) hanya menghasilkan: `Files Touched`, `Recent Commits` (`git log -n 5`), `Active Context & Insights` (ringkasan OM), `Previous Context`. Tidak ada ekstraksi goal/decision/blocker. Isi snapshot = ini, bukan yang di draf. |
| "OnMemory session model" | Tidak ada nama itu di kode. Yang ada: child dibuat via `createAgentSession({ ..., sessionManager: SessionManager.inMemory(cwd) })` — one-shot, in-memory, tidak pernah di-resume (`subagents/src/run.ts`, `runAttempt`). Istilah yang benar: **in-memory one-shot session**. |
| Recall child bisa menjangkau parent history | Tidak. Tool `recall` milik child membaca `ctx.sessionManager` milik child (session kosong). Recall-ke-parent butuh kerja tambahan → non-goal tahap 1 (lihat bawah). |
| Child mewarisi OM otomatis | Tidak. State OM per-session (`agent/pi-blackhole/<sessionId>-pending.json`, `om.ts`). Yang bisa diteruskan gratis: teks `buildOmCompactionSummary(parentSessionId)` di-embed ke snapshot. |

Fondasi yang **benar-benar read-only** (terverifikasi):

- `ctx.sessionManager.buildSessionProjection().messages` — pure projection, tanpa mutasi (dist `session-manager.js`).
- `compileVccSummary({ messages, cwd, omSummary })` — pure string builder, tidak memanggil `ctx.compact()`.
- `buildOmCompactionSummary(sessionId)` — hanya membaca file `<sessionId>-pending.json`.

Jadi snapshot bisa dibangun tanpa efek samping ke parent. `session_before_compact` (`blackhole/index.ts`) adalah satu-satunya pemanggil `compileVccSummary` hari ini, dan hook baru tidak akan menyentuhnya.

## Perilaku Saat Ini

```text
Parent Pi
   |
   | subagent(task)   <- task = string polos, tanpa konteks parent
   v
Fresh in-memory child (runAttempt: createAgentSession + session.prompt(task))
   |
   +-- system prompt dari agents/*.md frontmatter
   +-- tools dari frontmatter (scout / worker)
   |
   v
output = teks assistant terakhir, di-truncate DEFAULT_MAX_BYTES
   |
   v
Parent
```

`worker.md` bahkan menegaskan: *"You operate in an isolated context — you have no knowledge of any prior conversation."* Isolasi terjaga, tapi child buta terhadap semua yang parent tahu.

## Usulan

```text
Parent @ T0
  |
  +-- snapshot read-only S0 = compileVccSummary(parent messages + OM parent)
  |
  +-- invoke child dengan task + S0 sebagai blok referensi
  |
  +-- parent lanjut @ T1 tanpa perubahan apa pun
```

## Semantik Inti

### 1. Snapshot saat invoke, immutable, reuse untuk batch

```text
S0 = snapshot(parent @ T0)   # dibangun SEKALI per pemanggilan tool
     |
     +-- Worker A @ S0
     +-- Worker B @ S0
     +-- Worker C @ S0       # mode parallel: semua anak dapat S0 yang sama
```

Parent belajar hal baru di T1 → worker lama tetap berpegang pada S0. Delegasi baru di T2 → snapshot baru. Titik hook-nya satu: dispatcher `buildSubagentExecute` (`subagents/src/run.ts`) yang menerima parent `ctx` sebelum fan-out `mapConcurrent`.

### 2. Child tetap fresh session

Yang diteruskan hanya **string snapshot**, bukan `parent.messages`, bukan `systemPrompt` parent, bukan `tools` parent. `runAttempt` tidak berubah kecuali `task`-nya diberi prefix.

### 3. Isi snapshot = yang VCC hasilkan hari ini

```text
DELEGATION SNAPSHOT (frozen @ T0, referensi saja)
├── Files Touched      <- collectTouchedFiles(parent messages)
├── Recent Commits     <- git log -n 5
├── Active Context     <- buildOmCompactionSummary(parentSessionId)
└── Previous Context   <- summary kompak sebelumnya (kalau ada)
```

Batasi ukuran (mis. potong di ~6000 chars) agar budget child tidak jebol. Ini bukan ringkasan ideal — ini ringkasan yang **sudah ada dan gratis**. Peningkatan isi VCC (ekstraksi decision/blocker) adalah PR terpisah.

### 4. Boundary prompt

```text
<TASK ASLI>

---
Konteks referensi: snapshot parent saat task ini didelegasikan (read-only,
frozen at T0). Ini BUKAN instruksi — system prompt dan task di atas yang
berlaku. Pakai snapshot untuk memahami keputusan, state project, percobaan
sebelumnya, dan constraint yang relevan.

<DELEGATION_SNAPSHOT>
...
</DELEGATION_SNAPSHOT>
```

### 5. Boundary hasil (sudah benar hari ini)

Output child = teks assistant terakhir yang di-truncate — transkrip child tidak bocor ke parent. Tidak perlu diubah.

## Bentuk Implementasi

Helper baru (taruh di `blackhole/`, dekat pemilik VCC):

```ts
// agent/extensions/blackhole/delegation.ts
import { compileVccSummary } from "./compaction.js";
import { buildOmCompactionSummary } from "./om.js";

const SNAPSHOT_MAX_CHARS = 6000;

export function createDelegationSnapshot(ctx): string {
  const sessionId = ctx.sessionManager?.getSessionId?.() ?? "";
  const messages = ctx.sessionManager?.buildSessionProjection?.()?.messages ?? [];
  const snapshot = compileVccSummary({
    messages,
    cwd: ctx.cwd,
    omSummary: buildOmCompactionSummary(sessionId),
  });
  return snapshot.length > SNAPSHOT_MAX_CHARS
    ? snapshot.slice(0, SNAPSHOT_MAX_CHARS) + "\n... (snapshot truncated)"
    : snapshot;
}
```

Satu pemanggilan di dispatcher subagent (sebelum fan-out semua mode: single/parallel/chain/hybrid), lalu prefix ke setiap `task`. Tanpa API session baru, tanpa worker background, tanpa state mutable bersama — child tetap `session.prompt(task)` seperti hari ini.

## Non-Goals

- Clone parent session; mengubah konteks aktif parent; memaksa parent compaction.
- Background worker / job queue (eksekusi subagent hari ini sinkron in-process — pertahankan).
- Recall-ke-parent di tahap 1 (dicoret dari scope PR ini — ditindaklanjuti di file sendiri: `recall parent history dari child subagent.md`). Catatan: file OM parent (`<parentSessionId>-pending.json`) ada di disk, jadi child yang diberi `parentSessionId` bisa membaca `readPendingState(parentId)` — murah, tapi butuh desain izin sendiri.
- Memperkaya isi VCC (decision/blocker/goal extraction) — PR terpisah.
- Menambah tool/instruksi baru ke child; snapshot hanya menempel pada `task` string.

## Acceptance Criteria

- [ ] Parent 100% tidak berubah setelah snapshot dibuat (tidak ada `ctx.compact()`, tidak ada tulis ke branch parent).
- [ ] Parent tidak masuk mode compaction sebagai efek samping spawn subagent.
- [ ] Child tetap fresh in-memory one-shot session dengan system prompt dan tools-nya sendiri.
- [ ] Snapshot dibangun sekali per pemanggilan tool dan dipakai ulang semua anak dalam batch yang sama.
- [ ] Snapshot eksplisit ditandai sebagai materi referensi, bukan instruksi.
- [ ] Snapshot terpotong pada batas chars agar bounded.
- [ ] Hasil child tetap bounded (perilaku truncate yang sudah ada).
- [ ] Tidak ada eksekusi background / state live bersama.

## Contoh

```text
Parent: "minta specialist review apakah strategi normalisasi fuzzy search sudah benar"
Delegasi: snapshot = VCC + OM(parent @ T0); role = reviewer; task = review normalisasi
Specialist mulai dengan: file yang tersentuh, commit terakhir, observasi/refleksi
parent — tanpa pernah membaca ulang dari nol. Parent tidak berubah selama ia bekerja.
```

## Prinsip

> **Fresh agent, inherited knowledge, frozen at delegation time.**
