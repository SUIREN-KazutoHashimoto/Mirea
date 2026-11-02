package com.suiren.mirea;

import android.net.Uri;
import android.webkit.WebResourceRequest;
import java.util.Map;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
import static com.suiren.mirea.MireaWebViewClient.Navigation.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class WebViewNavigationTest {
    private MireaWebViewClient.Navigation navigation(String url, boolean mainFrame) {
        return MireaWebViewClient.navigation(Uri.parse(url), Uri.parse("https://localhost/"), mainFrame);
    }

    @Test public void bundledRoutesKeepWorkingButOtherPortsAreExternal() {
        assertEquals(DEFER, navigation("https://localhost/#library", true));
        assertEquals(DEFER, navigation("https://localhost:443/index.html", true));
        assertEquals(EXTERNAL, navigation("https://localhost:8443/", true));
        assertEquals(EXTERNAL, navigation("http://localhost/", true));
        assertEquals(EXTERNAL, navigation("https://localhost.example.com/", true));
    }

    @Test public void projectServerAndBookWebLinksOpenOutsideNativeBridge() {
        assertEquals(EXTERNAL, navigation("https://github.com/SUIREN-KazutoHashimoto/Mirea", true));
        assertEquals(EXTERNAL, navigation("https://192.0.2.10:8443/api/android/apk", true));
        assertEquals(EXTERNAL, navigation("http://example.com/chapter?x=1#section", true));
    }

    @Test public void unsafeOrAmbiguousTopLevelDocumentsAreBlocked() {
        for (String url : new String[]{"data:text/html,<script>test()</script>", "blob:https://localhost/document",
                "file:///data/data/com.suiren.mirea/files/private.html", "content://another.provider/document",
                "javascript:alert(1)", "intent://scan/#Intent;scheme=zxing;end", "https://user@localhost/",
                "https://localhost:0/", "https://localhost:65536/", "https://localhost\\@example.com/", "/relative"}) {
            assertEquals(url, BLOCK, navigation(url, true));
        }
    }

    @Test public void bookFramesRemainWithCapacitorsExistingHandler() {
        for (String url : new String[]{"blob:https://localhost/page", "data:text/html,book",
                "https://example.com/book.pdf"}) {
            assertEquals(url, DEFER, navigation(url, false));
        }
    }

    @Test public void genericLocalFileRoutesCannotBecomeDocumentsOrResources() {
        for (String url : new String[]{"https://localhost/_capacitor_content_/content/provider/document",
                "https://localhost/_capacitor_file_/storage/emulated/0/private.html"}) {
            assertEquals(BLOCK, navigation(url, true));
            assertEquals(BLOCK, navigation(url, false));
            assertFalse(MireaWebViewClient.isBundledOrigin(Uri.parse(url), Uri.parse("https://localhost/")));
        }
    }

    @Test public void internalHttpProxyCanNeverBecomeATrustedDocument() {
        String url = "https://localhost/_capacitor_http_interceptor_?u=https%3A%2F%2Fexample.com";
        assertEquals(BLOCK, navigation(url, true));
        assertEquals(BLOCK, navigation(url, false));
        assertFalse(MireaWebViewClient.isBundledOrigin(Uri.parse(url), Uri.parse("https://localhost/")));
        assertFalse(MireaWebViewClient.isBundledOrigin(Uri.parse("https://localhost/_capacitor_file_/index.html"), Uri.parse("https://localhost/")));
        assertFalse(MireaWebViewClient.isBundledOrigin(Uri.parse("https://example.com/index.html"), Uri.parse("https://localhost/")));
        assertTrue(MireaWebViewClient.isBundledOrigin(Uri.parse("https://localhost/index.html"), Uri.parse("https://localhost/")));
        assertTrue(MireaWebViewClient.isBundledOrigin(Uri.parse("https://localhost/library/series"), Uri.parse("https://localhost/")));
    }

    private Uri canonical(String url) {
        return MireaWebViewClient.canonicalEntry(Uri.parse(url), Uri.parse("https://localhost/index.html?mirea-native-shell=1"));
    }

    @Test public void localMainFrameEntriesAlwaysBypassLegacyQuerylessShellCaches() {
        for (String path : new String[]{"", "/", "/index.html", "/library/series", "/other.html"}) {
            assertEquals("https://localhost/index.html?mirea-native-shell=1", canonical("https://localhost" + path).toString());
        }
        assertEquals("https://localhost/index.html?view=books%2Fa&filter=a+b&mirea-native-shell=1#chapter%202",
            canonical("https://localhost/library?view=books%2Fa&filter=a+b#chapter%202").toString());
        assertEquals("https://localhost/index.html?view=books&mirea-native-shell=1#chapter",
            canonical("https://localhost/?mirea-native-shell=0&view=books&%6direa-native-shell=2#chapter").toString());
    }

    @Test public void canonicalEntriesAndNonBundledDestinationsAreNotRewritten() {
        for (String url : new String[]{"https://localhost/index.html?mirea-native-shell=1",
                "https://localhost/index.html?mirea-native-shell=1&view=books#chapter",
                "https://localhost/index.html?view=books&mirea-native-shell=1#chapter",
                "https://localhost:8443/index.html", "https://example.com/book.pdf", "blob:https://localhost/book",
                "https://localhost/_capacitor_http_interceptor_?u=https://example.com", "https://localhost/_capacitor_file_/page.html"}) {
            assertNull(url, canonical(url));
        }
    }

    @Test public void equivalentOriginsUseTheConfiguredAssetOriginExactlyOnce() {
        for (String origin : new String[]{"https://localhost:443", "https://LOCALHOST", "HTTPS://LOCALHOST:443"}) {
            Uri target = canonical(origin + "/index.html?view=books%2Fa&mirea-native-shell=1#chapter%202");
            assertNotNull(origin, target);
            assertEquals("https://localhost/index.html?view=books%2Fa&mirea-native-shell=1#chapter%202", target.toString());
            assertNull(canonical(target.toString()));
        }
    }

    @Test public void genericProxyResourcesAreRejectedBeforeAnyBridgeOrNetworkAccess() {
        var client = new MireaWebViewClient(null, Uri.parse("https://localhost/"));
        for (String path : new String[]{"/_capacitor_file_/private.js", "/_capacitor_content_/provider/private.js",
                "/_capacitor_http_interceptor_?u=https://example.com/payload.js", "/%5Fcapacitor_file_/private.js"}) {
            WebResourceRequest request = new WebResourceRequest() {
                public Uri getUrl() { return Uri.parse("https://localhost" + path); }
                public boolean isForMainFrame() { return false; }
                public boolean isRedirect() { return false; }
                public boolean hasGesture() { return false; }
                public String getMethod() { return "GET"; }
                public Map<String,String> getRequestHeaders() { return Map.of(); }
            };
            var response = client.shouldInterceptRequest(null, request);
            assertNotNull(path, response);
            assertEquals(path, 403, response.getStatusCode());
            assertEquals("no-store", response.getResponseHeaders().get("Cache-Control"));
        }
    }
}
