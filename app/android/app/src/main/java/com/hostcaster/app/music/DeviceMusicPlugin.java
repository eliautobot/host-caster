package com.hostcaster.app.music;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * HostCasterDeviceMusic: "Find music on this device". Asks for the audio permission (READ_MEDIA_AUDIO on 13+,
 * READ_EXTERNAL_STORAGE below), lists the songs MediaStore marks as music (IS_MUSIC, every storage volume) with their
 * tags, and gives covers. Nothing is copied: the songs play from where they are through {@link DeviceMusicStream}
 * (same origin as the app, with seeking), at /_hostcaster_device_/&lt;token&gt;/&lt;id&gt;. The token is new on every start.
 */
@CapacitorPlugin(
    name = "HostCasterDeviceMusic",
    permissions = {
        @Permission(alias = "audio", strings = { Manifest.permission.READ_MEDIA_AUDIO }),
        @Permission(alias = "storage", strings = { Manifest.permission.READ_EXTERNAL_STORAGE }),
    }
)
public class DeviceMusicPlugin extends Plugin {

    public static final String PREFIX = "/_hostcaster_device_/";
    static final String TOKEN = newToken();
    private static final String PREFS = "hostcaster.devicemusic";
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private static String newToken() {
        byte[] b = new byte[16];
        new SecureRandom().nextBytes(b);
        StringBuilder s = new StringBuilder();
        for (byte x : b) s.append(String.format("%02x", x));
        return s.toString();
    }

    static String permission() {
        return Build.VERSION.SDK_INT >= 33 ? Manifest.permission.READ_MEDIA_AUDIO : Manifest.permission.READ_EXTERNAL_STORAGE;
    }

    static boolean granted(Context ctx) {
        return ContextCompat.checkSelfPermission(ctx, permission()) == PackageManager.PERMISSION_GRANTED;
    }

    static Uri collection() {
        return Build.VERSION.SDK_INT >= 29
            ? MediaStore.Audio.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
            : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
    }

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /**
     * granted | prompt (never asked) | denied (asked, may ask again) | blocked (the last ask showed no dialog: only the
     * system settings can allow it). A permission Android took back later (unused app) counts as denied: asking works.
     */
    private String access() {
        if (granted(getContext())) return "granted";
        if (!prefs().getBoolean("asked", false)) return "prompt";
        return prefs().getBoolean("blocked", false) ? "blocked" : "denied";
    }

    private JSObject status() {
        JSObject r = new JSObject();
        r.put("access", access());
        r.put("base", PREFIX + TOKEN + "/");
        r.put("sdk", Build.VERSION.SDK_INT);
        return r;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(status());
    }

    @PluginMethod
    public void request(PluginCall call) {
        if (granted(getContext())) {
            call.resolve(status());
            return;
        }
        requestPermissionForAlias(Build.VERSION.SDK_INT >= 33 ? "audio" : "storage", call, "requestDone");
    }

    @PermissionCallback
    private void requestDone(PluginCall call) {
        boolean ok = granted(getContext());
        boolean rationale = getActivity() != null && ActivityCompat.shouldShowRequestPermissionRationale(getActivity(), permission());
        prefs().edit().putBoolean("asked", true).putBoolean("blocked", !ok && !rationale).apply();
        call.resolve(status());
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getContext().getPackageName()));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** Every song MediaStore marks as music, with its tags (filters for recordings and short files run in JS). */
    @PluginMethod
    public void scan(PluginCall call) {
        if (!granted(getContext())) {
            call.reject("Music access is not allowed", "denied");
            return;
        }
        worker.execute(() -> {
            try {
                call.resolve(new JSObject().put("songs", query(getContext().getContentResolver())));
            } catch (Exception e) {
                call.reject("Could not read the music on this device", e);
            }
        });
    }

    private static JSArray query(ContentResolver cr) {
        int sdk = Build.VERSION.SDK_INT;
        List<String> cols = new ArrayList<>(
            Arrays.asList(
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.ALBUM_ID,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.TRACK,
                MediaStore.Audio.Media.YEAR,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.MIME_TYPE,
                MediaStore.Audio.Media.DATE_MODIFIED,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.IS_RINGTONE,
                MediaStore.Audio.Media.IS_ALARM,
                MediaStore.Audio.Media.IS_NOTIFICATION,
                MediaStore.Audio.Media.IS_PODCAST
            )
        );
        if (sdk >= 29) cols.addAll(Arrays.asList(MediaStore.Audio.Media.RELATIVE_PATH, MediaStore.Audio.Media.VOLUME_NAME, MediaStore.Audio.Media.IS_AUDIOBOOK));
        else cols.add(MediaStore.Audio.Media.DATA);
        if (sdk >= 30) cols.add(MediaStore.Audio.Media.ALBUM_ARTIST);
        if (sdk >= 31) cols.add(MediaStore.Audio.Media.IS_RECORDING);
        JSArray out = new JSArray();
        try (
            Cursor c = cr.query(collection(), cols.toArray(new String[0]), MediaStore.Audio.Media.IS_MUSIC + " != 0", null, MediaStore.Audio.Media._ID)
        ) {
            if (c == null) return out;
            while (c.moveToNext()) {
                JSObject s = new JSObject();
                long id = c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media._ID));
                s.put("id", String.valueOf(id));
                String name = str(c, MediaStore.Audio.Media.DISPLAY_NAME);
                String folder;
                if (sdk >= 29) {
                    folder = trimSlash(str(c, MediaStore.Audio.Media.RELATIVE_PATH));
                    String volume = str(c, MediaStore.Audio.Media.VOLUME_NAME);
                    if (volume != null && !MediaStore.VOLUME_EXTERNAL_PRIMARY.equals(volume)) folder = "Memory card/" + folder;
                } else {
                    folder = folderOf(str(c, MediaStore.Audio.Media.DATA));
                    if (name == null) name = nameOf(str(c, MediaStore.Audio.Media.DATA));
                }
                s.put("name", name != null ? name : "song-" + id);
                s.put("folder", folder != null ? folder : "");
                s.put("title", tag(str(c, MediaStore.Audio.Media.TITLE)));
                s.put("artist", tag(str(c, MediaStore.Audio.Media.ARTIST)));
                s.put("album", tag(str(c, MediaStore.Audio.Media.ALBUM)));
                if (sdk >= 30) s.put("albumArtist", tag(str(c, MediaStore.Audio.Media.ALBUM_ARTIST)));
                s.put("albumId", String.valueOf(c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM_ID))));
                s.put("durationMs", c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION)));
                int track = c.getInt(c.getColumnIndexOrThrow(MediaStore.Audio.Media.TRACK));
                if (track > 0) {
                    s.put("trackNo", track % 1000);
                    if (track >= 1000) s.put("discNo", track / 1000);
                }
                int year = c.getInt(c.getColumnIndexOrThrow(MediaStore.Audio.Media.YEAR));
                if (year > 0) s.put("year", year);
                s.put("size", c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE)));
                String mime = str(c, MediaStore.Audio.Media.MIME_TYPE);
                s.put("mime", mime != null ? mime : "audio/mpeg");
                s.put("modifiedAt", c.getLong(c.getColumnIndexOrThrow(MediaStore.Audio.Media.DATE_MODIFIED)) * 1000L);
                s.put("kind", kind(c, sdk));
                out.put(s);
            }
        }
        return out;
    }

    private static String kind(Cursor c, int sdk) {
        if (flag(c, MediaStore.Audio.Media.IS_RINGTONE)) return "ringtone";
        if (flag(c, MediaStore.Audio.Media.IS_ALARM)) return "alarm";
        if (flag(c, MediaStore.Audio.Media.IS_NOTIFICATION)) return "notification";
        if (flag(c, MediaStore.Audio.Media.IS_PODCAST)) return "podcast";
        if (sdk >= 29 && flag(c, MediaStore.Audio.Media.IS_AUDIOBOOK)) return "audiobook";
        if (sdk >= 31 && flag(c, MediaStore.Audio.Media.IS_RECORDING)) return "recording";
        return "music";
    }

    private static boolean flag(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return i >= 0 && !c.isNull(i) && c.getInt(i) != 0;
    }

    private static String str(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        return i >= 0 && !c.isNull(i) ? c.getString(i) : null;
    }

    /** MediaStore writes "<unknown>" for a missing tag */
    private static String tag(String v) {
        if (v == null) return null;
        String t = v.trim();
        return t.isEmpty() || MediaStore.UNKNOWN_STRING.equals(t) ? null : t;
    }

    private static String trimSlash(String p) {
        if (p == null) return "";
        String t = p;
        while (t.endsWith("/")) t = t.substring(0, t.length() - 1);
        return t;
    }

    /** Android 9 and below: /storage/emulated/0/Music/Album/x.mp3 -> Music/Album */
    private static String folderOf(String data) {
        if (data == null) return "";
        int slash = data.lastIndexOf('/');
        String dir = slash > 0 ? data.substring(0, slash) : "";
        String[] roots = { "/storage/emulated/0/", "/sdcard/" };
        for (String r : roots) if (dir.startsWith(r)) return dir.substring(r.length());
        if (dir.startsWith("/storage/")) {
            String rest = dir.substring("/storage/".length());
            int s = rest.indexOf('/');
            return "Memory card/" + (s >= 0 ? rest.substring(s + 1) : "");
        }
        return dir;
    }

    private static String nameOf(String data) {
        if (data == null) return null;
        int slash = data.lastIndexOf('/');
        return slash >= 0 ? data.substring(slash + 1) : data;
    }

    /** The cover inside the song (or the album's), as a small JPEG in base64; none = {} */
    @PluginMethod
    public void artwork(PluginCall call) {
        String id = call.getString("id");
        String albumId = call.getString("albumId");
        if (id == null || !granted(getContext())) {
            call.resolve(new JSObject());
            return;
        }
        worker.execute(() -> {
            JSObject r = new JSObject();
            try {
                byte[] jpeg = cover(getContext().getContentResolver(), Long.parseLong(id), albumId);
                if (jpeg != null) {
                    r.put("data", Base64.encodeToString(jpeg, Base64.NO_WRAP));
                    r.put("mime", "image/jpeg");
                }
            } catch (Exception ignored) {
                // no cover
            }
            call.resolve(r);
        });
    }

    private static byte[] cover(ContentResolver cr, long id, String albumId) throws Exception {
        Bitmap bm = null;
        if (Build.VERSION.SDK_INT >= 29) {
            try {
                bm = cr.loadThumbnail(ContentUris.withAppendedId(collection(), id), new Size(512, 512), null);
            } catch (Exception none) {
                return null;
            }
        } else if (albumId != null) {
            Uri art = ContentUris.withAppendedId(Uri.parse("content://media/external/audio/albumart"), Long.parseLong(albumId));
            try (InputStream in = cr.openInputStream(art)) {
                if (in != null) bm = BitmapFactory.decodeStream(in);
            } catch (Exception none) {
                return null;
            }
        }
        if (bm == null) return null;
        int max = Math.max(bm.getWidth(), bm.getHeight());
        if (max > 512) bm = Bitmap.createScaledBitmap(bm, bm.getWidth() * 512 / max, bm.getHeight() * 512 / max, true);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        bm.compress(Bitmap.CompressFormat.JPEG, 85, out);
        return out.toByteArray();
    }

    @Override
    protected void handleOnDestroy() {
        worker.shutdownNow();
    }
}
