package com.hostcaster.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * HostCasterLoopback: the 127.0.0.1 callback listener Sign in with ChatGPT requires
 * (redirect_uri http://127.0.0.1:<port>/auth/callback), on the phone. The browser tab is sent back here after consent;
 * the address goes to JS ('callback' event), which hands it to the Host-Caster server. The listener only answers GET
 * /auth/callback on 127.0.0.1 and stops after the first one (or on stop()). With `done` (the app's own deep link,
 * hostcaster://chatgpt) the tab is redirected there, which brings the app back to the front like the Google sign-in.
 */
@CapacitorPlugin(name = "HostCasterLoopback")
public class LoopbackPlugin extends Plugin {

    private static final String PATH = "/auth/callback";
    private ServerSocket server;
    private Thread thread;
    private String done;

    @PluginMethod
    public synchronized void start(PluginCall call) {
        stopServer();
        int port = call.getInt("port", 0);
        String back = call.getString("done");
        done = back != null && back.matches("^[a-z][a-z0-9+.-]*://[A-Za-z0-9/._-]*$") && !back.startsWith("http") ? back : null;
        try {
            server = new ServerSocket(port, 4, InetAddress.getByName("127.0.0.1"));
        } catch (IOException first) {
            try {
                server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
            } catch (IOException e) {
                call.reject("Could not listen on 127.0.0.1", e);
                return;
            }
        }
        final ServerSocket s = server;
        final int bound = s.getLocalPort();
        thread = new Thread(() -> serve(s, bound), "hostcaster-loopback");
        thread.setDaemon(true);
        thread.start();
        JSObject ret = new JSObject();
        ret.put("port", bound);
        call.resolve(ret);
    }

    @PluginMethod
    public synchronized void stop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    private synchronized void stopServer() {
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
                // closing
            }
        }
        server = null;
        thread = null;
    }

    private void serve(ServerSocket s, int port) {
        while (!s.isClosed()) {
            try (Socket client = s.accept()) {
                client.setSoTimeout(10000);
                BufferedReader in = new BufferedReader(new InputStreamReader(client.getInputStream(), StandardCharsets.UTF_8));
                String requestLine = in.readLine();
                String host = "";
                String line;
                while ((line = in.readLine()) != null && !line.isEmpty()) {
                    if (line.regionMatches(true, 0, "host:", 0, 5)) host = line.substring(5).trim();
                }
                String[] parts = requestLine == null ? new String[0] : requestLine.split(" ");
                String target = parts.length >= 2 ? parts[1] : "";
                boolean ours = parts.length >= 2 && "GET".equals(parts[0]) && (target.equals(PATH) || target.startsWith(PATH + "?"))
                        && host.equals("127.0.0.1:" + port);
                OutputStream out = client.getOutputStream();
                if (!ours) {
                    respond(out, "404 Not Found", "Not found");
                    continue;
                }
                if (done != null) redirect(out, done);
                else respond(out, "200 OK", page());
                JSObject data = new JSObject();
                data.put("url", "http://127.0.0.1:" + port + target);
                notifyListeners("callback", data, true);
                break;
            } catch (IOException e) {
                if (s.isClosed()) return;
            }
        }
        synchronized (this) {
            if (server == s) stopServer();
            else {
                try {
                    s.close();
                } catch (IOException ignored) {
                    // closing
                }
            }
        }
    }

    private static String page() {
        return "<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
                + "<title>Return to Host-Caster</title><style>body{font:17px/1.5 system-ui,sans-serif;max-width:32rem;margin:16vh auto;"
                + "padding:24px;color:#f4f4f5;background:#0a0a0b}h1{font-size:24px;margin:0 0 8px}</style>"
                + "<h1>Return to Host-Caster</h1><p>Host-Caster is finishing your ChatGPT connection. You can close this tab.</p>"
                + "<script>history.replaceState(null,'','/auth/complete')</script></html>";
    }

    private static void redirect(OutputStream out, String location) throws IOException {
        String head = "HTTP/1.1 302 Found\r\nLocation: " + location + "\r\nCache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n"
                + "Content-Length: 0\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    private static void respond(OutputStream out, String status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + "\r\nContent-Type: text/html; charset=utf-8\r\nCache-Control: no-store\r\n"
                + "Referrer-Policy: no-referrer\r\nContent-Length: " + bytes.length + "\r\nConnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(bytes);
        out.flush();
    }
}
