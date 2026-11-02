package com.suiren.mirea;

import com.getcapacitor.CapConfig;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginConfig;
import com.getcapacitor.plugin.CapacitorCookies;
import com.getcapacitor.plugin.CapacitorHttp;
import java.net.CookieHandler;
import java.net.CookieManager;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.function.Consumer;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Robolectric;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.Shadows;
import org.robolectric.android.controller.ActivityController;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowLog;
import org.robolectric.shadows.ShadowWebView;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class NativeBridgeIsolationTest {
    public static class StartupActivity extends MainActivity {
        @Override protected void load() {
            // Robolectric has no Android WebView provider for the platform
            // ServiceWorkerController. Keep the packaged plugin configuration
            // and actual Bridge startup, omitting only that platform adapter.
            try (var stream = getAssets().open("capacitor.config.json")) {
                var settings = new org.json.JSONObject(new String(stream.readAllBytes(), StandardCharsets.UTF_8));
                settings.getJSONObject("android").put("resolveServiceWorkerRequests", false);
                config = new CapConfig(getAssets(), settings);
            } catch (Exception error) { throw new AssertionError(error); }
            super.load();
        }
    }
    private static PluginConfig config(String name) {
        return CapConfig.loadDefault(RuntimeEnvironment.getApplication()).getPluginConfiguration(name);
    }
    public static class Cookies extends CapacitorCookies {
        @Override public PluginConfig getConfig() { return config("CapacitorCookies"); }
        void destroy() { handleOnDestroy(); }
    }
    public static class Http extends CapacitorHttp {
        @Override public PluginConfig getConfig() { return config("CapacitorHttp"); }
        void destroy() { handleOnDestroy(); }
    }
    private static class Call extends PluginCall {
        boolean unavailable;
        Call() { super(null, "disabled", "test", "method", new JSObject()); }
        @Override public void unavailable(String message) { unavailable = true; }
    }
    private static void rejects(Consumer<PluginCall> method) {
        Call call = new Call(); method.accept(call); assertTrue(call.unavailable);
    }

    @Test public void cookiesDoNotRegisterAGlobalHandlerOrLogValues() {
        CookieHandler previous = CookieHandler.getDefault();
        CookieHandler sentinel = new CookieManager();
        CookieHandler.setDefault(sentinel);
        ShadowLog.clear();
        try {
            Cookies cookies = new Cookies();
            cookies.load(); // No Bridge/WebView is present: neither may be accessed when disabled.
            assertSame(sentinel, CookieHandler.getDefault());
            assertFalse(cookies.isEnabled());
            cookies.setCookie("https://example.com", "synthetic_secret=do-not-log");
            rejects(cookies::getCookies); rejects(cookies::setCookie); rejects(cookies::deleteCookie);
            rejects(cookies::clearCookies); rejects(cookies::clearAllCookies);
            cookies.destroy();
            assertSame(sentinel, CookieHandler.getDefault());
            assertTrue(ShadowLog.getLogs().stream().noneMatch(log -> log.msg.contains("synthetic_secret") || log.msg.contains("Setting cookie")));
        } finally { CookieHandler.setDefault(previous); }
    }

    @Test public void unusedNativeHttpCannotBypassTheBrowserOrOwnBearerClients() {
        Http http = new Http();
        http.load();
        assertFalse(http.isEnabled());
        rejects(http::request); rejects(http::get); rejects(http::post); rejects(http::put);
        rejects(http::patch); rejects(http::delete);
        http.destroy();
    }

    @Test public void realActivityStartupKeepsBearerPluginsWithoutCookieOrHttpInterfaces() {
        android.content.pm.PackageInfo webViewPackage = new android.content.pm.PackageInfo();
        webViewPackage.packageName = "com.android.webview";
        webViewPackage.versionName = "140.0.0";
        ShadowWebView.setCurrentWebViewPackage(webViewPackage);
        CookieHandler previous = CookieHandler.getDefault();
        CookieHandler sentinel = new CookieManager();
        CookieHandler.setDefault(sentinel);
        try (ActivityController<StartupActivity> controller = Robolectric.buildActivity(StartupActivity.class).setup()) {
            var bridge = controller.get().getBridge();
            assertNotNull(bridge);
            assertEquals("https://localhost/index.html?mirea-native-shell=1", bridge.getAppUrl());
            assertTrue(bridge.getWebViewClient() instanceof MireaWebViewClient);
            assertSame(sentinel, CookieHandler.getDefault());
            var webView = Shadows.shadowOf(bridge.getWebView());
            assertNull(webView.getJavascriptInterface("CapacitorCookiesAndroidInterface"));
            assertNull(webView.getJavascriptInterface("CapacitorHttpAndroidInterface"));
            assertNotNull(bridge.getPlugin("MireaSession"));
            assertNotNull(bridge.getPlugin("MireaPlayback"));
            assertNotNull(bridge.getPlugin("MireaTransfer"));
        } finally { CookieHandler.setDefault(previous); }
    }

    private static android.webkit.WebResourceRequest request(String url, boolean mainFrame) {
        return new android.webkit.WebResourceRequest() {
            public android.net.Uri getUrl() { return android.net.Uri.parse(url); }
            public boolean isForMainFrame() { return mainFrame; }
            public boolean isRedirect() { return false; }
            public boolean hasGesture() { return false; }
            public String getMethod() { return "GET"; }
            public Map<String,String> getRequestHeaders() { return Map.of(); }
        };
    }

    @Test public void localNavigationUsesApkEntryAndWorkerFallbackHtmlRetainsCsp() throws Exception {
        android.content.pm.PackageInfo webViewPackage = new android.content.pm.PackageInfo();
        webViewPackage.packageName = "com.android.webview";
        webViewPackage.versionName = "140.0.0";
        ShadowWebView.setCurrentWebViewPackage(webViewPackage);
        try (ActivityController<StartupActivity> controller = Robolectric.buildActivity(StartupActivity.class).setup()) {
            var bridge = controller.get().getBridge();
            var client = bridge.getWebViewClient();
            var view = bridge.getWebView();
            for (String path : new String[]{"/", "/library/series", "/index.html"}) {
                assertTrue(client.shouldOverrideUrlLoading(view, request("https://localhost" + path + "#library", true)));
                String canonical = "https://localhost/index.html?mirea-native-shell=1#library";
                assertEquals(canonical, Shadows.shadowOf(view).getLastLoadedUrl());
                assertFalse(client.shouldOverrideUrlLoading(view, request(canonical, true)));
            }
            // ServiceWorkerClient forwards requests through this same client.
            // Exercise real Capacitor index fallback, not only our URI helper.
            for (boolean mainFrame : new boolean[]{true, false}) {
                for (String path : new String[]{"/", "/index.html", "/library/series"}) {
                    var response = client.shouldInterceptRequest(view, request("https://localhost" + path, mainFrame));
                    assertNotNull(response);
                    assertEquals("text/html", response.getMimeType());
                    assertTrue(response.getResponseHeaders().get("Content-Security-Policy").contains("script-src 'self'"));
                    assertTrue(new String(response.getData().readAllBytes(), StandardCharsets.UTF_8).contains("<html"));
                    response.getData().close();
                }
            }
            var image = client.shouldInterceptRequest(view, request("https://localhost/brand/orbit-mark.svg", false));
            assertNotNull(image);
            assertEquals("image/svg+xml", image.getMimeType());
            assertNull(image.getResponseHeaders().get("Content-Security-Policy"));
            image.getData().close();
            assertFalse(client.shouldOverrideUrlLoading(view, request("blob:https://localhost/book", false)));
        }
    }
}
