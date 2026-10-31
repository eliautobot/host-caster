package com.hostcaster.app.audio;

import android.content.ComponentName;
import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;
import androidx.core.app.NotificationManagerCompat;
import com.getcapacitor.JSObject;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * "Any music app" mode: follows the media sessions of other apps (YouTube Music, Spotify, ...) and reports the one
 * that is playing. Needs notification access (see {@link AnyAppListener}). Main thread only.
 */
public final class AnyAppWatcher implements MediaSessionManager.OnActiveSessionsChangedListener {

    public interface Listener {
        void onTrack(JSObject track);

        void onState(JSObject state);
    }

    private static AnyAppWatcher instance;

    public static synchronized AnyAppWatcher get(Context context) {
        if (instance == null) instance = new AnyAppWatcher(context.getApplicationContext());
        return instance;
    }

    static synchronized AnyAppWatcher peek() {
        return instance;
    }

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final MediaSessionManager msm;
    private final ComponentName component;
    private final Map<SessionKey, Bound> bound = new HashMap<>();
    private List<MediaController> orderedControllers = new ArrayList<>();
    private Listener listener;
    private boolean wanted;
    private boolean running;
    private MediaController primary;
    private String lastTrackKey;
    private String lastArtKey;
    private String lastStateKey;

    /** Wrapper so the map key does not depend on MediaController identity (new objects per callback list). */
    private static final class SessionKey {

        final Object token;

        SessionKey(Object token) {
            this.token = token;
        }

        @Override
        public boolean equals(Object o) {
            return o instanceof SessionKey && ((SessionKey) o).token.equals(token);
        }

        @Override
        public int hashCode() {
            return token.hashCode();
        }
    }

    private final class Bound extends MediaController.Callback {

        final MediaController controller;

        Bound(MediaController c) {
            controller = c;
        }

        @Override
        public void onMetadataChanged(MediaMetadata metadata) {
            scheduleEmit();
        }

        @Override
        public void onPlaybackStateChanged(PlaybackState state) {
            scheduleEmit();
        }

        @Override
        public void onSessionDestroyed() {
            main.post(AnyAppWatcher.this::refreshSessions);
        }
    }

    private final Runnable emitRunnable = this::emit;

    private AnyAppWatcher(Context context) {
        ctx = context;
        msm = (MediaSessionManager) ctx.getSystemService(Context.MEDIA_SESSION_SERVICE);
        component = new ComponentName(ctx, AnyAppListener.class);
    }

    public void setListener(Listener l) {
        listener = l;
    }

    public boolean hasAccess() {
        return NotificationManagerCompat.getEnabledListenerPackages(ctx).contains(ctx.getPackageName());
    }

    public ComponentName component() {
        return component;
    }

    public boolean isRunning() {
        return running;
    }

    /** @return false when notification access is missing (start() is retried once access is granted). */
    public boolean start() {
        wanted = true;
        if (running) return true;
        if (!hasAccess()) return false;
        try {
            msm.addOnActiveSessionsChangedListener(this, component, main);
            running = true;
            lastTrackKey = null;
            lastArtKey = null;
            lastStateKey = null;
            refreshSessions();
            return true;
        } catch (SecurityException e) {
            return false;
        }
    }

    public void stop() {
        wanted = false;
        if (!running) return;
        msm.removeOnActiveSessionsChangedListener(this);
        for (Bound b : bound.values()) b.controller.unregisterCallback(b);
        bound.clear();
        primary = null;
        running = false;
        main.removeCallbacks(emitRunnable);
    }

    void onAccessGranted() {
        main.post(() -> {
            if (wanted && !running) start();
        });
    }

    /** App came back to the foreground: access may have been granted or revoked in Settings. */
    public void recheck() {
        if (wanted && !running) start();
        else if (running && !hasAccess()) {
            stop();
            wanted = true;
        }
    }

    @Override
    public void onActiveSessionsChanged(List<MediaController> controllers) {
        bind(controllers);
    }

    private void refreshSessions() {
        if (!running) return;
        try {
            bind(msm.getActiveSessions(component));
        } catch (SecurityException e) {
            stop();
            wanted = true;
        }
    }

    private void bind(List<MediaController> controllers) {
        if (controllers == null) controllers = new ArrayList<>();
        Map<SessionKey, Bound> next = new HashMap<>();
        for (MediaController c : controllers) {
            if (ctx.getPackageName().equals(c.getPackageName())) continue; // our own session
            SessionKey key = new SessionKey(c.getSessionToken());
            Bound b = bound.remove(key);
            if (b == null) {
                b = new Bound(c);
                c.registerCallback(b, main);
            }
            next.put(key, b);
        }
        for (Bound gone : bound.values()) gone.controller.unregisterCallback(gone);
        bound.clear();
        bound.putAll(next);
        orderedControllers = new ArrayList<>();
        for (MediaController c : controllers) {
            Bound b = bound.get(new SessionKey(c.getSessionToken()));
            if (b != null) orderedControllers.add(b.controller);
        }
        scheduleEmit();
    }

    private void scheduleEmit() {
        // metadata often arrives in pieces (title, then artwork): coalesce
        main.removeCallbacks(emitRunnable);
        main.postDelayed(emitRunnable, 350);
    }

    /** The session the listener cares about: the first playing one (system order = most recent), else keep the last. */
    private MediaController pickPrimary() {
        for (MediaController c : orderedControllers) {
            if (isPlaying(c.getPlaybackState())) return c;
        }
        if (primary != null) {
            for (MediaController c : orderedControllers) {
                if (c.getSessionToken().equals(primary.getSessionToken())) return c;
            }
        }
        return orderedControllers.isEmpty() ? null : orderedControllers.get(0);
    }

    private void emit() {
        if (!running || listener == null) return;
        primary = pickPrimary();
        JSObject track = nowPlaying();
        String trackKey = track.getString("key", "");
        String artKey = trackKey + "|" + track.has("artworkUrl") + "|" + track.optString("album") + "|" + track.optLong("durationMs");
        if (!trackKey.equals(lastTrackKey) || !artKey.equals(lastArtKey)) {
            lastTrackKey = trackKey;
            lastArtKey = artKey;
            listener.onTrack(track);
        }
        JSObject state = stateOf(primary);
        String stateKey = state.getString("packageName", "") + "|" + state.getString("state", "") + "|" + (state.optLong("positionMs") / 2000);
        if (!stateKey.equals(lastStateKey)) {
            lastStateKey = stateKey;
            listener.onState(state);
        }
    }

    /**
     * Current track of the primary session ({ key: '' } when nothing is there). Works without start() too
     * (a one-off look at the active sessions, for Settings) as long as notification access is on.
     */
    public JSObject nowPlaying() {
        MediaController c = null;
        if (running) c = primary != null ? primary : pickPrimary();
        else if (hasAccess()) c = snapshotPrimary();
        return describe(c);
    }

    private MediaController snapshotPrimary() {
        try {
            MediaController first = null;
            for (MediaController x : msm.getActiveSessions(component)) {
                if (ctx.getPackageName().equals(x.getPackageName())) continue;
                if (isPlaying(x.getPlaybackState())) return x;
                if (first == null) first = x;
            }
            return first;
        } catch (SecurityException e) {
            return null;
        }
    }

    private JSObject describe(MediaController c) {
        JSObject o = new JSObject();
        if (c == null) {
            o.put("key", "");
            o.put("playing", false);
            return o;
        }
        MediaMetadata m = c.getMetadata();
        String pkg = c.getPackageName();
        String title = text(m, MediaMetadata.METADATA_KEY_TITLE, MediaMetadata.METADATA_KEY_DISPLAY_TITLE);
        String artist = text(m, MediaMetadata.METADATA_KEY_ARTIST, MediaMetadata.METADATA_KEY_ALBUM_ARTIST, MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE);
        String album = text(m, MediaMetadata.METADATA_KEY_ALBUM);
        long duration = m != null ? m.getLong(MediaMetadata.METADATA_KEY_DURATION) : 0;
        o.put("packageName", pkg);
        o.put("appName", appName(pkg));
        o.put("title", title);
        o.put("artist", artist);
        if (!album.isEmpty()) o.put("album", album);
        if (duration > 0) o.put("durationMs", duration);
        // album and duration often arrive a moment later: they are not part of the track's identity
        o.put("key", title.isEmpty() && artist.isEmpty() ? "" : pkg + "|" + title + "|" + artist);
        PlaybackState s = c.getPlaybackState();
        o.put("playing", isPlaying(s));
        o.put("positionMs", position(s));
        o.put("at", System.currentTimeMillis());
        String art = artwork(m);
        if (art != null) o.put("artworkUrl", art);
        return o;
    }

    private JSObject stateOf(MediaController c) {
        JSObject o = new JSObject();
        PlaybackState s = c != null ? c.getPlaybackState() : null;
        o.put("packageName", c != null ? c.getPackageName() : "");
        o.put("playing", isPlaying(s));
        o.put("state", stateName(s));
        o.put("positionMs", position(s));
        o.put("speed", s != null ? s.getPlaybackSpeed() : 0);
        o.put("at", System.currentTimeMillis());
        return o;
    }

    /** play | pause | next | prev | seek */
    public boolean control(String action, long positionMs) {
        MediaController c = primary != null ? primary : pickPrimary();
        if (c == null) return false;
        MediaController.TransportControls t = c.getTransportControls();
        switch (action) {
            case "play":
                t.play();
                return true;
            case "pause":
                t.pause();
                return true;
            case "next":
                t.skipToNext();
                return true;
            case "prev":
                t.skipToPrevious();
                return true;
            case "seek":
                t.seekTo(positionMs);
                return true;
            default:
                return false;
        }
    }

    // ---- helpers ----

    private static boolean isPlaying(PlaybackState s) {
        if (s == null) return false;
        int st = s.getState();
        return st == PlaybackState.STATE_PLAYING || st == PlaybackState.STATE_BUFFERING || st == PlaybackState.STATE_FAST_FORWARDING || st == PlaybackState.STATE_REWINDING;
    }

    private static String stateName(PlaybackState s) {
        if (s == null) return "none";
        switch (s.getState()) {
            case PlaybackState.STATE_PLAYING:
                return "playing";
            case PlaybackState.STATE_PAUSED:
                return "paused";
            case PlaybackState.STATE_BUFFERING:
            case PlaybackState.STATE_CONNECTING:
                return "buffering";
            case PlaybackState.STATE_STOPPED:
                return "stopped";
            case PlaybackState.STATE_ERROR:
                return "error";
            case PlaybackState.STATE_SKIPPING_TO_NEXT:
            case PlaybackState.STATE_SKIPPING_TO_PREVIOUS:
            case PlaybackState.STATE_SKIPPING_TO_QUEUE_ITEM:
                return "skipping";
            default:
                return "none";
        }
    }

    private static long position(PlaybackState s) {
        if (s == null) return 0;
        long pos = s.getPosition();
        if (s.getState() == PlaybackState.STATE_PLAYING && s.getLastPositionUpdateTime() > 0) {
            pos += (long) ((SystemClock.elapsedRealtime() - s.getLastPositionUpdateTime()) * s.getPlaybackSpeed());
        }
        return Math.max(0, pos);
    }

    private static String text(MediaMetadata m, String... keys) {
        if (m == null) return "";
        for (String k : keys) {
            CharSequence v = m.getText(k);
            if (v != null && v.length() > 0) return v.toString();
        }
        return "";
    }

    private String appName(String pkg) {
        PackageManager pm = ctx.getPackageManager();
        try {
            ApplicationInfo info = pm.getApplicationInfo(pkg, 0);
            return pm.getApplicationLabel(info).toString();
        } catch (PackageManager.NameNotFoundException e) {
            return pkg;
        }
    }

    private static String artwork(MediaMetadata m) {
        if (m == null) return null;
        Bitmap b = m.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART);
        if (b == null) b = m.getBitmap(MediaMetadata.METADATA_KEY_ART);
        if (b == null) b = m.getBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON);
        if (b == null || b.isRecycled()) return null;
        int max = 320;
        int w = b.getWidth();
        int h = b.getHeight();
        if (w <= 0 || h <= 0) return null;
        Bitmap scaled = b;
        if (Math.max(w, h) > max) {
            float k = max / (float) Math.max(w, h);
            scaled = Bitmap.createScaledBitmap(b, Math.max(1, Math.round(w * k)), Math.max(1, Math.round(h * k)), true);
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.JPEG, 82, out);
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }
}
