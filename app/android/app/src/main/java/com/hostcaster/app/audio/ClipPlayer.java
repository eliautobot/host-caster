package com.hostcaster.app.audio;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/**
 * Plays a spoken clip natively. Used for breaks over ANOTHER app's music: a clip played by the WebView makes
 * Chromium take permanent audio focus, which stops the other app; this one plays under Host-Caster's transient
 * "may duck" focus instead, so the other app only ducks. One clip at a time. Main thread.
 */
final class ClipPlayer {

    interface Done {
        void finished(String error);
    }

    private final Context ctx;
    private MediaPlayer mp;
    private Done pending;
    private File file;

    ClipPlayer(Context context) {
        ctx = context.getApplicationContext();
    }

    void play(byte[] bytes, String ext, float volume, Done done) {
        stop();
        pending = done;
        try {
            file = File.createTempFile("hostcaster-clip", "." + (ext == null || ext.isEmpty() ? "mp3" : ext), ctx.getCacheDir());
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(bytes);
            }
            mp = new MediaPlayer();
            mp.setAudioAttributes(
                new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
            );
            mp.setDataSource(file.getAbsolutePath());
            mp.setVolume(volume, volume);
            mp.setOnPreparedListener(MediaPlayer::start);
            mp.setOnCompletionListener((p) -> finish(null));
            mp.setOnErrorListener((p, what, extra) -> {
                finish("playback error " + what + "/" + extra);
                return true;
            });
            mp.prepareAsync();
        } catch (IOException | RuntimeException e) {
            finish(e.getMessage() == null ? "could not play the clip" : e.getMessage());
        }
    }

    /** Stops the clip; a pending play() resolves as finished. */
    void stop() {
        finish(null);
    }

    private void finish(String error) {
        if (mp != null) {
            try {
                mp.stop();
            } catch (IllegalStateException ignored) {}
            mp.release();
            mp = null;
        }
        if (file != null) {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
            file = null;
        }
        Done d = pending;
        pending = null;
        if (d != null) d.finished(error);
    }
}
