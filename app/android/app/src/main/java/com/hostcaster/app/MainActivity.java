package com.hostcaster.app;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import com.hostcaster.app.audio.HostCasterAudioPlugin;
import com.getcapacitor.BridgeActivity;
import com.hostcaster.app.music.DeviceMusicPlugin;
import com.hostcaster.app.music.DeviceMusicStream;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // app-local plugins must be registered before the bridge starts
        registerPlugin(HostCasterAudioPlugin.class);
        registerPlugin(LoopbackPlugin.class);
        registerPlugin(DeviceMusicPlugin.class);
        super.onCreate(savedInstanceState);
        // music on the device plays from where it is, with seeking (DeviceMusicStream); the rest is Capacitor's
        if (getBridge() != null) getBridge().setWebViewClient(new DeviceMusicStream(getBridge()));

        // Edge-to-edge on every Android version (15+ forces it anyway): the web UI pads itself with
        // env(safe-area-inset-*). Bar icon colours follow the theme through SystemBars.setStyle in JS.
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            getWindow().setNavigationBarContrastEnforced(false);
            getWindow().setStatusBarContrastEnforced(false);
        }

        // The WebView plays the music and runs the radio: keep its renderer important when the screen is off.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && getBridge() != null) {
            WebView wv = getBridge().getWebView();
            if (wv != null) wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
    }

    @Override
    public void onDestroy() {
        WebView wv = getBridge() != null ? getBridge().getWebView() : null;
        super.onDestroy();
        // A relaunch (Android re-creates the activity when the WebView's asset paths change: the first start after an
        // install and every WebView update) does not always detach the window, and Capacitor only destroys the WebView
        // on detach. The old page then keeps running the whole app (player, radio, sync) next to the new one.
        if (wv != null) {
            try {
                wv.stopLoading();
                if (wv.getParent() instanceof ViewGroup) ((ViewGroup) wv.getParent()).removeView(wv);
                wv.removeAllViews();
                wv.destroy();
            } catch (RuntimeException ignored) {
                // already destroyed
            }
        }
    }
}
