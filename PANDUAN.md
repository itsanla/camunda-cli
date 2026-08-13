# Panduan camunda-cli

Alat baris perintah untuk Camunda 7 self-hosted. Dibuat untuk dua pekerjaan yang paling
memakan waktu saat mengembangkan BPMN: **memahami model yang sudah ter-deploy**, dan
**mencari tahu kenapa sebuah instance macet**.

Dokumen ini disusun per kasus nyata, bukan per perintah. Untuk daftar opsi lengkap tiap
perintah, jalankan `camunda <perintah> --help`.

---

## Pasang dan masuk

```bash
npm install -g camunda-cli
camunda login https://camunda.contoh.com
```

URL boleh tanpa `/engine-rest`, akan ditambahkan otomatis. Username dan password ditanyakan
lewat prompt (jangan ditulis di baris perintah supaya tidak masuk riwayat shell).

Kredensial disimpan di `~/.config/camunda-cli/config.json` dengan permission `0600`. Camunda 7
memakai HTTP Basic Auth di setiap request dan tidak punya token sesi, jadi yang disimpan
memang password, dan hanya dikirim ke engine yang kamu konfigurasi.

Cek sambungan kapan saja:

```bash
camunda whoami
```

**Publish tidak memperbarui yang sudah terpasang.** Setelah versi baru rilis, jalankan lagi
`npm install -g camunda-cli`, lalu pastikan dengan `camunda --version`.

---

## Kasus 1: memeriksa model sebelum di-deploy

Ini kebiasaan yang paling menghemat waktu. Kondisi gateway, form field, dan wiring addon
hanya ada di dalam XML BPMN, tidak ada endpoint REST-nya, jadi tanpa alat ini satu-satunya
cara mengetahuinya adalah membaca XML mentah.

```bash
camunda lint ./proses-saya.bpmn      # file lokal, tanpa engine, tanpa login
camunda lint Process_PengajuanCuti   # versi yang sudah ter-deploy
```

Severity dipisah dengan sengaja:

- **ERROR** hanya untuk yang **terbukti rusak dari modelnya sendiri**. `camunda deploy`
  menolak model yang punya error.
- **WARNING** untuk risiko yang butuh penilaianmu, karena modelnya sendiri tidak cukup untuk
  membuktikan salah atau benar.
- **INFO** untuk catatan, disembunyikan kecuali pakai `--all`.

Kalibrasi ini diuji ke 190 model produksi nyata: nol error, nol deploy terblokir, sementara
model yang memang dibuat rusak tetap menghasilkan dua error.

### Yang ditangkap sebagai ERROR

| Aturan | Artinya |
|---|---|
| `uncovered-value` | Gateway bercabang `> N` dan `< N`, jadi nilai tepat `N` tidak ke mana-mana. Engine melempar `ENGINE-02004` dan instance berhenti. |
| `default-flow-with-condition` | Flow yang ditandai default tapi masih punya kondisi. Engine menolak model ini saat deploy dengan `ENGINE-09005`. |
| `variable-name-mismatch` | Form menulis satu variabel yang tidak dibaca siapa pun, sementara kondisi di hilirnya membaca variabel yang tidak ditulis siapa pun. Menyelesaikan elemen itu tidak akan pernah memenuhi kondisinya. |
| `dangling-flow`, `dangling-boundary`, `no-start-event` | Menunjuk elemen yang tidak ada. |

### Yang ditangkap sebagai WARNING

`no-default-flow` (semua cabang berkondisi tanpa fallback), `unwritten-variable` (membaca
`${x}` yang tidak ditulis siapa pun di model ini), `initiator-expression`, `no-op-service-task`
(service task tanpa implementasi), `addon-without-config`, `unreachable`, `dead-end`,
`ambiguous-branch`.

### Melihat isi model

```bash
camunda inspect Process_PengajuanCuti
camunda inspect ./proses-saya.bpmn
```

Menampilkan semua elemen beserta penanda async, assignee, addon yang dipanggil, jumlah form
field, dan **berapa instance yang sedang berada di elemen itu**; lalu seluruh sequence flow
dengan kondisinya; lalu form field per elemen; lalu daftar integrasi.

---

## Kasus 2: menguji proses dari awal sampai selesai

```bash
camunda start Process_PengajuanCuti --var initiator=budi@contoh.com -b UJI-1
```

Yang muncul:

```
Started Process_PengajuanCuti v3 as instance 3441986
business key UJI-1

Now waiting at:
    3442065  Review Leave Request  budi@contoh.com
camunda complete 3442065 --var catatan=<value>
```

`start` **tidak berhenti di "berhasil dikirim"**. HTTP 200 dari engine cuma berarti perintahnya
diterima; apa pun yang ditandai async baru berjalan setelah respons. Jadi `start` menunggu
sebentar lalu melaporkan salah satu dari tiga: gagal, selesai, atau sedang menunggu di task
mana beserta perintah persis untuk menyelesaikannya.

Lanjutkan dengan menyalin perintah yang disarankan:

```bash
camunda complete 3442065 --var catatan=ok
```

```
Task 3442065 completed.
Instance 3441986 finished in 3.6s.
```

Kalau proses masih berjalan, `complete` menampilkan task berikutnya. Jadi menggiring proses
tiga langkah cukup tiga perintah, tanpa perlu mencari-cari sendiri.

### Menemukan task lewat business key

```bash
camunda tasks -b UJI-1
```

Business key itu pegangan yang kamu tentukan sendiri saat `start`, jadi bisa dipakai langsung
tanpa perlu tahu instance id.

### Tipe variabel itu penting

```bash
--var jumlah=300              # String, dan "300" > 200 dibandingkan sebagai teks
--var jumlah=300:Integer      # angka sungguhan
--var aktif=true:Boolean
--var data:='{"a":1}'         # JSON
```

Kalau gateway membandingkan secara numerik, salah tipe membuat kondisinya berperilaku aneh
tanpa error.

### Membersihkan setelah menguji

```bash
camunda cancel --key Process_PengajuanCuti          # semua instance proses itu
camunda cancel 3441986                              # satu instance
camunda cancel --key Process_X -y -r "bersih-bersih" # tanpa konfirmasi
```

Menguji meninggalkan banyak instance menggantung. Tanpa `-y` akan diminta konfirmasi.

---

## Kasus 3: instance macet atau gagal

Satu perintah untuk semuanya:

```bash
camunda diagnose 3441986
```

Ini membaca lebih banyak daripada sekadar `/incident`, karena beberapa bentuk kegagalan tidak
terlihat di sana:

- Langkah yang gagal **di dalam transaksi pemanggilnya** tidak meninggalkan incident maupun
  job sama sekali; satu-satunya jejak ada di historic job log, atau tidak ada sama sekali.
- Incident menunjuk activity tempat job menempel, yang **sering bukan** activity yang error.
  `diagnose` membedakan keduanya secara eksplisit.
- Incident yang sudah teratasi hilang dari `/incident`.

Contoh keluaran:

```
Stopped at
    Activity_CekSisaKuota  transition  Check Remaining Quota

1 problem(s)

  open incident at 2026-08-13 08:19:33
  failing element: Activity_TinjauPengajuan
  job attached to:  Activity_CekSisaKuota  (the async marker sits here, the error came from
                    the element above)
  Unknown property used in expression: ${initiator}. Cause: Cannot resolve identifier 'initiator'

  The variable "initiator" is injected by AlurKerja when a process is started through its own
  API. Starting the same process straight through the Camunda REST API skips that...
```

Exit code-nya **1 kalau ada yang sedang rusak, 0 kalau sehat**, jadi bisa dipakai di skrip.

Instance yang pernah gagal lalu pulih dilaporkan **sehat**, dengan riwayat kegagalannya
ditampilkan terpisah sebagai konteks, bukan sebagai vonis.

### Error addon yang bersarang

Kegagalan addon datang sebagai pesan REST yang membungkus exception Java yang membungkus
`body: {json}` yang field `output`-nya berisi JSON lagi. Kalimat yang benar-benar berguna ada
di lapisan paling dalam, jadi itulah yang ditampilkan paling atas:

```
sales_name kosong. Pastikan form Submit-Weekly-Report benar-benar mengisi variabel ini
sebelum service task ini berjalan.

integration response:
  { "details": "script exited with code 1", ... }

script output:
  { "status": "error", "message": "sales_name kosong...", ... }
```

Ini berlaku baik di `diagnose` maupun saat `complete` gagal.

### Perintah pendukung

```bash
camunda trace 3441986        # setiap langkah yang dilalui, urut sesuai eksekusi engine
camunda vars 3441986         # variabel saat ini
camunda vars 3441986 -H      # setiap perubahan variabel beserta waktunya
camunda jobs -i 3441986 -f   # job yang gagal
camunda stacktrace <jobId>   # stack trace, frame internal engine disaring
camunda incidents -k Process_X        # incident yang terbuka
camunda incidents -k Process_X -H     # termasuk yang sudah teratasi
camunda stats Process_X               # instance menumpuk di elemen mana
```

`trace` diurutkan memakai urutan eksekusi milik engine, bukan timestamp. Gateway dan event di
sekitarnya sering berbagi milidetik yang sama, dan mengurutkan pakai waktu membuat urutannya
acak.

---

## Kasus 4: memperbaiki instance yang gagal tanpa mengulang dari awal

Ini alur sehari-hari saat mengembangkan addon: script-nya salah, instance gagal, script
diperbaiki, lalu ingin melanjutkan instance yang sudah jalan.

```bash
camunda jobs -i 3441986 --failed          # cari job yang gagal
camunda set-var 3441986 initiator=budi@contoh.com   # perbaiki datanya
camunda retry 3441988 --now               # jalankan ulang job itu sekarang
camunda diagnose 3441986                  # pastikan benar-benar pulih
```

`retry` mengembalikan jatah percobaan job supaya dijalankan lagi. Tanpa `--now`, job runner
yang akan mengambilnya beberapa saat kemudian.

Kalau yang salah adalah **kodenya** (script addon, konfigurasi listener), jangan retry job di
instance yang sama untuk menguji perbaikannya: data yang terlanjur dihasilkan run sebelumnya
sudah tersimpan di variabel instance itu dan tidak akan dibuat ulang. Mulai instance baru.
Retry di tempat hanya masuk akal untuk yang sifatnya sementara (jaringan, service luar yang
sedang mati) atau kalau yang diperbaiki memang datanya.

---

## Kasus 5: mesin dengan banyak tenant

Di engine bersama, satu process key yang sama ada di banyak tenant. Endpoint bawaan Camunda
menjawab *"no matching process definition ... and no tenant-id"*, yang terbaca seolah prosesnya
tidak ada padahal ada.

```bash
camunda tenants -s Telco                 # cari id tenant dari namanya
camunda definitions -k Contract -t <tenantId> -l
camunda inspect Process_X -t <tenantId>
```

Kalau sebuah key ambigu, perintahnya tidak menebak, melainkan menampilkan kandidatnya:

```
"V2-Contract-Lifecycle-Management" exists in 3 tenants. Narrow it with --tenant <id>, or
pass the full definition id:
  V2-Contract-...:103:2794600  tenant=ef93ab58-...  version=103
  ...
```

---

## Kasus 6: deploy

```bash
camunda deploy ./proses.bpmn -t <tenantId> -n "nama deployment"
```

`deploy` menjalankan pemeriksaan yang sama dengan `lint` dan **menolak model yang punya error**.
Pakai `--skip-lint` untuk memaksa.

Kalau isinya identik dengan yang sudah ter-deploy, Camunda tidak membuat versi baru dan
perintahnya memberi tahu hal itu, bukan diam-diam sukses.

```bash
camunda deployments               # deployment terbaru
camunda undeploy <deploymentId>   # hapus (pakai --cascade untuk ikut instance & history)
```

---

## Dipakai dari skrip atau agent AI

Setiap perintah menerima `--json` untuk mengeluarkan payload API mentah:

```bash
camunda tasks -b UJI-1 --json
camunda lint Process_X --json
camunda diagnose 3441986 --json
```

Keluaran biasa juga sudah aman dibaca mesin: tidak ada karakter garis kotak, dan warna hanya
muncul kalau stdout benar-benar terminal. Kolomnya dirapikan dengan spasi biasa.

Exit code: `0` berhasil, `1` gagal atau ada temuan error.

---

## Hal-hal yang menghemat waktu

**401 yang muncul acak.** Engine di belakang load balancer kadang menolak kredensial yang
benar saat satu replika sedang tidak sehat: pernah teramati 5 kali gagal lalu 5 kali berhasil
berturut-turut, kredensial sama, jeda setengah detik. Request diulang otomatis supaya ini
tidak terbaca sebagai password salah. Error 4xx yang membawa pesan Camunda asli tidak pernah
diulang, karena itu jawaban sungguhan.

**`${initiator}` kosong kalau start dari CLI.** AlurKerja mengisi variabel itu saat proses
dimulai lewat API-nya sendiri. Start langsung ke Camunda melewatkannya, jadi elemen yang
memakai `${initiator}` (biasanya assignee) gagal begitu tercapai. Tambahkan
`--var initiator=<userId>` saat menguji dari CLI.

**Form micro-frontend menulis variabel yang tidak terlihat di model.** Field bertipe
`EXTERNAL_MICRO_FRONTEND_FORM` namanya cuma titik pasang; MFE-nya bisa menulis variabel apa
pun tanpa dideklarasikan di BPMN. Jadi `unwritten-variable` di proses seperti itu wajar dan
belum tentu bug.

---

## Yang sengaja tidak dicakup

Evaluasi DMN, operasi batch, migrasi dan modifikasi instance, serta manajemen authorization.
Ini keputusan sadar, bukan kelalaian: cakupan perintah di sini mengikuti apa yang benar-benar
berulang saat mengembangkan dan men-debug proses, bukan seluruh 300-an endpoint REST Camunda.
