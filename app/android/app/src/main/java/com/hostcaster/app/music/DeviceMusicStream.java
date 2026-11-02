package com.hostcaster.app.music;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.net.Uri;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import java.io.ByteArrayInputStream;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;

/**
 * Plays songs from where they are on the device: the app's WebView asks for /_hostcaster_device_/&lt;token&gt;/&lt;id&gt; on
 * its own origin, and this answers from MediaStore with HTTP ranges (seeking starts reading at the asked byte; the
 * Capacitor file server sends the whole file from byte 0 instead). Only MediaStore audio, only with the audio
 * permission, only with this run's token. Everything else goes to Capacitor as before.
 */
public class DeviceMusicStream extends BridgeWebViewClient {

    private final Context context;
    private final String host;

    public DeviceMusicStream(Bridge bridge) {
        super(bridge);
        context = bridge.getContext();
        host = Uri.parse(bridge.getLocalUrl()).getHost();
    }

    @Override
    public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if (path != null && path.startsWith(DeviceMusicPlugin.PREFIX) && host != null && host.equals(url.getHost())) {
            return serve(request, path.substring(DeviceMusicPlugin.PREFIX.length()));
        }
        return super.shouldInterceptRequest(view, request);
    }

    private WebResourceResponse serve(WebResourceRequest request, String rest) {
        String[] parts = rest.split("/");
        if (parts.length != 2 || !DeviceMusicPlugin.TOKEN.equals(parts[0])) return text(403, "Forbidden");
        if (!DeviceMusicPlugin.granted(context)) return text(403, "Forbidden");
        long id;
        try {
            id = Long.parseLong(parts[1]);
        } catch (NumberFormatException e) {
            return text(404, "Not Found");
        }
        ContentResolver cr = context.getContentResolver();
        Uri uri = ContentUris.withAppendedId(DeviceMusicPlugin.collection(), id);
        AssetFileDescriptor afd;
        try {
            afd = cr.openAssetFileDescriptor(uri, "r");
        } catch (Exception e) {
            return text(404, "Not Found");
        }
        if (afd == null) return text(404, "Not Found");
        try {
            long length = afd.getLength();
            if (length < 0) length = afd.getParcelFileDescriptor().getStatSize();
            long[] range = parseRange(header(request, "Range"), length);
            if (range != null && range[0] < 0) {
                afd.close();
                Map<String, String> h = new HashMap<>();
                h.put("Content-Range", "bytes */" + length);
                return new WebResourceResponse("text/plain", "utf-8", 416, "Range Not Satisfiable", h, empty());
            }
            long start = range != null ? range[0] : 0;
            long end = range != null ? range[1] : length - 1;
            FileInputStream in = afd.createInputStream();
            in.getChannel().position(afd.getStartOffset() + start);
            Map<String, String> h = new HashMap<>();
            h.put("Accept-Ranges", "bytes");
            h.put("Content-Length", String.valueOf(end - start + 1));
            h.put("Cache-Control", "no-store");
            if (range != null) h.put("Content-Range", "bytes " + start + "-" + end + "/" + length);
            String mime = cr.getType(uri);
            InputStream body = new Limited(in, end - start + 1, afd);
            return new WebResourceResponse(mime != null ? mime : "audio/mpeg", null, range != null ? 206 : 200, range != null ? "Partial Content" : "OK", h, body);
        } catch (IOException e) {
            try {
                afd.close();
            } catch (IOException ignored) {
                // closing
            }
            return text(500, "Internal Server Error");
        }
    }

    /**
     * "bytes=a-b", "bytes=a-" or "bytes=-n" -> {start, end}; null = no (usable) range header, whole file;
     * {-1, -1} = outside the file (416).
     */
    static long[] parseRange(String header, long length) {
        if (header == null || !header.startsWith("bytes=") || header.contains(",")) return null;
        String spec = header.substring(6).trim();
        int dash = spec.indexOf('-');
        if (dash < 0) return null;
        try {
            String a = spec.substring(0, dash).trim();
            String b = spec.substring(dash + 1).trim();
            long start;
            long end;
            if (a.isEmpty()) {
                if (b.isEmpty()) return null;
                long n = Long.parseLong(b);
                start = Math.max(0, length - n);
                end = length - 1;
            } else {
                start = Long.parseLong(a);
                end = b.isEmpty() ? length - 1 : Math.min(Long.parseLong(b), length - 1);
            }
            if (start >= length || start > end) return new long[] { -1, -1 };
            return new long[] { start, end };
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String header(WebResourceRequest r, String name) {
        Map<String, String> h = r.getRequestHeaders();
        if (h == null) return null;
        for (Map.Entry<String, String> e : h.entrySet()) if (name.equalsIgnoreCase(e.getKey())) return e.getValue();
        return null;
    }

    private static InputStream empty() {
        return new ByteArrayInputStream(new byte[0]);
    }

    private static WebResourceResponse text(int status, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, new HashMap<>(), new ByteArrayInputStream(reason.getBytes(StandardCharsets.UTF_8)));
    }

    /** Reads at most `left` bytes, then closes the file. */
    private static final class Limited extends FilterInputStream {

        private long left;
        private final AssetFileDescriptor afd;

        Limited(InputStream in, long left, AssetFileDescriptor afd) {
            super(in);
            this.left = left;
            this.afd = afd;
        }

        @Override
        public int read() throws IOException {
            if (left <= 0) return -1;
            int b = super.read();
            if (b >= 0) left--;
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (left <= 0) return -1;
            int n = super.read(buf, off, (int) Math.min(len, left));
            if (n > 0) left -= n;
            return n;
        }

        @Override
        public int available() throws IOException {
            return (int) Math.min(super.available(), left);
        }

        @Override
        public void close() throws IOException {
            try {
                super.close();
            } finally {
                afd.close();
            }
        }
    }
}
