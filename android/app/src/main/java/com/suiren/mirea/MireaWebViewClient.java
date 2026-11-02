package com.suiren.mirea;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.net.URI;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.ArrayList;

/** Keep pages with access to native plugins inside the bundled app origin. */
final class MireaWebViewClient extends BridgeWebViewClient {
    enum Navigation { DEFER, EXTERNAL, BLOCK }

    private final Uri appUrl;

    MireaWebViewClient(Bridge bridge) {
        this(bridge, Uri.parse(bridge.getAppUrl()));
    }

    MireaWebViewClient(Bridge bridge, Uri appUrl) {
        super(bridge);
        this.appUrl = appUrl;
    }

    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        // Mirea reads user-selected files through SAF and its own native
        // transfer APIs. These generic proxy routes must not expose local
        // files or remote scripts at the trusted app origin, even via a worker.
        if (blockedLocalRoute(request.getUrl())) {
            return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden", Map.of("Cache-Control", "no-store"),
                new ByteArrayInputStream("Unavailable resource".getBytes(StandardCharsets.UTF_8)));
        }
        WebResourceResponse response = super.shouldInterceptRequest(view, request);
        if (isBundledOrigin(request.getUrl(), appUrl)
                && response != null && "text/html".equalsIgnoreCase(response.getMimeType())) {
            return BundledPagePolicy.protect(response);
        }
        return response;
    }

    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Navigation navigation = navigation(request.getUrl(), appUrl, request.isForMainFrame());
        if (navigation == Navigation.DEFER) {
            if (request.isForMainFrame()) {
                Uri canonical = canonicalEntry(request.getUrl(), appUrl);
                if (canonical != null) {
                    // Existing download workers deliberately skip URLs with a
                    // query. Do not let an older cached shell replace this APK.
                    view.loadUrl(canonical.toString());
                    return true;
                }
            }
            // Retain Capacitor's blob/PDF/book frame handling. Generic local
            // file/content/HTTP proxies have already been rejected above.
            return super.shouldOverrideUrlLoading(view, request);
        }
        if (navigation == Navigation.EXTERNAL) {
            Intent intent = new Intent(Intent.ACTION_VIEW, request.getUrl()).addCategory(Intent.CATEGORY_BROWSABLE);
            try { view.getContext().startActivity(intent); }
            catch (ActivityNotFoundException | SecurityException ignored) { /* Keep the app open if no browser is available. */ }
        }
        return true;
    }

    static Navigation navigation(Uri destination, Uri appUrl, boolean mainFrame) {
        // This proxy must never become a document, including inside a frame.
        // Defense in depth alongside patched Capacitor (GHSA-rvm3-566m-v7fv).
        if (blockedLocalRoute(destination)) return Navigation.BLOCK;
        // This is a navigation boundary, not a restriction on media/file reads.
        if (!mainFrame) return Navigation.DEFER;
        URI target = webUri(destination), app = webUri(appUrl);
        if (target == null) return Navigation.BLOCK;
        if (app != null && target.getScheme().equalsIgnoreCase(app.getScheme())
                && target.getHost().equalsIgnoreCase(app.getHost()) && port(target) == port(app)) {
            return Navigation.DEFER;
        }
        return Navigation.EXTERNAL;
    }

    static boolean isBundledOrigin(Uri destination, Uri appUrl) {
        // Capacitor also serves its bundled index for extensionless paths.
        // Cover every trusted APK HTML response, including worker fetches,
        // without hashing an external or generic proxy response as trusted.
        return navigation(destination, appUrl, true) == Navigation.DEFER;
    }

    static Uri canonicalEntry(Uri destination, Uri appUrl) {
        if (!isBundledOrigin(destination, appUrl)) return null;
        final String marker = "mirea-native-shell", parameter = marker + "=1";
        ArrayList<String> query = new ArrayList<>();
        int markers = 0;
        boolean exactMarker = false;
        String encodedQuery = destination.getEncodedQuery();
        if (encodedQuery != null && !encodedQuery.isEmpty()) {
            for (String part : encodedQuery.split("&", -1)) {
                int equals = part.indexOf('=');
                String name = Uri.decode(equals < 0 ? part : part.substring(0, equals));
                if (marker.equals(name)) {
                    markers++;
                    exactMarker = parameter.equals(part);
                } else query.add(part);
            }
        }
        // Keep an existing canonical URL (and its fragment) without reloading.
        if (destination.getScheme().equals(appUrl.getScheme())
                && destination.getEncodedAuthority().equals(appUrl.getEncodedAuthority())
                && "/index.html".equals(destination.getEncodedPath()) && markers == 1 && exactMarker) return null;
        query.add(parameter);
        return appUrl.buildUpon().encodedPath("/index.html").encodedQuery(String.join("&", query))
            .encodedFragment(destination.getEncodedFragment()).build();
    }

    private static boolean blockedLocalRoute(Uri destination) {
        if (destination == null || destination.getPath() == null) return false;
        String path = destination.getPath();
        return path.startsWith("/_capacitor_http_interceptor_") || path.startsWith("/_capacitor_file_")
            || path.startsWith("/_capacitor_content_");
    }

    private static URI webUri(Uri value) {
        if (value == null) return null;
        try {
            URI uri = new URI(value.toString()).parseServerAuthority();
            String scheme = uri.getScheme(), host = uri.getHost();
            if (!("https".equalsIgnoreCase(scheme) || "http".equalsIgnoreCase(scheme))
                    || host == null || host.isEmpty() || uri.getRawUserInfo() != null
                    || uri.getPort() == 0 || uri.getPort() > 65535) return null;
            return uri;
        } catch (Exception invalid) { return null; }
    }

    private static int port(URI uri) {
        return uri.getPort() == -1 ? ("https".equalsIgnoreCase(uri.getScheme()) ? 443 : 80) : uri.getPort();
    }
}
