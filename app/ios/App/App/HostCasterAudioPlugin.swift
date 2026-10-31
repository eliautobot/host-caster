import AVFoundation
import Capacitor
import MediaPlayer
import UIKit
import UserNotifications

/// HostCasterAudio (iOS): lock screen / Control Center Now Playing with remote commands, the audio session
/// (background playback, ducking other apps while a host speaks), native voice clips, device status.
/// "Any music app" mode is Android only: iOS has no API to read other apps' playback, so it reports unsupported.
/// JS side: app/src/core/native (plugin.ts). Registered in HostCasterViewController.
@objc(HostCasterAudioPlugin)
public class HostCasterAudioPlugin: CAPPlugin, CAPBridgedPlugin, AVAudioPlayerDelegate {
    public let identifier = "HostCasterAudioPlugin"
    public let jsName = "HostCasterAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "updateNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "duck", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseFocus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restoreSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "playClip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopClip", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "anyAppStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "anyAppStart", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "anyAppStop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "anyAppNowPlaying", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "anyAppControl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deviceStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestNotifications", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openSettings", returnType: CAPPluginReturnPromise)
    ]

    // what the lock screen shows
    private var trackKey = ""
    private var playing = false
    private var ownAudio = true
    private var durationMs: Double = 0
    private var positionMs: Double = 0
    private var positionAt = Date()
    private var artworkKey: String?
    private var artwork: MPMediaItemArtwork?
    private var commandsReady = false
    private var ducking = false

    // native voice clips (breaks over another app's audio)
    private var clip: AVAudioPlayer?
    private var clipCall: CAPPluginCall?

    override public func load() {
        configureSession(duckOthers: false)
        let center = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()
        center.addObserver(self, selector: #selector(onInterruption(_:)), name: AVAudioSession.interruptionNotification, object: session)
        center.addObserver(self, selector: #selector(onRouteChange(_:)), name: AVAudioSession.routeChangeNotification, object: session)
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    // MARK: - audio session

    /// .playback keeps the WebView's music going with the screen locked (needs UIBackgroundModes audio).
    private func configureSession(duckOthers: Bool) {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(.playback, mode: .default, options: duckOthers ? [.duckOthers] : [])
        } catch {
            CAPLog.print("[HostCasterAudio] audio session category failed: \(error.localizedDescription)")
        }
    }

    @objc func duck(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            // Host-Caster is the music: the player ducks itself in Web Audio
            if self.ownAudio && self.playing {
                call.resolve(["result": "own"])
                return
            }
            self.configureSession(duckOthers: true)
            do {
                try AVAudioSession.sharedInstance().setActive(true)
                self.ducking = true
                call.resolve(["result": "granted"])
            } catch {
                call.resolve(["result": "failed"])
            }
        }
    }

    @objc func releaseFocus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.endDuck()
            call.resolve()
        }
    }

    /// Back to plain playback after something else changed the session (speech recognition records audio).
    @objc func restoreSession(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.configureSession(duckOthers: self.ducking)
            if self.ownAudio && self.playing { try? AVAudioSession.sharedInstance().setActive(true) }
            call.resolve()
        }
    }

    private func endDuck() {
        guard ducking else { return }
        ducking = false
        configureSession(duckOthers: false)
        // the other app returns to full volume once we deactivate; keep the session when we play music ourselves
        if !(ownAudio && playing) && clip == nil {
            try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        }
    }

    @objc private func onInterruption(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .began {
            if playing { emit("pause", reason: "interruption") }
        } else if let optRaw = note.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt,
                  AVAudioSession.InterruptionOptions(rawValue: optRaw).contains(.shouldResume), ownAudio {
            try? AVAudioSession.sharedInstance().setActive(true)
            emit("play", reason: "interruption")
        }
    }

    @objc private func onRouteChange(_ note: Notification) {
        guard let raw = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt,
              let reason = AVAudioSession.RouteChangeReason(rawValue: raw) else { return }
        // headphones unplugged / Bluetooth gone: pause like every music app
        if reason == .oldDeviceUnavailable && playing && ownAudio {
            DispatchQueue.main.async { self.emit("pause", reason: "noisy") }
        }
    }

    // MARK: - Now Playing (lock screen, Control Center, headset)

    @objc func updateNowPlaying(_ call: CAPPluginCall) {
        let title = call.getString("title", "")
        let artist = call.getString("artist", "")
        let album = call.getString("album", "")
        let duration = call.getDouble("durationMs", 0)
        let position = call.getDouble("positionMs")
        let isPlaying = call.getBool("playing", false)
        let canPrev = call.getBool("canPrev", true)
        let canNext = call.getBool("canNext", true)
        let own = call.getBool("ownAudio", true)
        let artKey = call.getString("artworkKey")
        let artBase64 = call.getString("artworkBase64")
        let artUrl = call.getString("artworkUrl")

        DispatchQueue.main.async {
            let key = "\(title)|\(artist)|\(album)|\(Int(duration))"
            let now = Date()
            if let position = position {
                self.positionMs = position
            } else if key != self.trackKey {
                self.positionMs = 0
            } else if self.playing {
                self.positionMs += now.timeIntervalSince(self.positionAt) * 1000
            }
            self.positionAt = now
            self.trackKey = key
            self.durationMs = duration
            self.playing = isPlaying
            self.ownAudio = own
            if own && isPlaying { try? AVAudioSession.sharedInstance().setActive(true) }

            if let artKey = artKey, artKey != self.artworkKey {
                self.artworkKey = artKey
                self.artwork = nil
                if let image = Self.image(fromBase64: artBase64) {
                    self.artwork = Self.artwork(image)
                } else if let artUrl = artUrl, let url = URL(string: artUrl), artUrl.hasPrefix("http") {
                    self.fetchArtwork(url, key: artKey)
                }
            } else if artKey == nil {
                self.artworkKey = nil
                self.artwork = nil
            }

            self.setupCommands()
            let cc = MPRemoteCommandCenter.shared()
            cc.previousTrackCommand.isEnabled = canPrev
            cc.nextTrackCommand.isEnabled = canNext
            cc.changePlaybackPositionCommand.isEnabled = duration > 0
            self.publish(title: title, artist: artist, album: album)
            call.resolve()
        }
    }

    @objc func clearNowPlaying(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.trackKey = ""
            self.playing = false
            self.artworkKey = nil
            self.artwork = nil
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            call.resolve()
        }
    }

    private func publish(title: String, artist: String, album: String) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: positionMs / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyDefaultPlaybackRate: 1.0
        ]
        if !album.isEmpty { info[MPMediaItemPropertyAlbumTitle] = album }
        if durationMs > 0 {
            info[MPMediaItemPropertyPlaybackDuration] = durationMs / 1000
        } else {
            info[MPNowPlayingInfoPropertyIsLiveStream] = true
        }
        if let artwork = artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private func setupCommands() {
        guard !commandsReady else { return }
        commandsReady = true
        UIApplication.shared.beginReceivingRemoteControlEvents()
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.addTarget { [weak self] _ in self?.emit("play", reason: "user"); return .success }
        cc.pauseCommand.addTarget { [weak self] _ in self?.emit("pause", reason: "user"); return .success }
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.emit(self.playing ? "pause" : "play", reason: "user")
            return .success
        }
        cc.stopCommand.addTarget { [weak self] _ in self?.emit("stop", reason: "user"); return .success }
        cc.nextTrackCommand.addTarget { [weak self] _ in self?.emit("next", reason: "user"); return .success }
        cc.previousTrackCommand.addTarget { [weak self] _ in self?.emit("prev", reason: "user"); return .success }
        cc.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let self = self, let e = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            self.positionMs = e.positionTime * 1000
            self.positionAt = Date()
            self.emit("seek", reason: "user", positionMs: self.positionMs)
            return .success
        }
    }

    private func currentPositionMs() -> Double {
        guard playing else { return positionMs }
        let p = positionMs + Date().timeIntervalSince(positionAt) * 1000
        return durationMs > 0 ? min(p, durationMs) : p
    }

    private func emit(_ action: String, reason: String, positionMs: Double? = nil) {
        notifyListeners("media", data: [
            "action": action,
            "positionMs": Int((positionMs ?? currentPositionMs()).rounded()),
            "reason": reason
        ])
    }

    private static func image(fromBase64 value: String?) -> UIImage? {
        guard var b64 = value, !b64.isEmpty else { return nil }
        if b64.hasPrefix("data:"), let comma = b64.firstIndex(of: ",") { b64 = String(b64[b64.index(after: comma)...]) }
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters) else { return nil }
        return UIImage(data: data)
    }

    private static func artwork(_ image: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }

    private func fetchArtwork(_ url: URL, key: String) {
        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let data = data, (response as? HTTPURLResponse)?.statusCode == 200, let image = UIImage(data: data) else { return }
            DispatchQueue.main.async {
                guard let self = self, self.artworkKey == key else { return }
                let art = Self.artwork(image)
                self.artwork = art
                var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
                info[MPMediaItemPropertyArtwork] = art
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }.resume()
    }

    // MARK: - voice clips

    @objc func playClip(_ call: CAPPluginCall) {
        guard let data = Data(base64Encoded: call.getString("base64", ""), options: .ignoreUnknownCharacters), !data.isEmpty else {
            call.reject("The clip is not valid base64")
            return
        }
        let ext = call.getString("ext", "mp3").lowercased()
        let volume = call.getFloat("volume", 1)
        DispatchQueue.main.async {
            self.finishClip(error: nil)
            do {
                let player = try AVAudioPlayer(data: data, fileTypeHint: Self.fileType(ext))
                player.delegate = self
                player.volume = max(0, min(1, volume))
                try? AVAudioSession.sharedInstance().setActive(true)
                self.clip = player
                self.clipCall = call
                if !player.play() { self.finishClip(error: "The clip could not be played") }
            } catch {
                call.reject("The clip could not be decoded: \(error.localizedDescription)")
            }
        }
    }

    @objc func stopClip(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.finishClip(error: nil)
            call.resolve()
        }
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        DispatchQueue.main.async {
            guard player === self.clip else { return }
            self.finishClip(error: flag ? nil : "The clip stopped early")
        }
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        DispatchQueue.main.async {
            guard player === self.clip else { return }
            self.finishClip(error: error?.localizedDescription ?? "The clip could not be decoded")
        }
    }

    private func finishClip(error: String?) {
        clip?.stop()
        clip = nil
        guard let call = clipCall else { return }
        clipCall = nil
        if let error = error { call.reject(error) } else { call.resolve() }
    }

    private static func fileType(_ ext: String) -> String? {
        switch ext {
        case "mp3": return AVFileType.mp3.rawValue
        case "wav": return AVFileType.wav.rawValue
        case "m4a", "mp4": return AVFileType.m4a.rawValue
        case "aac": return "public.aac-audio"
        case "aif", "aiff": return AVFileType.aiff.rawValue
        case "flac": return "org.xiph.flac"
        default: return nil
        }
    }

    // MARK: - any music app (not possible on iOS)

    @objc func anyAppStatus(_ call: CAPPluginCall) {
        call.resolve(["supported": false, "access": false, "running": false])
    }

    @objc func anyAppStart(_ call: CAPPluginCall) {
        call.resolve(["access": false, "running": false])
    }

    @objc func anyAppStop(_ call: CAPPluginCall) {
        call.resolve()
    }

    @objc func anyAppNowPlaying(_ call: CAPPluginCall) {
        call.resolve(["key": "", "playing": false])
    }

    @objc func anyAppControl(_ call: CAPPluginCall) {
        call.resolve(["ok": false])
    }

    // MARK: - device status and settings

    @objc func deviceStatus(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            let release = UIDevice.current.systemVersion
            let model = UIDevice.current.model
            self.notificationState { state in
                call.resolve([
                    "platform": "ios",
                    "release": release,
                    "manufacturer": "Apple",
                    "model": model,
                    "notifications": state,
                    "anyAppSupported": false,
                    "anyAppAccess": false
                ])
            }
        }
    }

    /// Now Playing and remote controls need no permission on iOS: report the state without asking.
    @objc func requestNotifications(_ call: CAPPluginCall) {
        notificationState { state in call.resolve(["notifications": state]) }
    }

    @objc func openSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            if let url = URL(string: UIApplication.openSettingsURLString) {
                UIApplication.shared.open(url)
            }
            call.resolve()
        }
    }

    private func notificationState(_ done: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            switch settings.authorizationStatus {
            case .authorized, .provisional, .ephemeral: done("granted")
            case .denied: done("denied")
            default: done("prompt")
            }
        }
    }
}
