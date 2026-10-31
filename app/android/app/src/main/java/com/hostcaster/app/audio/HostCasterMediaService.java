package com.hostcaster.app.audio;

import android.app.Notification;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Foreground media service: keeps the app process (and the WebView that plays the music) alive with the screen off
 * and hosts the media notification. State lives in {@link NowPlaying}.
 */
public class HostCasterMediaService extends Service {

    static final String ACTION_SHOW = "com.hostcaster.app.media.SHOW";
    static final String ACTION_PLAY = "com.hostcaster.app.media.PLAY";
    static final String ACTION_PAUSE = "com.hostcaster.app.media.PAUSE";
    static final String ACTION_NEXT = "com.hostcaster.app.media.NEXT";
    static final String ACTION_PREV = "com.hostcaster.app.media.PREV";
    static final String ACTION_STOP = "com.hostcaster.app.media.STOP";

    private NowPlaying nowPlaying;
    private boolean foreground;

    @Override
    public void onCreate() {
        super.onCreate();
        nowPlaying = NowPlaying.get(this);
        nowPlaying.attachService(this);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (action == null || ACTION_SHOW.equals(action)) {
            // started with startForegroundService(): must call startForeground() right away
            if (nowPlaying.isActive()) promote();
            else promoteThenStop();
            return START_NOT_STICKY;
        }
        if (!nowPlaying.isActive()) {
            // a button on a notification left over from an old process: nothing is playing here
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            nm.cancel(NowPlaying.NOTIFICATION_ID);
            stopSelf();
            return START_NOT_STICKY;
        }
        nowPlaying.handleServiceAction(action);
        return START_NOT_STICKY;
    }

    /** New metadata or play state: re-post the notification (and re-enter the foreground after a long pause). */
    void refresh() {
        if (!foreground && nowPlaying.isPlaying()) {
            try {
                promote();
                return;
            } catch (RuntimeException ignored) {
                // background start not allowed right now: fall through to a plain notification
            }
        }
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(NowPlaying.NOTIFICATION_ID, nowPlaying.buildNotification());
    }

    /** Paused for a while: leave the foreground but keep the notification, so the user can swipe it away. */
    void detach() {
        if (!foreground) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_DETACH);
        else stopForeground(false);
        foreground = false;
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        nm.notify(NowPlaying.NOTIFICATION_ID, nowPlaying.buildNotification());
    }

    void stopNow() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) stopForeground(STOP_FOREGROUND_REMOVE);
        else stopForeground(true);
        foreground = false;
        stopSelf();
    }

    private void promote() {
        Notification n = nowPlaying.buildNotification();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NowPlaying.NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        } else {
            startForeground(NowPlaying.NOTIFICATION_ID, n);
        }
        foreground = true;
        nowPlaying.onServicePromoted();
    }

    private void promoteThenStop() {
        try {
            promote();
        } catch (RuntimeException ignored) {}
        stopNow();
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped away: the WebView (and the music) is gone with it.
        nowPlaying.clear();
        stopNow();
        super.onTaskRemoved(rootIntent);
    }

    @Override
    public void onDestroy() {
        nowPlaying.detachService(this);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
