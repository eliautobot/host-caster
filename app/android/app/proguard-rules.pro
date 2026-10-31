# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Readable crash stack traces in the Play Console (upload the mapping file with each release).
-keepattributes SourceFile,LineNumberTable
-renamesourcefileattribute SourceFile

# Capacitor finds plugins and their methods by annotation (its consumer rules keep classes extending Plugin and
# @PluginMethod methods). Host-Caster's own native code is small: keep it whole so callbacks from the system
# (media session, notification listener, audio focus) and the JS bridge never lose a member.
-keep class com.hostcaster.app.** { *; }
-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod
