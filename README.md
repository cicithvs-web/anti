# AntiGPT — antarmuka chat bergaya Claude

Antarmuka chat mobile-first bergaya Claude (React + Vite) dengan backend Express yang
menjalankan **Antigravity CLI (`agy`)** di dalam **sandbox Docker terisolasi per chat** —
jadi `agy` bebas meng-install apa pun dan menjalankan perintah apa pun tanpa pernah
menyentuh server host.

## Arsitektur

```
[Browser] ──> [server/server.js di host (node/pm2)]
                        │  docker exec
                        ▼
              antigpt-sandbox-<slug>   (1 container per chat)
               ├─ /home/AntiGPT  ← bind: server/sessions/<slug>   (workspace chat)
               └─ /root/.gemini  ← bind: server/sandbox-data/gemini (token + riwayat)
```

- Image sandbox dibangun otomatis dari `server/Dockerfile.sandbox` (ubuntu:24.04 + Python3,
  Node 22, build-essential, dst. + Antigravity CLI) saat pertama kali dipakai.
- Container dibatasi `--memory 2048m --cpus 2.0 --pids-limit 512` dan dibuat ulang
  otomatis jika hilang/dihapus.
- Seluruh state `agy` (token OAuth, conversations, history) di-share lewat satu folder
  host, jadi login tetap terbaca meski container di-reset.

## Menjalankan secara lokal

Backend (terminal 1):

```bash
npm install
node server/server.js          # API + frontend statis di http://localhost:3000
```

Frontend mode dev (terminal 2, hot-reload):

```bash
npm run dev                    # default http://localhost:5173
```

> Saat mode dev, API dijalankan terpisah (port 3000). Buat `.env.local` berisi
> `VITE_API_BASE=http://localhost:3000` agar frontend mengarah ke backend.

## Build untuk production

```bash
npm run build
```

Hasil build ada di folder `dist/`. Server otomatis menyajikan `dist/` di port `3000`,
jadi satu proses `node server/server.js` sudah cukup untuk production (cocok dijalankan
via pm2/systemd). Untuk preview hasil build saja:

```bash
npm run preview
```

## Sandbox Docker

Prasyarat: `docker` terpasang dan bisa dipanggil oleh user yang menjalankan server.

```bash
# Opsional — pre-build image (kalau tidak, otomatis dibangun saat pertama dipakai)
docker build -f server/Dockerfile.sandbox -t antigpt-sandbox:latest server/
```

> Jika build image gagal (mis. jaringan), server memakai image fallback `antigpt-sandbox:fallback`
> (ubuntu polos, `curl` dan agy dipasang saat container dibuat). Tag `latest` tidak pernah diisi
> image polos, jadi build image lengkap otomatis dicoba lagi pada permintaan berikutnya.

Variabel environment opsional:

| Variabel | Default | Keterangan |
|---|---|---|
| `AGY_SANDBOX_IMAGE` | `antigpt-sandbox:latest` | Image sandbox |
| `AGY_SANDBOX_HOME` | `/home/AntiGPT` | Path workspace di dalam container |
| `AGY_SANDBOX_MEMORY` | `2048m` | Limit RAM container |
| `AGY_SANDBOX_CPUS` | `2.0` | Limit CPU container |
| `AGY_SANDBOX_PIDS` | `512` | Limit jumlah proses |
| `AGY_TOKEN_FILE` | `server/sandbox-data/gemini/antigravity-cli/antigravity-oauth-token` | Lokasi token OAuth |
| `AGY_SANDBOX_IDLE_MIN` | `30` | Menit idle sebelum container chat di-`docker stop` (0 = nonaktif). Di-start lagi otomatis saat dipakai |
| `AGY_MODE` | `acp` | Mode eksekusi chat: `acp` (default, dukung popup `ask_question` & teks berpikir) atau `print` (cadangan `-p`) |
| `AGY_PROMPT_IDLE_MIN` | `10` | Menit diam tanpa aktivitas/output sebelum 1 eksekusi AI dianggap macet & dihentikan (0 = nonaktif) |
| `AGY_PROMPT_MAX_MIN` | `60` | Batas maksimal total durasi 1 giliran eksekusi AI dalam menit (0 = nonaktif) |
| `AGY_QUESTION_TIMEOUT_MIN` | `30` | Batas menit menunggu jawaban popup `ask_question` sebelum dilewati otomatis (0 = tanpa batas) |
| `AGY_MAX_PARALLEL` | `2` | Jumlah chat yang bisa diproses bersamaan |
| `AUTH_TOKEN` | — | Token akses web/API (lihat bagian Token akses) |
| `ADMIN_TOKEN` | — | Opsional. Kunci khusus admin untuk mengelola akun (login/ganti akun/logout) & reset sandbox |
| `MAX_UPLOAD_FILES` | `20` | Maksimal jumlah file lampiran per kirim |
| `MAX_UPLOAD_MB` | `100` | Maksimal ukuran per file lampiran (MB) |
| `PORT` | `3000` | Port server |

Endpoint chat:

- `POST /api/chat/stream` — mulai job (NDJSON). Job **tidak** berhenti kalau koneksi putus/refresh
- `GET /api/chat/stream?chatId=<id>&since=<seq>` — sambung ulang & replay event job
- `POST /api/chat/answer` `{ "chatId": "<id>", "questionId": "<qid>", "answers": { ... } }` — jawab atau lewati (`skip: true`) popup `ask_question`
- `POST /api/chat/stop` `{ "chatId": "<id>" }` — hentikan proses agy chat tersebut
- `DELETE /api/chats/<id>` — hapus chat: stop job, hapus container sandbox, folder sesi, dan riwayat internal `agy` (`conversations/`, `brain/`, `annotations/`, `presence/`)

Endpoint sandbox:

- `GET /api/sandbox/status?chatId=<id>` — status container chat
- `POST /api/sandbox/reset` `{ "chatId": "<id>" }` — hapus container (dibuat ulang otomatis saat chat berikutnya)

## Token akses (wajib)

Semua endpoint `/api/*` dikunci token. Buat file `.env` di root proyek (contoh di `.env.example`):

```bash
AUTH_TOKEN=token-acak-yang-panjang
```

Saat membuka aplikasi, browser akan meminta token sekali, lalu disimpan sebagai cookie httpOnly
(berlaku 1 tahun). Untuk script/curl pakai header `Authorization: Bearer <token>`.
Jika `AUTH_TOKEN` kosong, server membuat token sementara (dicetak di log, berubah tiap restart).
Salah token > 10x dalam 15 menit per IP → diblokir sementara.

Jika `ADMIN_TOKEN` diisi di `.env`, pengelolaan akun (Login, Ganti akun, Logout, dan `POST /api/sandbox/reset`) dikunci khusus pemegang `ADMIN_TOKEN`. Masuk dengan `ADMIN_TOKEN` di layar login awal otomatis membuka akses chat sekaligus admin; user biasa (pakai `AUTH_TOKEN`) tetap bisa chatting dan melihat email akun (read-only), serta bisa membuka kunci admin kapan saja dari menu **Akun** (atau lewat header `X-Admin-Token` / `Authorization: Bearer <ADMIN_TOKEN>`).

## Login

Buka menu **Akun → Login dengan Google** di aplikasi. Proses login interaktif dijalankan
di dalam sandbox; token tersimpan di `server/sandbox-data/gemini/` (jangan di-commit —
sudah di-gitignore). Untuk memindahkan login dari instalasi lama, cukup salin:

```bash
mkdir -p server/sandbox-data && cp -a ~/.gemini server/sandbox-data/gemini
```

## Struktur

- `src/App.jsx` — komponen utama & state chat
- `src/App.css` — seluruh styling (termasuk animasi ripple, bottom sheet, textarea auto-grow)
- `src/components/` — komponen UI (input, drawer, pesan, dsb.)
- `src/hooks/` — custom hooks
- `src/services/` — integrasi API
- `src/data/` — data statis
- `server/server.js` — backend Express (API chat, upload, login, sandbox endpoints)
- `server/agy.js` — logic inti agy (prompt, stream, models, quota, login) via sandbox
- `server/sandboxManager.js` — manajemen container Docker sandbox per chat
- `server/Dockerfile.sandbox` — definisi image sandbox (Ubuntu 24.04 + tools + Antigravity CLI)
- `server/.dockerignore` — mengecualikan `sessions/` dan `sandbox-data/` (token OAuth) dari build context
- `server/sessions/` — workspace per chat (`AGENTS.md`, `project/`, `state.json`)
- `server/sandbox-data/` — state agy yang persisten (token OAuth, conversations)
