package com.hostcaster.app.audio;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import androidx.core.content.ContextCompat;
import com.hostcaster.app.MainActivity;
import com.hostcaster.app.R;

/**
 * Host-Caster's own playback surface: one MediaSession, the media notification, transient audio focus for breaks over
 * other apps and a partial wake lock while on air. (The WebView takes AUDIOFOCUS_GAIN for its own media itself.) The foreground service ({@link HostCasterMediaService}) only hosts the notification.
 * All calls run on the main thread.
 */
public final class NowPlaying {

    public interface Listener {
        /** action: play | pause | next | prev | seek | stop; reason: user | noisy */
        void onMediaAction(String action, long positionMs, String reason);

        /** Transient focus for a spoken break over another app. state: gain | loss | loss_transient | duck */
        void onFocusChange(String state);
    }

    static final String CHANNEL_ID = "hostcaster_playback";
    static final int NOTIFICATION_ID = 7301;
    static final long DETACH_AFTER_PAUSE_MS = 5 * 60 * 1000L;

    private static NowPlaying instance;

    public static synchronized NowPlaying get(Context context) {
        if (instance == null) instance = new NowPlaying(context.getApplicationContext());
        return instance;
    }

    private final Context ctx;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final AudioManager audio;
    private final MediaSession session;
    private Listener listener;

    private boolean active;
    private boolean playing;
    private String title = "";
    private String artist = "";
    private String album = "";
    private long durationMs;
    private long positionMs;
    private long positionAt;
    private boolean canPrev = true;
    private boolean canNext = true;
    private Bitmap artwork;
    private String artworkKey;

    private boolean ownAudio = true;
    /** any-app mode: whether the other app is playing (drives the play/pause button only) */
    private boolean otherPlaying = true;
    private AudioFocusRequest duckRequest;
    private boolean noisyRegistered;
    private PowerManager.WakeLock wakeLock;
    private HostCasterMediaService service;
    private boolean detached;
    private boolean detachScheduled;

    private final Runnable detachRunnable = () -> {
        detachScheduled = false;
        if (active && !playing && service != null) {
            detached = true;
            service.detach();
        }
    };

    private NowPlaying(Context context) {
        ctx = context;
        audio = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
        session = new MediaSession(ctx, "Host-Caster");
        session.setSessionActivity(contentIntent());
        session.setCallback(
            new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    dispatch("play", currentPosition(), "user");
                }

                @Override
                public void onPause() {
                    dispatch("pause", currentPosition(), "user");
                }

                @Override
                public void onSkipToNext() {
                    dispatch("next", 0, "user");
                }

                @Override
                public void onSkipToPrevious() {
                    dispatch("prev", 0, "user");
                }

                @Override
                public void onSeekTo(long pos) {
                    positionMs = pos;
                    positionAt = SystemClock.elapsedRealtime();
                    applyState();
                    dispatch("seek", pos, "user");
                }

                @Override
                public void onStop() {
                    dispatch("stop", currentPosition(), "user");
                }
            },
            main
        );
        createChannel();
    }

    public void setListener(Listener l) {
        listener = l;
    }

    public boolean isActive() {
        return active;
    }

    public boolean isPlaying() {
        return playing;
    }

    /** Host-Caster's own music is playing (the WebView holds audio focus for it). */
    public boolean ownMusicPlaying() {
        return active && playing && ownAudio;
    }

    public MediaSession.Token token() {
        return session.getSessionToken();
    }

    /** Called from the plugin. artwork == null and artworkKey equal to the current key keeps the old picture. */
    public void update(
        String title,
        String artist,
        String album,
        long durationMs,
        long positionMs,
        boolean playing,
        boolean canPrev,
        boolean canNext,
        boolean ownAudio,
        String artworkKey,
        Bitmap artwork
    ) {
        String t = title == null ? "" : title;
        String a = artist == null ? "" : artist;
        boolean sameTrack = active && t.equals(this.title) && a.equals(this.artist);
        // positionMs < 0 = caller does not know: keep counting on the same track, 0 on a new one
        long pos = positionMs >= 0 ? positionMs : (sameTrack ? currentPosition() : 0);
        this.title = t;
        this.artist = a;
        this.album = album == null ? "" : album;
        this.durationMs = Math.max(0, durationMs);
        this.positionMs = Math.max(0, pos);
        this.positionAt = SystemClock.elapsedRealtime();
        this.canPrev = canPrev;
        this.canNext = canNext;
        if (ownAudio || this.ownAudio) otherPlaying = true; // (re)entering any-app mode: assume the app plays
        this.ownAudio = ownAudio;
        if (artworkKey == null || !artworkKey.equals(this.artworkKey) || artwork != null) {
            this.artworkKey = artworkKey;
            this.artwork = artwork;
        }
        boolean wasPlaying = this.playing;
        this.playing = playing;
        active = true;

        if (playing) {
            if (ownAudio) registerNoisy();
            else unregisterNoisy();
            acquireWakeLock();
            main.removeCallbacks(detachRunnable);
            detachScheduled = false;
        } else {
            unregisterNoisy();
            releaseWakeLock();
            if (wasPlaying || !detachScheduled) {
                main.removeCallbacks(detachRunnable);
                main.postDelayed(detachRunnable, DETACH_AFTER_PAUSE_MS);
                detachScheduled = true;
            }
        }

        session.setMetadata(buildMetadata());
        applyState();
        session.setActive(true);
        showNotification();
    }

    /** Artwork fetched later (http URL): applied only if the track still uses that picture. */
    public void setArtwork(String key, Bitmap bmp) {
        if (!active || key == null || !key.equals(artworkKey) || bmp == null) return;
        artwork = bmp;
        session.setMetadata(buildMetadata());
        showNotification();
    }

    public String artworkKey() {
        return artworkKey;
    }

    public boolean hasArtwork() {
        return artwork != null;
    }

    /** Playback ended: remove the notification, stop the service, give focus back. */
    public void clear() {
        active = false;
        playing = false;
        main.removeCallbacks(detachRunnable);
        detachScheduled = false;
        unregisterNoisy();
        releaseWakeLock();
        PlaybackState.Builder b = new PlaybackState.Builder().setState(PlaybackState.STATE_NONE, 0, 0f);
        session.setPlaybackState(b.build());
        session.setActive(false);
        if (service != null) service.stopNow();
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.cancel(NOTIFICATION_ID);
    }

    // ---- transient ducking for "any app" mode (other apps duck while a host speaks) ----

    /** @return granted | own | failed | delayed */
    public String duck() {
        if (ownMusicPlaying()) return "own"; // our own music: the player ducks itself in Web Audio
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            int r = audio.requestAudioFocus(duckListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK);
            return r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED ? "granted" : "failed";
        }
        if (duckRequest == null) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                .build();
            duckRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(attrs)
                .setOnAudioFocusChangeListener(duckListener, main)
                .setWillPauseWhenDucked(false)
                .build();
        }
        int r = audio.requestAudioFocus(duckRequest);
        if (r == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return "granted";
        if (r == AudioManager.AUDIOFOCUS_REQUEST_DELAYED) return "delayed";
        return "failed";
    }

    public void releaseDuck() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            audio.abandonAudioFocus(duckListener);
        } else if (duckRequest != null) {
            audio.abandonAudioFocusRequest(duckRequest);
        }
    }

    private final AudioManager.OnAudioFocusChangeListener duckListener = (change) -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS) emitFocus("loss");
        else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) emitFocus("loss_transient");
        else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK) emitFocus("duck");
        else if (change == AudioManager.AUDIOFOCUS_GAIN) emitFocus("gain");
    };

    private void emitFocus(String state) {
        if (listener != null) listener.onFocusChange(state);
    }

    // ---- notification actions (from the service) ----

    void handleServiceAction(String action) {
        if (HostCasterMediaService.ACTION_PLAY.equals(action)) dispatch("play", currentPosition(), "user");
        else if (HostCasterMediaService.ACTION_PAUSE.equals(action)) dispatch("pause", currentPosition(), "user");
        else if (HostCasterMediaService.ACTION_NEXT.equals(action)) dispatch("next", 0, "user");
        else if (HostCasterMediaService.ACTION_PREV.equals(action)) dispatch("prev", 0, "user");
        else if (HostCasterMediaService.ACTION_STOP.equals(action)) dispatch("stop", currentPosition(), "user");
    }

    void attachService(HostCasterMediaService s) {
        service = s;
    }

    void detachService(HostCasterMediaService s) {
        if (service == s) service = null;
    }

    boolean isDetached() {
        return detached;
    }

    Notification buildNotification() {
        Notification.Builder b = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(ctx, CHANNEL_ID)
            : new Notification.Builder(ctx);
        b.setSmallIcon(R.drawable.ic_stat_hostcaster)
            .setContentTitle(title.isEmpty() ? "Host-Caster" : title)
            .setContentText(artist)
            .setContentIntent(contentIntent())
            .setDeleteIntent(serviceIntent(HostCasterMediaService.ACTION_STOP))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_TRANSPORT)
            .setColor(ContextCompat.getColor(ctx, R.color.hostcaster_accent))
            .setOngoing(playing);
        if (!album.isEmpty()) b.setSubText(album);
        if (artwork != null) b.setLargeIcon(artwork);

        int[] compact;
        if (canPrev && canNext) compact = new int[] { 0, 1, 2 };
        else if (canPrev || canNext) compact = new int[] { 0, 1 };
        else compact = new int[] { 0 };
        if (canPrev) b.addAction(action(R.drawable.ic_aw_prev, "Previous", HostCasterMediaService.ACTION_PREV));
        b.addAction(
            showsPlaying()
                ? action(R.drawable.ic_aw_pause, "Pause", HostCasterMediaService.ACTION_PAUSE)
                : action(R.drawable.ic_aw_play, "Play", HostCasterMediaService.ACTION_PLAY)
        );
        if (canNext) b.addAction(action(R.drawable.ic_aw_next, "Next", HostCasterMediaService.ACTION_NEXT));
        b.setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(compact));
        return b.build();
    }

    // ---- internals ----

    private void dispatch(String action, long pos, String reason) {
        // Any-app mode: the buttons (notification, lock screen, headset) drive the app that plays the music.
        // Host-Caster's own player must not react: "play" would start the library over that app.
        if (active && !ownAudio && !"stop".equals(action) && !"seek".equals(action)) {
            if ("play".equals(action) || "pause".equals(action)) mirrorOtherApp("play".equals(action));
            AnyAppWatcher.get(ctx).control(action, 0);
            return;
        }
        if (listener != null) listener.onMediaAction(action, pos, reason);
    }

    /** Any-app mode: show the other app's play/pause state on Host-Caster's notification. */
    public void mirrorOtherApp(boolean playing) {
        if (!active || ownAudio || otherPlaying == playing) return;
        otherPlaying = playing;
        applyState();
        showNotification();
    }

    private boolean showsPlaying() {
        return ownAudio ? playing : playing && otherPlaying;
    }

    private long currentPosition() {
        if (!playing) return positionMs;
        long p = positionMs + (SystemClock.elapsedRealtime() - positionAt);
        return durationMs > 0 ? Math.min(p, durationMs) : p;
    }

    private MediaMetadata buildMetadata() {
        MediaMetadata.Builder m = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE, artist);
        if (durationMs > 0) m.putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);
        if (artwork != null) m.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        return m.build();
    }

    private void applyState() {
        long actions = PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_STOP;
        if (durationMs > 0) actions |= PlaybackState.ACTION_SEEK_TO;
        if (canNext) actions |= PlaybackState.ACTION_SKIP_TO_NEXT;
        if (canPrev) actions |= PlaybackState.ACTION_SKIP_TO_PREVIOUS;
        PlaybackState state = new PlaybackState.Builder()
            .setActions(actions)
            .setState(showsPlaying() ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, positionMs, showsPlaying() ? 1f : 0f, positionAt)
            .build();
        session.setPlaybackState(state);
    }

    private void showNotification() {
        if (service != null) {
            service.refresh();
            return;
        }
        Intent i = new Intent(ctx, HostCasterMediaService.class).setAction(HostCasterMediaService.ACTION_SHOW);
        try {
            ContextCompat.startForegroundService(ctx, i);
        } catch (RuntimeException e) {
            // Android 12+ refuses to start a foreground service from the background: show the plain notification.
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            nm.notify(NOTIFICATION_ID, buildNotification());
        }
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Now playing", NotificationManager.IMPORTANCE_LOW);
        ch.setDescription("Playback controls while Host-Caster is on air");
        ch.setShowBadge(false);
        ch.setSound(null, null);
        ch.enableVibration(false);
        nm.createNotificationChannel(ch);
    }

    private PendingIntent contentIntent() {
        Intent open = new Intent(ctx, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(ctx, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private PendingIntent serviceIntent(String action) {
        Intent i = new Intent(ctx, HostCasterMediaService.class).setAction(action);
        return PendingIntent.getService(ctx, action.hashCode(), i, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    private Notification.Action action(int icon, String label, String action) {
        return new Notification.Action.Builder(Icon.createWithResource(ctx, icon), label, serviceIntent(action)).build();
    }

    // ---- headphones unplugged = pause ----

    private final BroadcastReceiver noisyReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            if (AudioManager.ACTION_AUDIO_BECOMING_NOISY.equals(intent.getAction()) && playing) {
                dispatch("pause", currentPosition(), "noisy");
            }
        }
    };

    private void registerNoisy() {
        if (noisyRegistered) return;
        ContextCompat.registerReceiver(
            ctx,
            noisyReceiver,
            new IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY),
            ContextCompat.RECEIVER_NOT_EXPORTED
        );
        noisyRegistered = true;
    }

    private void unregisterNoisy() {
        if (!noisyRegistered) return;
        try {
            ctx.unregisterReceiver(noisyReceiver);
        } catch (IllegalArgumentException ignored) {}
        noisyRegistered = false;
    }

    // ---- keep the CPU up while on air (track changes, break generation with the screen off) ----

    private void acquireWakeLock() {
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) ctx.getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Host-Caster:playback");
            wakeLock.setReferenceCounted(false);
        }
        if (!wakeLock.isHeld()) wakeLock.acquire(6 * 60 * 60 * 1000L);
    }

    private void releaseWakeLock() {
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
    }

    void onServicePromoted() {
        detached = false;
    }
}
