import Capacitor
import UIKit

/// The app's bridge view controller: registers the app's own plugin (HostCasterAudio) with the bridge.
/// Used by SceneDelegate and Main.storyboard.
class HostCasterViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(HostCasterAudioPlugin())
    }
}
