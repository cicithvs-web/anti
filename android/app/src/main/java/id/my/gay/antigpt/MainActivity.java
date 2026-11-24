package id.my.gay.antigpt;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Message;
import android.provider.Settings;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.view.MotionEvent;
import android.view.VelocityTracker;
import android.view.View;
import android.view.ViewOutlineProvider;
import android.view.Window;
import android.view.WindowManager;
import android.view.animation.AccelerateDecelerateInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageButton;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.PopupMenu;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.annotation.NonNull;
import androidx.annotation.Nullable;
import androidx.appcompat.app.AppCompatActivity;
import androidx.browser.customtabs.CustomTabsIntent;
import androidx.core.app.ActivityCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

public class MainActivity extends AppCompatActivity {

    private static final String APP_URL = BuildConfig.APP_URL;
    private static final String LIGHT_BG = "#FAF9F5";
    private static final String DARK_BG = "#171614";
    private static final String PREFS_NAME = "antigpt_prefs";
    private static final String PREF_NOTIF_ENABLED = "notif_enabled";
    private static final String PREF_NOTIF_PROMPTED = "notif_prompted";

    private FrameLayout rootContainer;
    private WebView webView;
    private LinearLayout splashOverlay;
    private LinearLayout errorOverlay;
    private FrameLayout fullscreenContainer;

    // Pop-up In-App Browser bergaya Telegram (bottom sheet + minimize bar)
    private View inAppBackdrop;
    private LinearLayout inAppSheet;
    private View inAppDragArea;
    private FrameLayout inAppWebViewHost;
    private TextView inAppTitleView;
    private TextView inAppHostView;
    private ImageButton inAppBtnClose;
    private ImageButton inAppBtnMinimize;
    private ImageButton inAppBtnMore;
    private ProgressBar inAppProgress;
    private View inAppDivider;
    private LinearLayout inAppMiniBar;
    private ImageView inAppMiniIcon;
    private TextView inAppMiniTitle;
    private TextView inAppMiniHost;
    private ImageButton inAppMiniClose;
    private WebView inAppWebView;
    private boolean inAppExpanded = false;
    private boolean inAppMinimized = false;
    private String inAppCurrentUrl = "";
    private String inAppCurrentTitle = "";
    private boolean currentDarkTheme = false;

    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    private ValueCallback<Uri[]> pendingFileCallback;
    private WebChromeClient.FileChooserParams pendingChooserParams;
    private Uri pendingCameraUri;

    private PermissionRequest pendingWebPermissionRequest;
    private String pendingVoiceLang;
    private SpeechRecognizer speechRecognizer;

    private String pendingDownloadUrl;
    private String pendingDownloadUserAgent;
    private String pendingDownloadDisposition;
    private String pendingDownloadMime;

    private long lastBackPressMs = 0L;
    private boolean pageHadError = false;
    private boolean splashHidden = false;
    private String appHost;

    // Sinkronisasi animasi keyboard (IME) per-frame ala Claude
    private int lastSysBottom = 0;
    private int currentImeExtra = 0;
    private int targetImeExtra = 0;
    private int lastDispatchedImePx = -1;
    private int activeImeAnimCount = 0;
    private boolean imeAnimating = false;

    // Notifikasi latar belakang untuk job AI aktif
    private final Map<String, WatchedJob> watchedJobs = new LinkedHashMap<>();
    private String pendingOpenChatId = null;
    private boolean pageLoaded = false;

    private static final class WatchedJob {
        final String id;
        String title;
        int seq;

        WatchedJob(String id, String title, int seq) {
            this.id = id;
            this.title = title != null ? title : "";
            this.seq = seq;
        }
    }

    private final ActivityResultLauncher<Intent> filePickerLauncher =
        registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            ValueCallback<Uri[]> cb = pendingFileCallback;
            pendingFileCallback = null;
            pendingChooserParams = null;
            if (cb == null) return;

            if (result.getResultCode() != RESULT_OK || result.getData() == null) {
                cb.onReceiveValue(null);
                return;
            }
            Intent data = result.getData();
            List<Uri> uris = new ArrayList<>();
            ClipData clip = data.getClipData();
            if (clip != null && clip.getItemCount() > 0) {
                for (int i = 0; i < clip.getItemCount(); i++) {
                    Uri u = clip.getItemAt(i).getUri();
                    if (u != null) uris.add(u);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
            cb.onReceiveValue(uris.isEmpty() ? null : uris.toArray(new Uri[0]));
        });

    private final ActivityResultLauncher<Uri> cameraCaptureLauncher =
        registerForActivityResult(new ActivityResultContracts.TakePicture(), success -> {
            ValueCallback<Uri[]> cb = pendingFileCallback;
            Uri uri = pendingCameraUri;
            pendingFileCallback = null;
            pendingChooserParams = null;
            pendingCameraUri = null;
            if (cb == null) return;
            if (Boolean.TRUE.equals(success) && uri != null) {
                cb.onReceiveValue(new Uri[]{uri});
            } else {
                cb.onReceiveValue(null);
            }
        });

    private final ActivityResultLauncher<String> cameraPermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (Boolean.TRUE.equals(granted)) {
                launchCameraCapture();
            } else {
                launchFilePicker(pendingChooserParams);
            }
        });

    private final ActivityResultLauncher<String> micPermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (pendingWebPermissionRequest != null) {
                PermissionRequest req = pendingWebPermissionRequest;
                pendingWebPermissionRequest = null;
                if (Boolean.TRUE.equals(granted)) {
                    req.grant(req.getResources());
                } else {
                    req.deny();
                }
                return;
            }
            if (pendingVoiceLang != null) {
                String lang = pendingVoiceLang;
                pendingVoiceLang = null;
                if (Boolean.TRUE.equals(granted)) {
                    startNativeSpeechRecognizer(lang);
                } else {
                    dispatchVoiceEvent("onError", JSONObject.quote("not-allowed"));
                }
            }
        });

    private final ActivityResultLauncher<String> storagePermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (Boolean.TRUE.equals(granted) && pendingDownloadUrl != null) {
                enqueueDownload(pendingDownloadUrl, pendingDownloadUserAgent, pendingDownloadDisposition, pendingDownloadMime);
            } else if (!Boolean.TRUE.equals(granted)) {
                Toast.makeText(this, "Izin penyimpanan diperlukan untuk mengunduh file.", Toast.LENGTH_SHORT).show();
            }
            pendingDownloadUrl = null;
            pendingDownloadUserAgent = null;
            pendingDownloadDisposition = null;
            pendingDownloadMime = null;
        });

    private final ActivityResultLauncher<String> notifPermissionLauncher =
        registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
            if (Boolean.TRUE.equals(granted)) {
                getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
                    .edit()
                    .putBoolean(PREF_NOTIF_ENABLED, true)
                    .apply();
            }
            dispatchNotifStateToWeb();
        });

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Uri parsedApp = Uri.parse(APP_URL);
        appHost = parsedApp.getHost() != null ? parsedApp.getHost().toLowerCase(Locale.US) : "";
        JobWatchService.ensureChannels(this);
        extractOpenChatFromIntent(getIntent());

        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            WindowManager.LayoutParams lp = getWindow().getAttributes();
            lp.layoutInDisplayCutoutMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R
                ? WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
                : WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            getWindow().setAttributes(lp);
        }

        setContentView(R.layout.activity_main);

        rootContainer = findViewById(R.id.root_container);
        webView = findViewById(R.id.web_view);
        splashOverlay = findViewById(R.id.splash_overlay);
        errorOverlay = findViewById(R.id.error_overlay);
        fullscreenContainer = findViewById(R.id.fullscreen_container);
        Button retryButton = findViewById(R.id.retry_button);

        initInAppBrowserViews();

        boolean initialDark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
            == Configuration.UI_MODE_NIGHT_YES;
        applySystemChromeTheme(initialDark ? DARK_BG : LIGHT_BG, initialDark);

        setupWindowInsetsAndImeAnimation();

        configureWebView();

        retryButton.setOnClickListener(v -> {
            pageHadError = false;
            errorOverlay.setVisibility(View.GONE);
            splashHidden = false;
            splashOverlay.setAlpha(1f);
            splashOverlay.setVisibility(View.VISIBLE);
            webView.loadUrl(APP_URL);
        });

        setupBackHandler();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(APP_URL);
        }

        // Safety fallback so splash never stays stuck
        splashOverlay.postDelayed(this::hideSplash, 4500);
    }

    private void setupWindowInsetsAndImeAnimation() {
        ViewCompat.setOnApplyWindowInsetsListener(rootContainer, (v, windowInsets) -> {
            if (customView != null) {
                v.setPadding(0, 0, 0, 0);
                return WindowInsetsCompat.CONSUMED;
            }
            Insets sysBars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            Insets ime = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            lastSysBottom = sysBars.bottom;
            int imeExtra = Math.max(0, ime.bottom - sysBars.bottom);
            targetImeExtra = imeExtra;

            // Main WebView tidak di-resize untuk IME agar 0 loncatan / 0 stutter;
            // hanya systemBars + displayCutout yang menjadi padding native rootContainer.
            v.setPadding(sysBars.left, sysBars.top, sysBars.right, sysBars.bottom);

            if (inAppSheet != null) {
                inAppSheet.setPadding(0, 0, 0, inAppExpanded ? imeExtra : 0);
            }

            if (!imeAnimating) {
                currentImeExtra = imeExtra;
                if (inAppMinimized && !inAppExpanded && inAppMiniBar != null) {
                    inAppMiniBar.setTranslationY(-imeExtra);
                }
                if (!inAppExpanded) {
                    dispatchImeToWeb("settle", imeExtra, imeExtra);
                }
            }
            return WindowInsetsCompat.CONSUMED;
        });

        ViewCompat.setWindowInsetsAnimationCallback(
            rootContainer,
            new WindowInsetsAnimationCompat.Callback(
                WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE
            ) {
                @Override
                public void onPrepare(@NonNull WindowInsetsAnimationCompat animation) {
                    if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) == 0) return;
                    activeImeAnimCount++;
                    imeAnimating = true;
                }

                @NonNull
                @Override
                public WindowInsetsAnimationCompat.BoundsCompat onStart(
                    @NonNull WindowInsetsAnimationCompat animation,
                    @NonNull WindowInsetsAnimationCompat.BoundsCompat bounds
                ) {
                    if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) == 0) return bounds;
                    WindowInsetsCompat root = ViewCompat.getRootWindowInsets(rootContainer);
                    boolean visible = root != null && root.isVisible(WindowInsetsCompat.Type.ime());
                    int endPx = visible
                        ? (targetImeExtra > 0 ? targetImeExtra : Math.max(0, bounds.getUpperBound().bottom - lastSysBottom))
                        : 0;
                    targetImeExtra = endPx;
                    lastDispatchedImePx = -1;
                    if (!inAppExpanded) {
                        dispatchImeToWeb("start", currentImeExtra, targetImeExtra);
                    }
                    return bounds;
                }

                @NonNull
                @Override
                public WindowInsetsCompat onProgress(
                    @NonNull WindowInsetsCompat insets,
                    @NonNull List<WindowInsetsAnimationCompat> runningAnimations
                ) {
                    boolean hasIme = false;
                    for (WindowInsetsAnimationCompat anim : runningAnimations) {
                        if ((anim.getTypeMask() & WindowInsetsCompat.Type.ime()) != 0) {
                            hasIme = true;
                            break;
                        }
                    }
                    if (!hasIme) return insets;

                    Insets sys = insets.getInsets(
                        WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                    );
                    Insets ime = insets.getInsets(WindowInsetsCompat.Type.ime());
                    int imeExtra = Math.max(0, ime.bottom - sys.bottom);
                    currentImeExtra = imeExtra;

                    if (inAppExpanded) {
                        if (inAppSheet != null) inAppSheet.setPadding(0, 0, 0, imeExtra);
                    } else {
                        if (inAppMinimized && inAppMiniBar != null) {
                            inAppMiniBar.setTranslationY(-imeExtra);
                        }
                        if (imeExtra != lastDispatchedImePx) {
                            lastDispatchedImePx = imeExtra;
                            dispatchImeToWeb("progress", imeExtra, targetImeExtra);
                        }
                    }
                    return insets;
                }

                @Override
                public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                    if ((animation.getTypeMask() & WindowInsetsCompat.Type.ime()) == 0) return;
                    activeImeAnimCount = Math.max(0, activeImeAnimCount - 1);
                    if (activeImeAnimCount > 0) return;
                    imeAnimating = false;

                    WindowInsetsCompat root = ViewCompat.getRootWindowInsets(rootContainer);
                    int finalExtra = targetImeExtra;
                    if (root != null) {
                        Insets sys = root.getInsets(
                            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
                        );
                        Insets ime = root.getInsets(WindowInsetsCompat.Type.ime());
                        boolean visible = root.isVisible(WindowInsetsCompat.Type.ime());
                        finalExtra = visible ? Math.max(0, ime.bottom - sys.bottom) : 0;
                    }
                    currentImeExtra = finalExtra;
                    targetImeExtra = finalExtra;
                    lastDispatchedImePx = finalExtra;

                    if (inAppExpanded) {
                        if (inAppSheet != null) inAppSheet.setPadding(0, 0, 0, finalExtra);
                    } else {
                        if (inAppSheet != null) inAppSheet.setPadding(0, 0, 0, 0);
                        if (inAppMinimized && inAppMiniBar != null) {
                            inAppMiniBar.setTranslationY(-finalExtra);
                        }
                        dispatchImeToWeb("end", finalExtra, finalExtra);
                    }
                }
            }
        );

        ViewCompat.requestApplyInsets(rootContainer);
    }

    private void dispatchImeToWeb(String phase, int px, int targetPx) {
        if (webView == null) return;
        webView.evaluateJavascript(
            "window.__antigptIme&&window.__antigptIme('" + phase + "'," + px + "," + targetPx + ")",
            null
        );
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setTextZoom(100);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUserAgentString(settings.getUserAgentString() + " AntiGPT-Android/" + BuildConfig.VERSION_NAME);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new NativeBridge(), "AntiGPTNative");

        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) ->
            startNativeDownload(url, userAgent, contentDisposition, mimetype)
        );

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleUrlNavigation(request.getUrl());
            }

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                super.onPageCommitVisible(view, url);
                if (!pageHadError) {
                    hideSplash();
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageLoaded = true;
                CookieManager.getInstance().flush();
                if (!pageHadError) {
                    errorOverlay.setVisibility(View.GONE);
                    hideSplash();
                }
                if (currentImeExtra > 0 && !imeAnimating && !inAppExpanded) {
                    dispatchImeToWeb("settle", currentImeExtra, currentImeExtra);
                }
                dispatchPendingOpenChat();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request != null && request.isForMainFrame()) {
                    pageHadError = true;
                    hideSplash();
                    errorOverlay.setVisibility(View.VISIBLE);
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(
                WebView webView,
                ValueCallback<Uri[]> filePathCallback,
                FileChooserParams fileChooserParams
            ) {
                cancelPendingFileCallback();
                pendingFileCallback = filePathCallback;
                pendingChooserParams = fileChooserParams;

                if (fileChooserParams != null && fileChooserParams.isCaptureEnabled()) {
                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.CAMERA)
                        == PackageManager.PERMISSION_GRANTED) {
                        launchCameraCapture();
                    } else {
                        cameraPermissionLauncher.launch(Manifest.permission.CAMERA);
                    }
                } else {
                    launchFilePicker(fileChooserParams);
                }
                return true;
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> {
                    String[] resources = request.getResources();
                    boolean needsAudio = false;
                    for (String r : resources) {
                        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) {
                            needsAudio = true;
                            break;
                        }
                    }
                    if (!needsAudio) {
                        request.deny();
                        return;
                    }
                    if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                        == PackageManager.PERMISSION_GRANTED) {
                        request.grant(resources);
                    } else {
                        pendingWebPermissionRequest = request;
                        micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO);
                    }
                });
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView tempWebView = new WebView(MainActivity.this);
                tempWebView.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        Uri uri = request.getUrl();
                        if (uri != null) {
                            if (isSameOriginDownload(uri)) {
                                startNativeDownload(uri.toString(), webView.getSettings().getUserAgentString(), null, null);
                            } else if (isSameOrigin(uri)) {
                                webView.loadUrl(uri.toString());
                            } else {
                                openExternalUrl(uri);
                            }
                        }
                        v.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(tempWebView);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                ));
                fullscreenContainer.setVisibility(View.VISIBLE);
                WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                controller.hide(WindowInsetsCompat.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                ViewCompat.requestApplyInsets(rootContainer);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreenVideo();
            }
        });
    }

    private void setupBackHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (customView != null) {
                    exitFullscreenVideo();
                    return;
                }
                if (inAppExpanded) {
                    if (inAppWebView != null && inAppWebView.canGoBack()) {
                        inAppWebView.goBack();
                    } else {
                        closeInAppBrowser();
                    }
                    return;
                }
                if (errorOverlay.getVisibility() == View.VISIBLE) {
                    finish();
                    return;
                }
                webView.evaluateJavascript(
                    "(function(){try{return window.__antigptHandleBack?Boolean(window.__antigptHandleBack()):false;}catch(e){return false;}})()",
                    value -> {
                        if ("true".equals(value)) {
                            return;
                        }
                        if (webView.canGoBack()) {
                            webView.goBack();
                            return;
                        }
                        long now = System.currentTimeMillis();
                        if (now - lastBackPressMs < 2000) {
                            finish();
                        } else {
                            lastBackPressMs = now;
                            Toast.makeText(MainActivity.this, "Tekan kembali sekali lagi untuk keluar", Toast.LENGTH_SHORT).show();
                        }
                    }
                );
            }
        });
    }

    private void exitFullscreenVideo() {
        if (customView == null) return;
        fullscreenContainer.removeView(customView);
        fullscreenContainer.setVisibility(View.GONE);
        customView = null;
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        controller.show(WindowInsetsCompat.Type.systemBars());
        ViewCompat.requestApplyInsets(rootContainer);
    }

    private boolean isSameOrigin(@Nullable Uri uri) {
        if (uri == null || uri.getHost() == null) return false;
        return appHost.equalsIgnoreCase(uri.getHost());
    }

    private boolean isSameOriginDownload(@Nullable Uri uri) {
        if (!isSameOrigin(uri)) return false;
        String path = uri.getPath();
        if (path == null) return false;
        return path.contains("/files/") || path.contains("/media/") || path.endsWith(".apk");
    }

    private boolean handleUrlNavigation(@Nullable Uri uri) {
        if (uri == null) return false;
        String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.US) : "";
        if (!"http".equals(scheme) && !"https".equals(scheme)) {
            openExternalUrl(uri);
            return true;
        }
        if (isSameOrigin(uri)) {
            String path = uri.getPath() != null ? uri.getPath() : "";
            if (path.contains("/files/") || path.endsWith(".apk")) {
                startNativeDownload(uri.toString(), webView.getSettings().getUserAgentString(), null, null);
                return true;
            }
            return false;
        }
        openExternalUrl(uri);
        return true;
    }

    private boolean isGoogleOAuthUrl(@NonNull Uri uri) {
        String host = uri.getHost() != null ? uri.getHost().toLowerCase(Locale.US) : "";
        return host.equals("accounts.google.com")
            || host.endsWith(".accounts.google.com")
            || host.equals("oauth2.googleapis.com");
    }

    private void openExternalUrl(@NonNull Uri uri) {
        String scheme = uri.getScheme() != null ? uri.getScheme().toLowerCase(Locale.US) : "";
        if ("http".equals(scheme) || "https".equals(scheme)) {
            // Khusus OAuth Google tetap pakai Chrome Custom Tabs agar tidak ditolak kebijakan WebView Google
            if (isGoogleOAuthUrl(uri)) {
                openWithCustomTabs(uri);
            } else {
                openInAppBrowser(uri);
            }
            return;
        }
        openNativeAppIntent(uri);
    }

    private void openWithCustomTabs(@NonNull Uri uri) {
        try {
            CustomTabsIntent customTabsIntent = new CustomTabsIntent.Builder()
                .setShowTitle(true)
                .build();
            customTabsIntent.launchUrl(this, uri);
            return;
        } catch (Exception ignored) {
        }
        openNativeAppIntent(uri);
    }

    private void openNativeAppIntent(@NonNull Uri uri) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, uri);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "Tidak ada aplikasi untuk membuka tautan ini.", Toast.LENGTH_SHORT).show();
        }
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    @SuppressLint("ClickableViewAccessibility")
    private void initInAppBrowserViews() {
        inAppBackdrop = findViewById(R.id.inapp_browser_backdrop);
        inAppSheet = findViewById(R.id.inapp_browser_sheet);
        inAppDragArea = findViewById(R.id.inapp_browser_drag_area);
        inAppWebViewHost = findViewById(R.id.inapp_webview_host);
        inAppTitleView = findViewById(R.id.inapp_title);
        inAppHostView = findViewById(R.id.inapp_host);
        inAppBtnClose = findViewById(R.id.inapp_btn_close);
        inAppBtnMinimize = findViewById(R.id.inapp_btn_minimize);
        inAppBtnMore = findViewById(R.id.inapp_btn_more);
        inAppProgress = findViewById(R.id.inapp_progress);
        inAppDivider = findViewById(R.id.inapp_divider);
        inAppMiniBar = findViewById(R.id.inapp_mini_bar);
        inAppMiniIcon = findViewById(R.id.inapp_mini_icon);
        inAppMiniTitle = findViewById(R.id.inapp_mini_title);
        inAppMiniHost = findViewById(R.id.inapp_mini_host);
        inAppMiniClose = findViewById(R.id.inapp_mini_close);

        final int radiusPx = dp(20);
        inAppSheet.setClipToOutline(true);
        inAppSheet.setOutlineProvider(new ViewOutlineProvider() {
            @Override
            public void getOutline(View view, Outline outline) {
                outline.setRoundRect(0, 0, view.getWidth(), view.getHeight() + radiusPx, radiusPx);
            }
        });

        inAppBackdrop.setOnClickListener(v -> minimizeInAppBrowser());
        inAppBtnClose.setOnClickListener(v -> closeInAppBrowser());
        inAppBtnMinimize.setOnClickListener(v -> minimizeInAppBrowser());
        inAppBtnMore.setOnClickListener(v -> showInAppBrowserMenu());
        inAppMiniBar.setOnClickListener(v -> restoreInAppBrowser());
        inAppMiniClose.setOnClickListener(v -> closeInAppBrowser());

        // Gesture tarik turun pada header browser untuk minimize halus seperti Telegram
        inAppDragArea.setOnTouchListener(new View.OnTouchListener() {
            private float startRawY;
            private float lastDy;
            private boolean dragging;
            private VelocityTracker velocityTracker;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                if (!inAppExpanded) return false;
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        startRawY = event.getRawY();
                        lastDy = 0f;
                        dragging = false;
                        if (velocityTracker != null) velocityTracker.recycle();
                        velocityTracker = VelocityTracker.obtain();
                        velocityTracker.addMovement(event);
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        if (velocityTracker != null) velocityTracker.addMovement(event);
                        float dy = event.getRawY() - startRawY;
                        if (dy > dp(6)) dragging = true;
                        if (dragging) {
                            lastDy = Math.max(0f, dy);
                            inAppSheet.setTranslationY(lastDy);
                            float h = Math.max(1f, inAppSheet.getHeight());
                            inAppBackdrop.setAlpha(Math.max(0f, 1f - (lastDy / h)));
                        }
                        return dragging;
                    case MotionEvent.ACTION_UP:
                    case MotionEvent.ACTION_CANCEL:
                        float velY = 0f;
                        if (velocityTracker != null) {
                            velocityTracker.computeCurrentVelocity(1000);
                            velY = velocityTracker.getYVelocity();
                            velocityTracker.recycle();
                            velocityTracker = null;
                        }
                        if (dragging) {
                            float threshold = Math.max(dp(120), inAppSheet.getHeight() * 0.18f);
                            if (lastDy > threshold || velY > 900f) {
                                minimizeInAppBrowser();
                            } else {
                                inAppSheet.animate()
                                    .translationY(0f)
                                    .setDuration(200)
                                    .setInterpolator(new DecelerateInterpolator(2f))
                                    .start();
                                inAppBackdrop.animate().alpha(1f).setDuration(200).start();
                            }
                            dragging = false;
                            return true;
                        }
                        return false;
                    default:
                        return false;
                }
            }
        });
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView ensureInAppWebView() {
        if (inAppWebView != null) return inAppWebView;
        WebView wv = new WebView(this);
        wv.setLayoutParams(new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT,
            FrameLayout.LayoutParams.MATCH_PARENT
        ));
        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setSupportMultipleWindows(true);
        s.setJavaScriptCanOpenWindowsAutomatically(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);

        wv.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) ->
            startNativeDownload(url, userAgent, contentDisposition, mimetype)
        );

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (u == null) return false;
                String sc = u.getScheme() != null ? u.getScheme().toLowerCase(Locale.US) : "";
                if (!"http".equals(sc) && !"https".equals(sc)) {
                    openNativeAppIntent(u);
                    return true;
                }
                if (isGoogleOAuthUrl(u)) {
                    openWithCustomTabs(u);
                    return true;
                }
                updateInAppHeader(u.toString(), null);
                return false;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                updateInAppHeader(url, view.getTitle());
            }
        });

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onReceivedTitle(WebView view, String title) {
                super.onReceivedTitle(view, title);
                updateInAppHeader(view.getUrl(), title);
            }

            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                super.onProgressChanged(view, newProgress);
                if (inAppProgress == null) return;
                if (newProgress >= 100) {
                    inAppProgress.setProgress(100);
                    inAppProgress.animate().alpha(0f).setDuration(180).withEndAction(() -> {
                        inAppProgress.setVisibility(View.GONE);
                        inAppProgress.setAlpha(1f);
                    }).start();
                } else {
                    if (inAppProgress.getVisibility() != View.VISIBLE) {
                        inAppProgress.setAlpha(1f);
                        inAppProgress.setVisibility(View.VISIBLE);
                    }
                    inAppProgress.setProgress(Math.max(8, newProgress));
                }
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                WebView tmp = new WebView(MainActivity.this);
                tmp.setWebViewClient(new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        Uri u = request.getUrl();
                        if (u != null && inAppWebView != null) {
                            String sc = u.getScheme() != null ? u.getScheme().toLowerCase(Locale.US) : "";
                            if ("http".equals(sc) || "https".equals(sc)) {
                                if (isGoogleOAuthUrl(u)) openWithCustomTabs(u);
                                else inAppWebView.loadUrl(u.toString());
                            } else {
                                openNativeAppIntent(u);
                            }
                        }
                        v.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(tmp);
                resultMsg.sendToTarget();
                return true;
            }

            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT,
                    FrameLayout.LayoutParams.MATCH_PARENT
                ));
                fullscreenContainer.setVisibility(View.VISIBLE);
                WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
                controller.hide(WindowInsetsCompat.Type.systemBars());
                controller.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
                ViewCompat.requestApplyInsets(rootContainer);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreenVideo();
            }
        });

        inAppWebViewHost.removeAllViews();
        inAppWebViewHost.addView(wv);
        inAppWebView = wv;
        return wv;
    }

    private void updateInAppHeader(@Nullable String url, @Nullable String title) {
        if (url != null && !url.isEmpty() && !"about:blank".equals(url)) {
            inAppCurrentUrl = url;
        }
        String host = "";
        try {
            Uri parsed = Uri.parse(inAppCurrentUrl);
            host = parsed.getHost() != null ? parsed.getHost() : inAppCurrentUrl;
        } catch (Exception ignored) {
            host = inAppCurrentUrl;
        }
        if (title != null && !title.trim().isEmpty() && !"about:blank".equals(title.trim())) {
            inAppCurrentTitle = title.trim();
        } else if (inAppCurrentTitle.isEmpty()) {
            inAppCurrentTitle = host.isEmpty() ? "Memuat…" : host;
        }
        if (inAppTitleView != null) inAppTitleView.setText(inAppCurrentTitle);
        if (inAppHostView != null) inAppHostView.setText(host);
        if (inAppMiniTitle != null) inAppMiniTitle.setText(inAppCurrentTitle);
        if (inAppMiniHost != null) inAppMiniHost.setText(host);
    }

    private void openInAppBrowser(@NonNull Uri uri) {
        hideKeyboard();
        String target = uri.toString();
        boolean sameAsCurrent = inAppWebView != null && target.equals(inAppCurrentUrl);
        WebView wv = ensureInAppWebView();
        if (!sameAsCurrent) {
            inAppCurrentUrl = target;
            inAppCurrentTitle = "";
            updateInAppHeader(target, null);
            if (inAppProgress != null) {
                inAppProgress.animate().cancel();
                inAppProgress.setAlpha(1f);
                inAppProgress.setProgress(10);
                inAppProgress.setVisibility(View.VISIBLE);
            }
            wv.loadUrl(target);
        }
        restoreInAppBrowser();
    }

    private void hideKeyboard() {
        try {
            InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
            View focus = getCurrentFocus();
            if (imm != null) {
                imm.hideSoftInputFromWindow((focus != null ? focus : rootContainer).getWindowToken(), 0);
            }
        } catch (Exception ignored) {
        }
    }

    private void restoreInAppBrowser() {
        if (inAppWebView == null) return;
        inAppMinimized = false;
        inAppExpanded = true;
        inAppMiniBar.animate().cancel();
        inAppMiniBar.setVisibility(View.GONE);
        inAppWebView.onResume();

        inAppBackdrop.animate().cancel();
        inAppSheet.animate().cancel();
        inAppBackdrop.setVisibility(View.VISIBLE);
        inAppSheet.setVisibility(View.VISIBLE);

        float startY = inAppSheet.getHeight() > 0 ? inAppSheet.getHeight() : rootContainer.getHeight();
        if (startY <= 0f) startY = getResources().getDisplayMetrics().heightPixels;
        inAppSheet.setTranslationY(startY);
        inAppBackdrop.setAlpha(0f);

        inAppBackdrop.animate()
            .alpha(1f)
            .setDuration(240)
            .start();
        inAppSheet.animate()
            .translationY(0f)
            .setDuration(280)
            .setInterpolator(new DecelerateInterpolator(2.2f))
            .start();
    }

    private void minimizeInAppBrowser() {
        if (inAppWebView == null || !inAppExpanded) return;
        hideKeyboard();
        if (inAppSheet != null) inAppSheet.setPadding(0, 0, 0, 0);
        inAppExpanded = false;
        inAppMinimized = true;
        inAppWebView.onPause();

        float targetY = inAppSheet.getHeight() > 0 ? inAppSheet.getHeight() : rootContainer.getHeight();
        if (targetY <= 0f) targetY = getResources().getDisplayMetrics().heightPixels;

        inAppBackdrop.animate()
            .alpha(0f)
            .setDuration(200)
            .withEndAction(() -> {
                if (!inAppExpanded) inAppBackdrop.setVisibility(View.GONE);
            })
            .start();
        inAppSheet.animate()
            .translationY(targetY)
            .setDuration(230)
            .setInterpolator(new AccelerateDecelerateInterpolator())
            .withEndAction(() -> {
                if (!inAppExpanded) inAppSheet.setVisibility(View.GONE);
            })
            .start();

        inAppMiniBar.setAlpha(0f);
        inAppMiniBar.setTranslationY(dp(20));
        inAppMiniBar.setVisibility(View.VISIBLE);
        inAppMiniBar.animate()
            .alpha(1f)
            .translationY(0f)
            .setDuration(200)
            .setInterpolator(new DecelerateInterpolator(2f))
            .start();
    }

    private void closeInAppBrowser() {
        hideKeyboard();
        if (inAppSheet != null) inAppSheet.setPadding(0, 0, 0, 0);
        boolean wasExpanded = inAppExpanded;
        inAppExpanded = false;
        inAppMinimized = false;
        inAppMiniBar.animate().cancel();
        inAppMiniBar.setVisibility(View.GONE);

        Runnable destroyAction = () -> {
            if (!inAppExpanded && !inAppMinimized) {
                inAppBackdrop.setVisibility(View.GONE);
                inAppSheet.setVisibility(View.GONE);
                destroyInAppWebView();
            }
        };

        if (wasExpanded) {
            float targetY = inAppSheet.getHeight() > 0 ? inAppSheet.getHeight() : rootContainer.getHeight();
            if (targetY <= 0f) targetY = getResources().getDisplayMetrics().heightPixels;
            inAppBackdrop.animate().alpha(0f).setDuration(190).start();
            inAppSheet.animate()
                .translationY(targetY)
                .setDuration(220)
                .setInterpolator(new AccelerateDecelerateInterpolator())
                .withEndAction(destroyAction)
                .start();
        } else {
            destroyAction.run();
        }
    }

    private void destroyInAppWebView() {
        inAppCurrentUrl = "";
        inAppCurrentTitle = "";
        if (inAppWebViewHost != null) inAppWebViewHost.removeAllViews();
        if (inAppWebView != null) {
            try { inAppWebView.stopLoading(); } catch (Exception ignored) {}
            try { inAppWebView.loadUrl("about:blank"); } catch (Exception ignored) {}
            try { inAppWebView.destroy(); } catch (Exception ignored) {}
            inAppWebView = null;
        }
    }

    private void showInAppBrowserMenu() {
        PopupMenu popup = new PopupMenu(this, inAppBtnMore);
        boolean canBack = inAppWebView != null && inAppWebView.canGoBack();
        boolean canFwd = inAppWebView != null && inAppWebView.canGoForward();
        if (canBack) popup.getMenu().add(0, 1, 0, "Mundur");
        if (canFwd) popup.getMenu().add(0, 2, 1, "Maju");
        popup.getMenu().add(0, 3, 2, "Muat ulang");
        popup.getMenu().add(0, 4, 3, "Salin tautan");
        popup.getMenu().add(0, 5, 4, "Bagikan");
        popup.getMenu().add(0, 6, 5, "Buka di browser luar");

        popup.setOnMenuItemClickListener(item -> {
            String url = inAppCurrentUrl;
            switch (item.getItemId()) {
                case 1:
                    if (inAppWebView != null && inAppWebView.canGoBack()) inAppWebView.goBack();
                    return true;
                case 2:
                    if (inAppWebView != null && inAppWebView.canGoForward()) inAppWebView.goForward();
                    return true;
                case 3:
                    if (inAppWebView != null) inAppWebView.reload();
                    return true;
                case 4:
                    if (!url.isEmpty()) {
                        ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                        if (cm != null) {
                            cm.setPrimaryClip(ClipData.newPlainText("URL", url));
                            Toast.makeText(this, "Tautan disalin", Toast.LENGTH_SHORT).show();
                        }
                    }
                    return true;
                case 5:
                    if (!url.isEmpty()) {
                        Intent share = new Intent(Intent.ACTION_SEND);
                        share.setType("text/plain");
                        share.putExtra(Intent.EXTRA_TEXT, url);
                        startActivity(Intent.createChooser(share, "Bagikan tautan"));
                    }
                    return true;
                case 6:
                    if (!url.isEmpty()) {
                        openNativeAppIntent(Uri.parse(url));
                    }
                    return true;
                default:
                    return false;
            }
        });
        popup.show();
    }

    private void applyInAppBrowserTheme(boolean isDark) {
        currentDarkTheme = isDark;
        if (inAppSheet == null) return;
        int sheetBg = Color.parseColor(isDark ? "#211F1C" : "#FAF9F5");
        int surfaceBg = Color.parseColor(isDark ? "#272522" : "#FFFFFF");
        int textColor = Color.parseColor(isDark ? "#F3F0E9" : "#1F1E1D");
        int mutedColor = Color.parseColor(isDark ? "#AAA49A" : "#6B6A66");
        int borderColor = Color.parseColor(isDark ? "#403C36" : "#E5E3DC");
        int accentColor = Color.parseColor(isDark ? "#E48763" : "#C96442");

        inAppSheet.setBackgroundColor(sheetBg);
        inAppTitleView.setTextColor(textColor);
        inAppHostView.setTextColor(mutedColor);
        inAppDivider.setBackgroundColor(borderColor);
        inAppProgress.setProgressTintList(ColorStateList.valueOf(accentColor));
        inAppBtnClose.setColorFilter(textColor);
        inAppBtnMinimize.setColorFilter(textColor);
        inAppBtnMore.setColorFilter(textColor);

        GradientDrawable miniBg = new GradientDrawable();
        miniBg.setColor(surfaceBg);
        miniBg.setCornerRadius(dp(16));
        miniBg.setStroke(dp(1), borderColor);
        inAppMiniBar.setBackground(miniBg);
        inAppMiniIcon.setColorFilter(accentColor);
        inAppMiniTitle.setTextColor(textColor);
        inAppMiniHost.setTextColor(mutedColor);
        inAppMiniClose.setColorFilter(mutedColor);
    }

    private void startNativeDownload(String url, String userAgent, @Nullable String contentDisposition, @Nullable String mimeType) {
        if (url == null || url.isEmpty()) return;
        if (Build.VERSION.SDK_INT <= Build.VERSION_CODES.P
            && ContextCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            pendingDownloadUrl = url;
            pendingDownloadUserAgent = userAgent;
            pendingDownloadDisposition = contentDisposition;
            pendingDownloadMime = mimeType;
            storagePermissionLauncher.launch(Manifest.permission.WRITE_EXTERNAL_STORAGE);
            return;
        }
        enqueueDownload(url, userAgent, contentDisposition, mimeType);
    }

    private void enqueueDownload(String url, String userAgent, @Nullable String contentDisposition, @Nullable String mimeType) {
        try {
            Uri uri = Uri.parse(url);
            String filename = extractFileName(uri, contentDisposition, mimeType);
            DownloadManager.Request request = new DownloadManager.Request(uri);
            String cookies = CookieManager.getInstance().getCookie(url);
            if (cookies != null && !cookies.isEmpty()) {
                request.addRequestHeader("Cookie", cookies);
            }
            if (userAgent != null && !userAgent.isEmpty()) {
                request.addRequestHeader("User-Agent", userAgent);
            }
            request.setTitle(filename);
            request.setDescription("Mengunduh dari AntiGPT");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, filename);

            DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
            if (dm != null) {
                dm.enqueue(request);
                Toast.makeText(this, "Mengunduh " + filename, Toast.LENGTH_SHORT).show();
            }
        } catch (Exception e) {
            Toast.makeText(this, "Gagal mengunduh file.", Toast.LENGTH_SHORT).show();
        }
    }

    private String extractFileName(Uri uri, @Nullable String contentDisposition, @Nullable String mimeType) {
        if (contentDisposition != null && !contentDisposition.isEmpty()) {
            String guessed = URLUtil.guessFileName(uri.toString(), contentDisposition, mimeType);
            if (guessed != null && !guessed.isEmpty() && !"downloadfile.bin".equals(guessed)) {
                return guessed;
            }
        }
        String lastSegment = uri.getLastPathSegment();
        if (lastSegment != null && !lastSegment.trim().isEmpty()) {
            String clean = Uri.decode(lastSegment).replaceAll("[/\\\\:*?\"<>|]", "_").trim();
            if (!clean.isEmpty()) return clean;
        }
        return URLUtil.guessFileName(uri.toString(), contentDisposition, mimeType);
    }

    private void cancelPendingFileCallback() {
        if (pendingFileCallback != null) {
            pendingFileCallback.onReceiveValue(null);
            pendingFileCallback = null;
        }
        pendingChooserParams = null;
        pendingCameraUri = null;
    }

    private void launchCameraCapture() {
        try {
            File dir = new File(getCacheDir(), "camera");
            if (!dir.exists()) {
                //noinspection ResultOfMethodCallIgnored
                dir.mkdirs();
            }
            String stamp = new SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(new Date());
            File photo = File.createTempFile("foto_" + stamp + "_", ".jpg", dir);
            pendingCameraUri = FileProvider.getUriForFile(this, BuildConfig.APPLICATION_ID + ".fileprovider", photo);
            cameraCaptureLauncher.launch(pendingCameraUri);
        } catch (IOException | ActivityNotFoundException e) {
            pendingCameraUri = null;
            launchFilePicker(pendingChooserParams);
        }
    }

    private void launchFilePicker(@Nullable WebChromeClient.FileChooserParams params) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);

        boolean allowMultiple = params != null && params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE;
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, allowMultiple);

        String[] acceptTypes = params != null ? params.getAcceptTypes() : null;
        List<String> validTypes = new ArrayList<>();
        if (acceptTypes != null) {
            for (String t : acceptTypes) {
                if (t != null && !t.trim().isEmpty()) {
                    validTypes.add(t.trim());
                }
            }
        }

        if (validTypes.size() == 1) {
            intent.setType(validTypes.get(0));
        } else {
            intent.setType("*/*");
            if (validTypes.size() > 1) {
                intent.putExtra(Intent.EXTRA_MIME_TYPES, validTypes.toArray(new String[0]));
            }
        }

        try {
            filePickerLauncher.launch(Intent.createChooser(intent, "Pilih file"));
        } catch (ActivityNotFoundException e) {
            cancelPendingFileCallback();
            Toast.makeText(this, "Tidak dapat membuka pemilih file.", Toast.LENGTH_SHORT).show();
        }
    }

    private void hideSplash() {
        if (splashHidden) return;
        splashHidden = true;
        splashOverlay.animate()
            .alpha(0f)
            .setDuration(180)
            .withEndAction(() -> splashOverlay.setVisibility(View.GONE))
            .start();
    }

    @SuppressWarnings("deprecation")
    private void applySystemChromeTheme(String bgHex, boolean isDark) {
        int bgColor;
        try {
            bgColor = Color.parseColor(bgHex);
        } catch (Exception e) {
            bgColor = Color.parseColor(isDark ? DARK_BG : LIGHT_BG);
        }

        Window window = getWindow();
        window.getDecorView().setBackgroundColor(bgColor);
        rootContainer.setBackgroundColor(bgColor);
        webView.setBackgroundColor(bgColor);

        if (Build.VERSION.SDK_INT < 35) {
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? Color.TRANSPARENT : Color.BLACK);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.setNavigationBarContrastEnforced(false);
            window.setStatusBarContrastEnforced(false);
        }

        WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, window.getDecorView());
        controller.setAppearanceLightStatusBars(!isDark);
        controller.setAppearanceLightNavigationBars(!isDark);
        applyInAppBrowserTheme(isDark);
    }

    private void startNativeSpeechRecognizer(String lang) {
        destroySpeechRecognizer();
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            dispatchVoiceEvent("onError", JSONObject.quote("unavailable"));
            return;
        }
        speechRecognizer = SpeechRecognizer.createSpeechRecognizer(this);
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle params) {}
            @Override public void onBeginningOfSpeech() {}
            @Override public void onRmsChanged(float rmsdB) {}
            @Override public void onBufferReceived(byte[] buffer) {}
            @Override public void onEndOfSpeech() {}

            @Override
            public void onError(int error) {
                String code;
                if (error == SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS) {
                    code = "not-allowed";
                } else if (error == SpeechRecognizer.ERROR_AUDIO) {
                    code = "audio-capture";
                } else if (error == SpeechRecognizer.ERROR_NETWORK || error == SpeechRecognizer.ERROR_NETWORK_TIMEOUT) {
                    code = "network";
                } else if (error == SpeechRecognizer.ERROR_NO_MATCH || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT) {
                    code = "no-speech";
                } else if (error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED || error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE) {
                    code = "language-not-supported";
                } else {
                    code = "error-" + error;
                }
                destroySpeechRecognizer();
                dispatchVoiceEvent("onError", JSONObject.quote(code));
            }

            @Override
            public void onResults(Bundle results) {
                ArrayList<String> matches = results != null
                    ? results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    : null;
                if (matches != null && !matches.isEmpty()) {
                    dispatchVoiceEvent("onResult", JSONObject.quote(matches.get(0)) + ", true");
                }
                destroySpeechRecognizer();
                dispatchVoiceEvent("onEnd", "");
            }

            @Override
            public void onPartialResults(Bundle partialResults) {
                ArrayList<String> matches = partialResults != null
                    ? partialResults.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                    : null;
                if (matches != null && !matches.isEmpty()) {
                    dispatchVoiceEvent("onResult", JSONObject.quote(matches.get(0)) + ", false");
                }
            }

            @Override public void onEvent(int eventType, Bundle params) {}
        });

        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, (lang != null && !lang.isEmpty()) ? lang : "id-ID");
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);

        try {
            speechRecognizer.startListening(intent);
        } catch (Exception e) {
            destroySpeechRecognizer();
            dispatchVoiceEvent("onError", JSONObject.quote("unavailable"));
        }
    }

    private void destroySpeechRecognizer() {
        if (speechRecognizer != null) {
            try { speechRecognizer.cancel(); } catch (Exception ignored) {}
            try { speechRecognizer.destroy(); } catch (Exception ignored) {}
            speechRecognizer = null;
        }
    }

    private void dispatchVoiceEvent(String method, String argsJs) {
        runOnUiThread(() -> {
            if (webView == null) return;
            String js = "window.__antigptVoice && window.__antigptVoice." + method + "(" + argsJs + ");";
            webView.evaluateJavascript(js, null);
        });
    }

    private class NativeBridge {
        @JavascriptInterface
        public void setTheme(String bgHex, boolean isDark) {
            runOnUiThread(() -> applySystemChromeTheme(bgHex, isDark));
        }

        @JavascriptInterface
        public boolean isVoiceAvailable() {
            return SpeechRecognizer.isRecognitionAvailable(MainActivity.this);
        }

        @JavascriptInterface
        public void startVoice(String lang) {
            runOnUiThread(() -> {
                if (ContextCompat.checkSelfPermission(MainActivity.this, Manifest.permission.RECORD_AUDIO)
                    == PackageManager.PERMISSION_GRANTED) {
                    startNativeSpeechRecognizer(lang);
                } else {
                    pendingVoiceLang = (lang != null && !lang.isEmpty()) ? lang : "id-ID";
                    micPermissionLauncher.launch(Manifest.permission.RECORD_AUDIO);
                }
            });
        }

        @JavascriptInterface
        public void stopVoice() {
            runOnUiThread(() -> {
                if (speechRecognizer != null) {
                    try { speechRecognizer.stopListening(); } catch (Exception ignored) {}
                }
            });
        }

        @JavascriptInterface
        public void abortVoice() {
            runOnUiThread(MainActivity.this::destroySpeechRecognizer);
        }

        @JavascriptInterface
        public void watchJob(String chatId, String title, int lastSeq) {
            if (chatId == null || chatId.trim().isEmpty()) return;
            final String cleanId = chatId.trim();
            final String cleanTitle = title != null ? title.trim() : "";
            runOnUiThread(() -> {
                synchronized (watchedJobs) {
                    WatchedJob cur = watchedJobs.get(cleanId);
                    if (cur != null) {
                        if (!cleanTitle.isEmpty()) cur.title = cleanTitle;
                        if (lastSeq > cur.seq) cur.seq = lastSeq;
                    } else {
                        watchedJobs.put(cleanId, new WatchedJob(cleanId, cleanTitle, lastSeq));
                    }
                }
                maybePromptNotifPermissionOnce();
            });
        }

        @JavascriptInterface
        public void updateJobSeq(String chatId, int lastSeq) {
            if (chatId == null || chatId.trim().isEmpty()) return;
            final String cleanId = chatId.trim();
            synchronized (watchedJobs) {
                WatchedJob cur = watchedJobs.get(cleanId);
                if (cur != null && lastSeq > cur.seq) {
                    cur.seq = lastSeq;
                }
            }
        }

        @JavascriptInterface
        public void unwatchJob(String chatId) {
            if (chatId == null || chatId.trim().isEmpty()) return;
            final String cleanId = chatId.trim();
            runOnUiThread(() -> {
                synchronized (watchedJobs) {
                    watchedJobs.remove(cleanId);
                }
                try {
                    NotificationManagerCompat.from(MainActivity.this)
                        .cancel(JobWatchService.resultNotificationId(cleanId));
                } catch (Exception ignored) {
                }
            });
        }

        @JavascriptInterface
        public String getNotificationState() {
            return buildNotificationStateJson();
        }

        @JavascriptInterface
        public void setNotificationsEnabled(boolean enabled) {
            runOnUiThread(() -> {
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
                prefs.edit().putBoolean(PREF_NOTIF_ENABLED, enabled).apply();
                if (!enabled) {
                    stopJobWatchServiceSafe();
                    dispatchNotifStateToWeb();
                    return;
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !hasNotificationPermission()) {
                    boolean prompted = prefs.getBoolean(PREF_NOTIF_PROMPTED, false);
                    boolean canPrompt = !prompted
                        || ActivityCompat.shouldShowRequestPermissionRationale(
                            MainActivity.this,
                            Manifest.permission.POST_NOTIFICATIONS
                        );
                    if (canPrompt) {
                        prefs.edit().putBoolean(PREF_NOTIF_PROMPTED, true).apply();
                        notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
                    } else {
                        openAppNotificationSettings();
                    }
                }
                dispatchNotifStateToWeb();
            });
        }

        @JavascriptInterface
        public void openNotificationSettings() {
            runOnUiThread(MainActivity.this::openAppNotificationSettings);
        }

        @JavascriptInterface
        public String consumePendingChatId() {
            String id = pendingOpenChatId;
            pendingOpenChatId = null;
            return id != null ? id : "";
        }
    }

    private boolean isNotificationsEnabledPref() {
        return getSharedPreferences(PREFS_NAME, MODE_PRIVATE).getBoolean(PREF_NOTIF_ENABLED, true);
    }

    private boolean hasNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        }
        return NotificationManagerCompat.from(this).areNotificationsEnabled();
    }

    private void maybePromptNotifPermissionOnce() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
        if (!prefs.getBoolean(PREF_NOTIF_ENABLED, true)) return;
        if (prefs.getBoolean(PREF_NOTIF_PROMPTED, false)) return;
        if (hasNotificationPermission()) {
            prefs.edit().putBoolean(PREF_NOTIF_PROMPTED, true).apply();
            return;
        }
        prefs.edit().putBoolean(PREF_NOTIF_PROMPTED, true).apply();
        notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS);
    }

    private String buildNotificationStateJson() {
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE);
            JSONObject obj = new JSONObject();
            obj.put("supported", true);
            obj.put("enabled", prefs.getBoolean(PREF_NOTIF_ENABLED, true));
            obj.put("granted", hasNotificationPermission());
            obj.put("systemEnabled", NotificationManagerCompat.from(this).areNotificationsEnabled());
            obj.put("prompted", prefs.getBoolean(PREF_NOTIF_PROMPTED, false));
            return obj.toString();
        } catch (Exception e) {
            return "{\"supported\":true,\"enabled\":true,\"granted\":true,\"systemEnabled\":true}";
        }
    }

    private void dispatchNotifStateToWeb() {
        if (webView == null) return;
        String json = buildNotificationStateJson();
        webView.evaluateJavascript(
            "window.__antigptNotifStateChanged&&window.__antigptNotifStateChanged(" + json + ")",
            null
        );
    }

    private void openAppNotificationSettings() {
        try {
            Intent intent = new Intent();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                intent.setAction(Settings.ACTION_APP_NOTIFICATION_SETTINGS);
                intent.putExtra(Settings.EXTRA_APP_PACKAGE, getPackageName());
            } else {
                intent.setAction(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                intent.setData(Uri.fromParts("package", getPackageName(), null));
            }
            startActivity(intent);
        } catch (Exception ignored) {
            Toast.makeText(this, "Buka Pengaturan HP → Aplikasi → AntiGPT → Notifikasi", Toast.LENGTH_LONG).show();
        }
    }

    private void extractOpenChatFromIntent(@Nullable Intent intent) {
        if (intent == null) return;
        String chatId = intent.getStringExtra(JobWatchService.EXTRA_OPEN_CHAT_ID);
        if (chatId != null && !chatId.trim().isEmpty()) {
            pendingOpenChatId = chatId.trim();
            intent.removeExtra(JobWatchService.EXTRA_OPEN_CHAT_ID);
        }
    }

    private void dispatchPendingOpenChat() {
        if (!pageLoaded || webView == null) return;
        String chatId = pendingOpenChatId;
        if (chatId == null || chatId.isEmpty()) return;
        webView.evaluateJavascript(
            "(function(){if(window.__antigptOpenChat){window.__antigptOpenChat(" + JSONObject.quote(chatId) + ");return true;}return false;})()",
            value -> {
                if ("true".equals(value) && chatId.equals(pendingOpenChatId)) {
                    pendingOpenChatId = null;
                }
            }
        );
    }

    private void startJobWatchServiceIfNeeded() {
        if (!isNotificationsEnabledPref() || !hasNotificationPermission()) return;
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return;

        JSONArray arr = new JSONArray();
        synchronized (watchedJobs) {
            if (watchedJobs.isEmpty()) return;
            for (WatchedJob j : watchedJobs.values()) {
                try {
                    JSONObject o = new JSONObject();
                    o.put("id", j.id);
                    o.put("title", j.title);
                    o.put("seq", j.seq);
                    arr.put(o);
                } catch (Exception ignored) {
                }
            }
        }
        if (arr.length() == 0) return;

        try {
            Intent svc = new Intent(this, JobWatchService.class);
            svc.putExtra(JobWatchService.EXTRA_JOBS_JSON, arr.toString());
            String cookie = CookieManager.getInstance().getCookie(APP_URL);
            if (cookie != null && !cookie.isEmpty()) {
                svc.putExtra(JobWatchService.EXTRA_COOKIE, cookie);
            }
            ContextCompat.startForegroundService(this, svc);
        } catch (Exception ignored) {
            // Aman jika OS menolak background FGS start di kondisi ekstrem
        }
    }

    private void stopJobWatchServiceSafe() {
        try {
            stopService(new Intent(this, JobWatchService.class));
        } catch (Exception ignored) {
        }
    }

    @Override
    protected void onNewIntent(@NonNull Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        extractOpenChatFromIntent(intent);
        dispatchPendingOpenChat();
    }

    @Override
    protected void onResume() {
        super.onResume();
        stopJobWatchServiceSafe();
        List<String> finished = JobWatchService.consumeFinishedJobIds();
        if (!finished.isEmpty()) {
            synchronized (watchedJobs) {
                for (String id : finished) watchedJobs.remove(id);
            }
        }
        dispatchNotifStateToWeb();
        dispatchPendingOpenChat();
    }

    @Override
    protected void onSaveInstanceState(@NonNull Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        if (!isChangingConfigurations()) {
            startJobWatchServiceIfNeeded();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        destroyInAppWebView();
        destroySpeechRecognizer();
        cancelPendingFileCallback();
        if (webView != null) {
            webView.destroy();
        }
        super.onDestroy();
    }
}
