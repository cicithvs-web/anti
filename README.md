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
| `PORT` | `3000` | Port server |

Endpoint sandbox:

- `GET /api/sandbox/status?chatId=<id>` — status container chat
- `POST /api/sandbox/reset` `{ "chatId": "<id>" }` — hapus container (dibuat ulang otomatis saat chat berikutnya)

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
