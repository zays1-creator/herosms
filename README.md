# Hero SMS Telegram Bot

Bot Telegram sederhana untuk request nomor via API Hero SMS (format SMS-Activate compatible).

## 1) Install dependency

```powershell
npm install
```

## 2) Konfigurasi

```powershell
Copy-Item .env.example .env
```

Isi nilai di `.env`:
- `TELEGRAM_BOT_TOKEN` (minimal wajib)
- `HERO_BASE_URL` (default: `https://hero-sms.com`)
- `HERO_REQUEST_PATH` (default: `/stubs/handler_api.php`)
- `HERO_API_KEY` (opsional fallback jika user belum set key via bot)
- (opsional) `HERO_ACTION_GET_NUMBER`, `HERO_ACTION_GET_PRICES`, `HERO_ACTION_GET_STATUS`, `HERO_ACTION_GET_ACTIVE_ACTIVATIONS`, `HERO_TIMEOUT_MS`
- (opsional auto OTP) `OTP_POLL_INTERVAL_MS` (default: `5000`)
- (opsional copy button) `ENABLE_COPY_BUTTONS` (default: `0`, set `1` untuk tombol copy pada notifikasi OTP)
- (opsional menu) `MENU_SERVICE` (default: `wa`), `MENU_SERVICE_FALLBACKS` (default: kosong), `ALLOWED_MENU_SERVICES` (default: `wa`), `MENU_COUNTRY_PHILIPPINES` (default: `4`), `MENU_COUNTRY_LABEL` (default: `Philippines +63`)

## 3) Jalankan bot

```powershell
npm start
```

Mode minimal: cukup set `TELEGRAM_BOT_TOKEN`, lalu tiap user pakai `/setkey <api_key>`.

## Command

- `/setkey <api_key>` set API key untuk chat ini (disimpan lokal)
- `/buy` untuk langsung spam buy 10 nomor WhatsApp Philippines
- `/order <country> [max_price]` untuk order manual 1 nomor WhatsApp
- `/otpall` untuk cek OTP semua nomor hasil buy yang tersimpan per chat
- `/otp <nomor_urut>` untuk cek OTP per nomor sesuai urutan list
- `/checkwa` untuk cek live status WA dari API bot
- `/listbuy` untuk cek nomor WA aktif yang sudah kebeli di akun (global akun, bukan per chat)
- `/ceksaldo` cek saldo akun dari API key chat
- `/restockon` aktifkan alert restock WA
- `/restockoff` matikan alert restock WA
  - status subscribe restock disimpan ke `restock_watchers.json` agar tetap aktif setelah restart bot
  - API key per chat disimpan ke `chat_api_keys.json`

## Auto OTP

Setelah nomor berhasil dibeli, bot akan otomatis polling status OTP dan kirim pesan ke chat saat OTP masuk tanpa perlu klik menu/command.

## Ketentuan Harga Buy

Buy dikunci ke range `0.16 - 0.18` dan pemilihan harga dilakukan random berdasarkan stok yang tersedia di range tersebut.

## Catatan penting

OpenAPI resmi yang kamu download (`api___en.json`) menunjukkan endpoint kompatibel SMS-Activate ada di `/stubs/handler_api.php` dengan action query (`getNumber`, `getStatus`, `setStatus`, dst).
