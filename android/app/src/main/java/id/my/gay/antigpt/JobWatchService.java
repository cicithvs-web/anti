package id.my.gay.antigpt;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.webkit.CookieManager;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Service latar belakang ringan (tanpa WebView, tanpa Firebase) untuk memantau
 * stream job AntiGPT saat user keluar APK, lalu memunculkan notifikasi begitu AI
 * selesai menjawab atau mengirim pertanyaan interaktif.
 */
public class JobWatchService extends Service {

    public static final String CHANNEL_RUNNING = "antigpt_job_running";
    public static final String CHANNEL_RESULT = "antigpt_job_result";
    public static final String EXTRA_JOBS_JSON = "jobs_json";
    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_OPEN_CHAT_ID = "open_chat_id";

    private static final int FG_NOTIF_ID = 1001;
    private static final int ACCENT_COLOR = 0xFFC96442;
    private static final int MAX_RECONNECT_TRIES = 180;

    // Menyimpan chatId yang sudah selesai saat dipantau di background supaya MainActivity tidak memantau ulang
    private static final Set<String> finishedJobIds = ConcurrentHashMap.newKeySet();

    private final ConcurrentHashMap<String, WatchEntry> activeWatches = new ConcurrentHashMap<>();
    private final AtomicBoolean destroyed = new AtomicBoolean(false);
    private String authCookie = "";
    private volatile long lastFgUpdateMs = 0L;

    public static List<String> consumeFinishedJobIds() {
        List<String> out = new ArrayList<>(finishedJobIds);
        finishedJobIds.removeAll(out);
        return out;
    }

    public static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(NOTIFICATION_SERVICE);
        if (nm == null) return;

        NotificationChannel running = new NotificationChannel(
            CHANNEL_RUNNING,
            "Proses Latar Belakang",
            NotificationManager.IMPORTANCE_LOW
        );
        running.setDescription("Status senyap saat AntiGPT memproses tugas di latar belakang.");
        running.setShowBadge(false);
        running.enableVibration(false);
        running.setSound(null, null);
        nm.createNotificationChannel(running);

        NotificationChannel result = new NotificationChannel(
            CHANNEL_RESULT,
            "Jawaban & Pertanyaan AI",
            NotificationManager.IMPORTANCE_HIGH
        );
        result.setDescription("Notifikasi saat AntiGPT selesai menjawab atau membutuhkan jawabanmu.");
        result.setShowBadge(true);
        result.enableVibration(true);
        nm.createNotificationChannel(result);
    }

    public static int resultNotificationId(String chatId) {
        int h = chatId != null ? chatId.hashCode() : 0;
        return 2000 + Math.abs(h % 100000);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        ensureChannels(this);
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        if (destroyed.get()) return START_NOT_STICKY;

        String cookieExtra = intent != null ? intent.getStringExtra(EXTRA_COOKIE) : null;
        if (cookieExtra != null && !cookieExtra.isEmpty()) {
            authCookie = cookieExtra;
        } else if (authCookie.isEmpty()) {
            try {
                String cm = CookieManager.getInstance().getCookie(BuildConfig.APP_URL);
                if (cm != null) authCookie = cm;
            } catch (Exception ignored) {
            }
        }

        String jobsJson = intent != null ? intent.getStringExtra(EXTRA_JOBS_JSON) : null;
        List<WatchEntry> incoming = parseJobs(jobsJson);

        // Wajib langsung startForeground sebelum proses lain (aturan Android 12–15)
        startForegroundSafe(buildOngoingNotification(incoming.isEmpty() ? null : incoming.get(0), incoming.size()));

        if (incoming.isEmpty() && activeWatches.isEmpty()) {
            stopSelf();
            return START_NOT_STICKY;
        }

        for (WatchEntry entry : incoming) {
            WatchEntry existing = activeWatches.get(entry.chatId);
            if (existing != null) {
                existing.title = entry.title;
                if (entry.lastSeq > existing.lastSeq) existing.lastSeq = entry.lastSeq;
            } else {
                activeWatches.put(entry.chatId, entry);
                startWatcherThread(entry);
            }
        }

        updateOngoingNotification(true);
        return START_NOT_STICKY;
    }

    private void startForegroundSafe(Notification notif) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceCompat.startForeground(
                    this,
                    FG_NOTIF_ID,
                    notif,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                );
            } else {
                startForeground(FG_NOTIF_ID, notif);
            }
        } catch (Exception e) {
            stopSelf();
        }
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Batas waktu dataSync Android 15 (6 jam) — hentikan service dengan bersih agar tidak crash
        shutdownAll();
        stopSelf();
    }

    private List<WatchEntry> parseJobs(@Nullable String json) {
        List<WatchEntry> list = new ArrayList<>();
        if (json == null || json.isEmpty()) return list;
        try {
            JSONArray arr = new JSONArray(json);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String id = o.optString("id", "").trim();
                if (id.isEmpty()) continue;
                String title = o.optString("title", "").trim();
                int seq = o.optInt("seq", -1);
                list.add(new WatchEntry(id, title, seq));
            }
        } catch (Exception ignored) {
        }
        return list;
    }

    private void startWatcherThread(WatchEntry entry) {
        Thread t = new Thread(() -> watchLoop(entry), "antigpt-watch-" + entry.chatId);
        t.setDaemon(true);
        entry.thread = t;
        t.start();
    }

    private void watchLoop(WatchEntry entry) {
        int tries = 0;
        while (!destroyed.get() && !entry.stopped.get()) {
            HttpURLConnection conn = null;
            try {
                String base = BuildConfig.APP_URL.endsWith("/")
                    ? BuildConfig.APP_URL.substring(0, BuildConfig.APP_URL.length() - 1)
                    : BuildConfig.APP_URL;
                int since = Math.max(0, entry.lastSeq + 1);
                String urlStr = base + "/api/chat/stream?chatId="
                    + URLEncoder.encode(entry.chatId, "UTF-8")
                    + "&since=" + since;

                conn = (HttpURLConnection) new URL(urlStr).openConnection();
                entry.connection = conn;
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(15_000);
                conn.setReadTimeout(45_000);
                conn.setRequestProperty("Accept", "application/x-ndjson, application/json, */*");
                conn.setRequestProperty("User-Agent", "AntiGPT-Android/" + BuildConfig.VERSION_NAME);
                if (authCookie != null && !authCookie.isEmpty()) {
                    conn.setRequestProperty("Cookie", authCookie);
                }

                int code = conn.getResponseCode();
                if (code == 401 || code == 403) {
                    finishEntry(entry, false);
                    return;
                }
                if (code < 200 || code >= 300) {
                    throw new Exception("HTTP " + code);
                }

                InputStream is = conn.getInputStream();
                BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
                String line;
                while (!destroyed.get() && !entry.stopped.get() && (line = reader.readLine()) != null) {
                    line = line.trim();
                    if (line.isEmpty()) continue;
                    tries = 0; // stream aktif -> reset backoff
                    JSONObject ev;
                    try {
                        ev = new JSONObject(line);
                    } catch (Exception ignored) {
                        continue;
                    }
                    String type = ev.optString("type", "");
                    if ("ping".equals(type)) continue;
                    if ("none".equals(type)) {
                        finishEntry(entry, true);
                        return;
                    }
                    if (ev.has("seq")) {
                        int seq = ev.optInt("seq", -1);
                        if (seq <= entry.lastSeq) continue;
                        entry.lastSeq = seq;
                    }

                    if ("queued".equals(type)) {
                        entry.statusText = "Menunggu antrean…";
                        updateOngoingNotification(false);
                    } else if ("start".equals(type)) {
                        entry.statusText = "Berpikir…";
                        updateOngoingNotification(false);
                    } else if ("status".equals(type)) {
                        String st = ev.optString("text", "").trim();
                        if (!st.isEmpty()) {
                            entry.statusText = st;
                            updateOngoingNotification(false);
                        }
                    } else if ("step".equals(type)) {
                        JSONObject step = ev.optJSONObject("step");
                        if (step != null) {
                            String st = "running".equals(step.optString("status"))
                                ? step.optString("label", "Menjalankan tool…")
                                : "Berpikir…";
                            if (!st.isEmpty()) {
                                entry.statusText = st;
                                updateOngoingNotification(false);
                            }
                        }
                    } else if ("delta".equals(type)) {
                        entry.statusText = "Menulis jawaban…";
                        updateOngoingNotification(false);
                    } else if ("question".equals(type)) {
                        entry.statusText = "Menunggu jawabanmu…";
                        updateOngoingNotification(true);
                        JSONObject q = ev.optJSONObject("question");
                        String qId = q != null ? q.optString("id", "") : "";
                        if (qId.isEmpty() || !qId.equals(entry.lastNotifiedQuestionId)) {
                            entry.lastNotifiedQuestionId = qId;
                            postQuestionNotification(entry, q);
                        }
                    } else if ("question_done".equals(type)) {
                        entry.statusText = "Berpikir…";
                        updateOngoingNotification(false);
                    } else if ("done".equals(type)) {
                        if (!ev.optBoolean("cancelled", false)) {
                            postDoneNotification(entry, ev);
                        }
                        finishEntry(entry, true);
                        return;
                    }
                }
            } catch (Exception ignored) {
                // Koneksi terputus / timeout -> coba sambung ulang selama service masih aktif
            } finally {
                entry.connection = null;
                if (conn != null) {
                    try { conn.disconnect(); } catch (Exception ignored) {}
                }
            }

            if (destroyed.get() || entry.stopped.get()) return;
            tries++;
            if (tries > MAX_RECONNECT_TRIES) {
                finishEntry(entry, false);
                return;
            }
            try {
                Thread.sleep(Math.min(10_000L, tries * 2_000L));
            } catch (InterruptedException ie) {
                return;
            }
        }
    }

    private void finishEntry(WatchEntry entry, boolean markFinished) {
        entry.stopped.set(true);
        activeWatches.remove(entry.chatId, entry);
        if (markFinished) {
            finishedJobIds.add(entry.chatId);
        }
        if (activeWatches.isEmpty()) {
            stopSelf();
        } else {
            updateOngoingNotification(true);
        }
    }

    private boolean canPostNotification() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        }
        return true;
    }

    private PendingIntent buildOpenChatIntent(String chatId) {
        Intent i = new Intent(this, MainActivity.class);
        i.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (chatId != null && !chatId.isEmpty()) {
            i.putExtra(EXTRA_OPEN_CHAT_ID, chatId);
        }
        int reqCode = chatId != null ? Math.abs(chatId.hashCode()) : 0;
        int flags = PendingIntent.FLAG_UPDATE_CURRENT
            | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
        return PendingIntent.getActivity(this, reqCode, i, flags);
    }

    private Notification buildOngoingNotification(@Nullable WatchEntry sample, int totalCount) {
        String title;
        String text;
        if (totalCount > 1 && sample != null) {
            title = "AntiGPT memantau " + totalCount + " tugas";
            String label = sample.title.isEmpty() ? "Obrolan aktif" : sample.title;
            text = label + " · " + sample.statusText;
        } else if (sample != null) {
            title = sample.title.isEmpty() ? "AntiGPT sedang memproses…" : sample.title;
            text = sample.statusText;
        } else {
            title = "AntiGPT sedang memproses…";
            text = "Menunggu balasan AI di latar belakang";
        }

        return new NotificationCompat.Builder(this, CHANNEL_RUNNING)
            .setSmallIcon(R.drawable.ic_stat_antigpt)
            .setColor(ACCENT_COLOR)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setContentIntent(buildOpenChatIntent(sample != null ? sample.chatId : null))
            .build();
    }

    private void updateOngoingNotification(boolean force) {
        if (destroyed.get() || activeWatches.isEmpty()) return;
        long now = System.currentTimeMillis();
        if (!force && now - lastFgUpdateMs < 2000L) return;
        lastFgUpdateMs = now;

        WatchEntry first = null;
        for (WatchEntry e : activeWatches.values()) {
            first = e;
            break;
        }
        if (first == null) return;
        try {
            Notification notif = buildOngoingNotification(first, activeWatches.size());
            if (canPostNotification()) {
                NotificationManagerCompat.from(this).notify(FG_NOTIF_ID, notif);
            }
        } catch (Exception ignored) {
        }
    }

    private void postQuestionNotification(WatchEntry entry, @Nullable JSONObject q) {
        if (!canPostNotification()) return;
        String qText = "";
        if (q != null) {
            JSONArray fields = q.optJSONArray("fields");
            if (fields != null && fields.length() > 0) {
                JSONObject first = fields.optJSONObject(0);
                if (first != null) qText = first.optString("title", "").trim();
            }
            if (qText.isEmpty()) qText = q.optString("message", "").trim();
            if (qText.isEmpty()) qText = q.optString("title", "").trim();
        }
        if (qText.isEmpty()) qText = "Ketuk untuk menjawab pertanyaan AI.";

        String body = entry.title.isEmpty() ? qText : (entry.title + " — " + qText);
        Notification notif = new NotificationCompat.Builder(this, CHANNEL_RESULT)
            .setSmallIcon(R.drawable.ic_stat_antigpt)
            .setColor(ACCENT_COLOR)
            .setContentTitle("AI menunggu jawabanmu")
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(buildOpenChatIntent(entry.chatId))
            .build();
        try {
            NotificationManagerCompat.from(this).notify(resultNotificationId(entry.chatId), notif);
        } catch (Exception ignored) {
        }
    }

    private void postDoneNotification(WatchEntry entry, JSONObject ev) {
        if (!canPostNotification()) return;
        boolean ok = ev.optBoolean("ok", true);
        boolean needLogin = ev.optBoolean("needLogin", false);
        JSONObject limit = ev.optJSONObject("limit");
        String rawAnswer = ev.optString("answer", "");
        String preview = cleanPreview(rawAnswer);

        String chatLabel = entry.title.isEmpty() ? "AntiGPT" : entry.title;
        String title;
        String body;

        if (needLogin && !ok) {
            title = "Perlu login akun AI";
            body = "Buka menu Akun → Login dengan Google untuk melanjutkan.";
        } else if (limit != null) {
            String lbl = limit.optString("label", "kuota");
            title = "Limit terdeteksi · " + chatLabel;
            body = preview.isEmpty() ? ("Limit " + lbl + " tercapai. Ketuk untuk melihat detail.") : preview;
        } else if (!ok) {
            title = "Proses berhenti · " + chatLabel;
            body = preview.isEmpty() ? "Terjadi kendala saat memproses pesan. Ketuk untuk melihat." : preview;
        } else {
            title = entry.title.isEmpty() ? "AntiGPT selesai menjawab" : entry.title;
            body = preview.isEmpty() ? "Jawaban sudah siap. Ketuk untuk membaca." : preview;
        }

        Notification notif = new NotificationCompat.Builder(this, CHANNEL_RESULT)
            .setSmallIcon(R.drawable.ic_stat_antigpt)
            .setColor(ACCENT_COLOR)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setDefaults(NotificationCompat.DEFAULT_ALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(buildOpenChatIntent(entry.chatId))
            .build();
        try {
            NotificationManagerCompat.from(this).notify(resultNotificationId(entry.chatId), notif);
        } catch (Exception ignored) {
        }
    }

    private static String cleanPreview(@Nullable String md) {
        if (md == null) return "";
        String s = md.trim();
        if (s.isEmpty()) return "";
        // Ringkas blok kode, gambar, dan tanda markdown agar nyaman dibaca di notifikasi
        s = s.replaceAll("(?s)```.*?```", "[kode]");
        s = s.replaceAll("!\\[[^\\]]*\\]\\([^)]*\\)", "[media]");
        s = s.replaceAll("\\[([^\\]]+)\\]\\([^)]*\\)", "$1");
        s = s.replaceAll("(?m)^#{1,6}\\s+", "");
        s = s.replaceAll("[*_`~>]+", "");
        s = s.replaceAll("\\s+", " ").trim();
        if (s.length() > 180) {
            s = s.substring(0, 177).trim() + "…";
        }
        return s;
    }

    private void shutdownAll() {
        destroyed.set(true);
        for (WatchEntry entry : activeWatches.values()) {
            entry.stopped.set(true);
            HttpURLConnection c = entry.connection;
            if (c != null) {
                try { c.disconnect(); } catch (Exception ignored) {}
            }
            Thread t = entry.thread;
            if (t != null) t.interrupt();
        }
        activeWatches.clear();
    }

    @Override
    public void onDestroy() {
        shutdownAll();
        try {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private static final class WatchEntry {
        final String chatId;
        volatile String title;
        volatile int lastSeq;
        volatile String statusText = "Menunggu balasan AI…";
        volatile String lastNotifiedQuestionId = "";
        volatile HttpURLConnection connection;
        volatile Thread thread;
        final AtomicBoolean stopped = new AtomicBoolean(false);

        WatchEntry(String chatId, String title, int lastSeq) {
            this.chatId = chatId;
            this.title = title != null ? title : "";
            this.lastSeq = lastSeq;
        }
    }
}
