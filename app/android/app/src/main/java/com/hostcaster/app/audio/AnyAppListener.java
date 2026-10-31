package com.hostcaster.app.audio;

import android.service.notification.NotificationListenerService;

/**
 * Exists so the user can grant Host-Caster "notification access", which is what Android requires before an app may read
 * other apps' media sessions (MediaSessionManager.getActiveSessions). Host-Caster never reads notification content.
 */
public class AnyAppListener extends NotificationListenerService {

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        AnyAppWatcher w = AnyAppWatcher.peek();
        if (w != null) w.onAccessGranted();
    }
}
