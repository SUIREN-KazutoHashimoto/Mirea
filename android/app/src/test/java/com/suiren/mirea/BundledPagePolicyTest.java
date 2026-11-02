package com.suiren.mirea;

import android.util.Base64;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class BundledPagePolicyTest {
    @Test public void fallbackBootstrapIsHashedWithoutAllowingArbitraryInlineScripts() throws Exception {
        String script = "window.Capacitor = {};\nwindow.bootstrapReady = true;";
        String html = "<html><head><script>" + script.replace("\n", "\r\n") + "</script><script src=\"/assets/app.js\" type=\"module\"></script></head></html>";
        WebResourceResponse response = new WebResourceResponse("text/html", "UTF-8", 200, "OK", Map.of("Cache-Control", "no-cache"),
            new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
        WebResourceResponse secured = BundledPagePolicy.protect(response);
        String csp = secured.getResponseHeaders().get("Content-Security-Policy");
        String hash = Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(script.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP);
        assertTrue(csp.contains("'sha256-" + hash + "'"));
        String scripts = csp.substring(csp.indexOf("script-src"), csp.indexOf("; style-src"));
        assertFalse(scripts.contains("'unsafe-inline'"));
        assertFalse(scripts.contains("https:"));
        assertFalse(scripts.contains("'unsafe-eval'"));
        assertEquals("no-cache", secured.getResponseHeaders().get("Cache-Control"));
        assertEquals("nosniff", secured.getResponseHeaders().get("X-Content-Type-Options"));
        assertEquals(html.replace("\r\n", "\n"), new String(secured.getData().readAllBytes(), StandardCharsets.UTF_8));
    }

    @Test public void modernBootstrapAllowsBundledModulesPdfWorkersAndHttpsMedia() throws Exception {
        String csp = BundledPagePolicy.policy("<html><head><script type=module src=/assets/app.js></script></head></html>");
        assertFalse(csp.contains("sha256-"));
        assertTrue(csp.contains("script-src 'self' 'wasm-unsafe-eval'"));
        assertTrue(csp.contains("connect-src 'self' https:"));
        assertTrue(csp.contains("media-src 'self' https: blob:"));
        assertTrue(csp.contains("worker-src 'self' blob:"));
        assertTrue(csp.contains("frame-src 'self' blob:"));
    }
}
