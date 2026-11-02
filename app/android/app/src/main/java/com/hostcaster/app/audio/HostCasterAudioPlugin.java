package com.hostcaster.app.audio;

import android.Manifest;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.Base64;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * HostCasterAudio: background playback (foreground media service + MediaSession notification), audio focus for spoken
 * breaks over other apps, and "any music app" mode (other apps' now playing). JS side: app/src/core/native.
 */
@CapacitorPlugin(
    name = "HostCasterAudio",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = HostCasterAudioPlugin.NOTIFICATIONS) }
)
public class HostCasterAudioPlugin extends Plugin implements NowPlaying.Listener, AnyAppWatcher.Listener {

    static final String NOTIFICATIONS = "notifications";

    private NowPlaying nowPlaying;
    private AnyAppWatcher anyApp;
    private ClipPlayer clips;
    private final ExecutorService io = Executors.newSingleThreadExecutor();

    @Override
    public void load() {
        nowPlaying = NowPlaying.get(getContext());
        nowPlaying.setListener(this);
        anyApp = AnyAppWatcher.get(getContext());
        anyApp.setListener(this);
        clips = new ClipPlayer(getContext());
    }

    // ---------------------------------------------------------------- now playing / background playback

    @PluginMethod
    public void updateNowPlaying(PluginCall call) {
        final String title = call.getString("title", "");
        final String artist = call.getString("artist", "");
        final String album = call.getString("album", "");
        final long durationMs = toLong(call.getDouble("durationMs", 0d));
        final long positionMs = call.getData().has("positionMs") ? toLong(call.getDouble("positionMs", 0d)) : -1;
        final boolean playing = call.getBoolean("playing", false);
        final boolean canPrev = call.getBoolean("canPrev", true);
        final boolean canNext = call.getBoolean("canNext", true);
        final boolean ownAudio = call.getBoolean("ownAudio", true);
        final String artworkKey = call.getString("artworkKey");
        final String artworkBase64 = call.getString("artworkBase64");
        final String artworkUrl = call.getString("artworkUrl");
        final Bitmap inline = decode(artworkBase64);
        getBridge()
            .executeOnMainThread(() -> {
                boolean newPicture = artworkKey != null && !artworkKey.equals(nowPlaying.artworkKey());
                nowPlaying.update(title, artist, album, durationMs, positionMs, playing, canPrev, canNext, ownAudio, artworkKey, inline);
                if (inline == null && newPicture && artworkUrl != null && artworkUrl.startsWith("http")) fetchArtwork(artworkKey, artworkUrl);
                call.resolve();
            });
    }

    @PluginMethod
    public void clearNowPlaying(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                nowPlaying.clear();
                call.resolve();
            });
    }

    @Override
    public void onMediaAction(String action, long positionMs, String reason) {
        JSObject o = new JSObject();
        o.put("action", action);
        o.put("positionMs", positionMs);
        o.put("reason", reason);
        notifyListeners("media", o);
    }

    @Override
    public void onFocusChange(String state) {
        JSObject o = new JSObject();
        o.put("state", state);
        notifyListeners("focus", o);
    }

    // ---------------------------------------------------------------- spoken breaks over other apps

    @PluginMethod
    public void duck(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                JSObject r = new JSObject();
                r.put("result", nowPlaying.duck());
                call.resolve(r);
            });
    }

    /** A live call: full transient focus, so the music app pauses until releaseCallFocus. */
    @PluginMethod
    public void holdCallFocus(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                JSObject r = new JSObject();
                r.put("result", nowPlaying.holdForCall());
                call.resolve(r);
            });
    }

    @PluginMethod
    public void releaseCallFocus(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                nowPlaying.releaseCall();
                call.resolve();
            });
    }

    /** Plays a voice clip natively (base64 audio). Resolves when it has finished or was stopped. */
    @PluginMethod
    public void playClip(PluginCall call) {
        final String data = call.getString("base64", "");
        final String ext = call.getString("ext", "mp3");
        final float volume = call.getFloat("volume", 1f);
        final byte[] bytes;
        try {
            bytes = Base64.decode(data, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("The clip is not valid base64");
            return;
        }
        getBridge()
            .executeOnMainThread(() ->
                clips.play(bytes, ext, volume, (error) -> {
                    if (error == null) call.resolve();
                    else call.reject(error);
                })
            );
    }

    /** iOS resets its audio session after speech recognition; nothing to do on Android. */
    @PluginMethod
    public void restoreSession(PluginCall call) {
        call.resolve();
    }

    @PluginMethod
    public void stopClip(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                clips.stop();
                call.resolve();
            });
    }

    @PluginMethod
    public void releaseFocus(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                nowPlaying.releaseDuck();
                call.resolve();
            });
    }

    // ---------------------------------------------------------------- any music app

    @PluginMethod
    public void anyAppStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("supported", true);
        r.put("access", anyApp.hasAccess());
        r.put("running", anyApp.isRunning());
        call.resolve(r);
    }

    @PluginMethod
    public void anyAppStart(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                boolean ok = anyApp.start();
                JSObject r = new JSObject();
                r.put("access", anyApp.hasAccess());
                r.put("running", ok);
                if (ok) r.put("nowPlaying", anyApp.nowPlaying());
                call.resolve(r);
            });
    }

    @PluginMethod
    public void anyAppStop(PluginCall call) {
        getBridge()
            .executeOnMainThread(() -> {
                anyApp.stop();
                call.resolve();
            });
    }

    @PluginMethod
    public void anyAppNowPlaying(PluginCall call) {
        getBridge().executeOnMainThread(() -> call.resolve(anyApp.nowPlaying()));
    }

    @PluginMethod
    public void anyAppControl(PluginCall call) {
        final String action = call.getString("action", "");
        final long pos = toLong(call.getDouble("positionMs", 0d));
        getBridge()
            .executeOnMainThread(() -> {
                JSObject r = new JSObject();
                r.put("ok", anyApp.control(action, pos));
                call.resolve(r);
            });
    }

    @Override
    public void onTrack(JSObject track) {
        notifyListeners("anyAppTrack", track);
    }

    @Override
    public void onState(JSObject state) {
        nowPlaying.mirrorOtherApp(state.optBoolean("playing", false));
        notifyListeners("anyAppState", state);
    }

    // ---------------------------------------------------------------- device status + settings shortcuts

    @PluginMethod
    public void deviceStatus(PluginCall call) {
        JSObject r = new JSObject();
        r.put("platform", "android");
        r.put("sdk", Build.VERSION.SDK_INT);
        r.put("release", Build.VERSION.RELEASE);
        r.put("manufacturer", Build.MANUFACTURER);
        r.put("model", Build.MODEL);
        r.put("notifications", notificationState());
        r.put("anyAppSupported", true);
        r.put("anyAppAccess", anyApp.hasAccess());
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        r.put("batteryUnrestricted", pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName()));
        call.resolve(r);
    }

    @PluginMethod
    public void requestNotifications(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            JSObject r = new JSObject();
            r.put("notifications", notificationState());
            call.resolve(r);
            return;
        }
        requestPermissionForAlias(NOTIFICATIONS, call, "notificationsCallback");
    }

    @PermissionCallback
    private void notificationsCallback(PluginCall call) {
        JSObject r = new JSObject();
        r.put("notifications", notificationState());
        call.resolve(r);
    }

    /** target: app | notifications | battery | anyapp */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String target = call.getString("target", "app");
        String pkg = getContext().getPackageName();
        Intent i;
        switch (target) {
            case "anyapp":
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_DETAIL_SETTINGS);
                    i.putExtra(Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME, anyApp.component().flattenToString());
                } else {
                    i = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
                }
                break;
            case "notifications":
                i = new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg);
                break;
            case "battery":
                i = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                break;
            default:
                i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
                break;
        }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(i);
        } catch (ActivityNotFoundException e) {
            Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg));
            fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(fallback);
        }
        call.resolve();
    }

    // ---------------------------------------------------------------- lifecycle

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        getBridge().executeOnMainThread(() -> anyApp.recheck());
    }

    @Override
    protected void handleOnDestroy() {
        // the WebView that plays the music is going away with the activity
        nowPlaying.clear();
        anyApp.stop();
        clips.stop();
        io.shutdownNow();
        super.handleOnDestroy();
    }

    // ---------------------------------------------------------------- helpers

    private String notificationState() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            PermissionState s = getPermissionState(NOTIFICATIONS);
            if (s == PermissionState.GRANTED) return "granted";
            if (s == PermissionState.DENIED) return "denied";
            return "prompt";
        }
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
    }

    private static long toLong(Double d) {
        return d == null || d.isNaN() ? 0 : Math.round(d);
    }

    private static Bitmap decode(String base64) {
        if (base64 == null || base64.isEmpty()) return null;
        try {
            int comma = base64.indexOf(',');
            if (base64.startsWith("data:") && comma > 0) base64 = base64.substring(comma + 1);
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }

    private void fetchArtwork(final String key, final String url) {
        io.execute(() -> {
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                if (conn.getResponseCode() != 200) return;
                Bitmap bmp;
                try (InputStream in = conn.getInputStream()) {
                    bmp = BitmapFactory.decodeStream(in);
                }
                if (bmp == null) return;
                int max = 640;
                if (Math.max(bmp.getWidth(), bmp.getHeight()) > max) {
                    float k = max / (float) Math.max(bmp.getWidth(), bmp.getHeight());
                    bmp = Bitmap.createScaledBitmap(bmp, Math.round(bmp.getWidth() * k), Math.round(bmp.getHeight() * k), true);
                }
                final Bitmap done = bmp;
                getBridge().executeOnMainThread(() -> nowPlaying.setArtwork(key, done));
            } catch (Exception ignored) {
                // no picture is fine
            } finally {
                if (conn != null) conn.disconnect();
            }
        });
    }
}
