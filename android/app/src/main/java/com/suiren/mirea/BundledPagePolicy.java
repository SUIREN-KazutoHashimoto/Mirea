package com.suiren.mirea;

import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** CSP for the trusted APK index only; never call this for downloaded content. */
final class BundledPagePolicy {
    private static final int MAX_BUNDLED_HTML_BYTES = 2 * 1024 * 1024;
    private static final Pattern SCRIPT = Pattern.compile("<script\\b[^>]*>([\\s\\S]*?)</script\\s*>", Pattern.CASE_INSENSITIVE);

    static WebResourceResponse protect(WebResourceResponse response) {
        try (InputStream input = response.getData(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            int count;
            while ((count = input.read(buffer)) != -1) {
                if (bytes.size() + count > MAX_BUNDLED_HTML_BYTES) throw new IllegalStateException("Bundled HTML exceeds limit");
                bytes.write(buffer, 0, count);
            }
            String html = bytes.toString(StandardCharsets.UTF_8.name()).replace("\r\n", "\n").replace('\r', '\n');
            Map<String, String> headers = new HashMap<>();
            if (response.getResponseHeaders() != null) headers.putAll(response.getResponseHeaders());
            headers.put("Content-Security-Policy", policy(html));
            headers.put("X-Content-Type-Options", "nosniff");
            response.setResponseHeaders(headers);
            response.setData(new ByteArrayInputStream(html.getBytes(StandardCharsets.UTF_8)));
            return response;
        } catch (Exception invalid) {
            return new WebResourceResponse("text/plain", "UTF-8", 500, "App page unavailable", Map.of("Cache-Control", "no-store"),
                new ByteArrayInputStream("Mireaの画面を読み込めません。アプリを開き直してください。".getBytes(StandardCharsets.UTF_8)));
        }
    }

    static String policy(String html) throws Exception {
        // Older WebViews get Capacitor's bootstrap inserted into this trusted
        // APK response. Hash that exact script instead of allowing inline code.
        Set<String> hashes = new LinkedHashSet<>();
        Matcher scripts = SCRIPT.matcher(html);
        while (scripts.find()) {
            String script = scripts.group(1);
            if (!script.isBlank()) {
                byte[] digest = MessageDigest.getInstance("SHA-256").digest(script.getBytes(StandardCharsets.UTF_8));
                hashes.add("'sha256-" + Base64.getEncoder().encodeToString(digest) + "'");
            }
        }
        return "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' " + String.join(" ", hashes)
            + "; style-src 'self' 'unsafe-inline'; img-src 'self' https: data: blob:; media-src 'self' https: blob:;"
            + " connect-src 'self' https:; worker-src 'self' blob:; frame-src 'self' blob:;"
            + " object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'";
    }
}
