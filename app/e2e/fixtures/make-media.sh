#!/usr/bin/env bash
# Builds the test songs the e2e scripts import (tagged, with embedded covers). Needs ffmpeg + DejaVu fonts.
#   e2e/fixtures/make-media.sh player [dir]   6 songs (mp3/m4a/flac), duplicates, untagged file, m3u8 + pls playlists
#                                             default dir /tmp/hostcaster-e2e/player-media (player + player-extra e2e)
#   e2e/fixtures/make-media.sh radio [dir]    3 short songs, default /tmp/hostcaster-e2e/radio-media (radio e2e)
#   e2e/fixtures/make-media.sh demo [dir]     8 full-length songs on 4 albums for walks and screenshots,
#                                             default /tmp/hostcaster-e2e/demo-media
# Re-runnable; every sound is synthesized (no copyrighted audio).
set -euo pipefail
kind=${1:-player}
out=${2:-/tmp/hostcaster-e2e/$kind-media}
mkdir -p "$out"
cd "$out"
FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf
FONT_LIGHT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf

cover() { # file c0 c1 title [label]
  ffmpeg -loglevel error -y -f lavfi -i "gradients=s=600x600:c0=$2:c1=$3:x0=0:y0=0:x1=600:y1=600:nb_colors=2,format=rgb24" \
    -vf "drawtext=fontfile=$FONT:text='$4':fontcolor=white@0.92:fontsize=54:x=40:y=h-110,drawtext=fontfile=$FONT_LIGHT:text='${5:-HOSTCASTER TEST}':fontcolor=white@0.6:fontsize=22:x=42:y=44" \
    -frames:v 1 "$1"
}
# melody: notes per second $1, base Hz $2, step semitones $3, notes in pattern $4
melody() {
  echo "0.32*sin(2*PI*t*$2*pow(2,(mod(floor(t*$1),$4)*$3)/12))*(1-0.85*mod(t*$1,1))+0.12*sin(2*PI*t*$2/2)*(0.6+0.4*sin(2*PI*t*0.5))"
}
# chords: a soft pad over a 4-chord loop (root Hz $1, seconds per chord $2) plus a plucked arpeggio ($3 notes/s)
chords() {
  local r=$1 s=$2 n=$3
  local root="$r*pow(2,(mod(floor(t/$s),4)*5-12*floor(mod(floor(t/$s),4)/3))/12)"
  echo "0.14*sin(2*PI*t*$root)+0.10*sin(2*PI*t*$root*1.2599)+0.10*sin(2*PI*t*$root*1.4983)+0.08*sin(2*PI*t*$root/2)*(0.7+0.3*sin(2*PI*t*0.25))+0.18*sin(2*PI*t*$root*2*pow(2,(mod(floor(t*$n),3)*4)/12))*(1-0.9*mod(t*$n,1))"
}
song() { # out title artist album track year genre len cover expr codec-args...
  local file=$1 title=$2 artist=$3 album=$4 trk=$5 year=$6 genre=$7 len=$8 art=$9 expr=${10}; shift 10
  ffmpeg -loglevel error -y -f lavfi -i "aevalsrc='$expr':s=44100:d=$len,afade=t=in:d=0.5,afade=t=out:st=$((len-2)):d=2" -i "$art" \
    -map 0:a -map 1:v "$@" -disposition:v attached_pic \
    -metadata title="$title" -metadata artist="$artist" -metadata album="$album" -metadata album_artist="$artist" \
    -metadata track="$trk" -metadata date="$year" -metadata genre="$genre" "$file"
}
MP3=(-c:a libmp3lame -b:a 128k -c:v mjpeg -id3v2_version 3 -metadata:s:v title="Album cover" -metadata:s:v comment="Cover (front)")

case $kind in
player)
  cover cover-first-signal.jpg 0xff7a45 0x3a1408 "First Signal"
  cover cover-harbor.jpg 0x1f6f78 0x0b1d26 "Harbor Lights"
  cover cover-static.jpg 0xffc145 0x5a2d0c "Static Bloom"
  song "01 Morning Light.mp3" "Morning Light" "Lumen Drive" "First Signal" 1 2024 "Synthpop" 32 cover-first-signal.jpg "$(melody 2 261.63 4 3)" "${MP3[@]}"
  song "02 Coffee Run.mp3" "Coffee Run" "Lumen Drive" "First Signal" 2 2024 "Synthpop" 26 cover-first-signal.jpg "$(melody 4 329.63 2 5)" "${MP3[@]}"
  song "03 Late Train.mp3" "Late Train" "Lumen Drive" "First Signal" 3 2024 "Synthpop" 38 cover-first-signal.jpg "$(melody 1.5 196 5 4)" "${MP3[@]}"
  song "04 Neon Harbor.m4a" "Neon Harbor" "The Quiet Tides" "Harbor Lights" 1 2023 "Ambient" 30 cover-harbor.jpg "$(melody 3 220 3 6)" -c:a aac -b:a 128k -c:v mjpeg
  song "05 Salt Air.flac" "Salt Air" "The Quiet Tides" "Harbor Lights" 2 2023 "Ambient" 22 cover-harbor.jpg "$(melody 2.5 293.66 7 3)" -c:a flac -c:v mjpeg
  song "06 Static Bloom.mp3" "Static Bloom" "Mira Vale" "Static Bloom" 1 2025 "Indie" 35 cover-static.jpg "$(melody 3.5 349.23 -3 6)" "${MP3[@]}"
  mkdir -p dupes && cp "01 Morning Light.mp3" "dupes/Morning Light (copy).mp3"
  # untagged file: the title must fall back to the file name
  ffmpeg -loglevel error -y -f lavfi -i "aevalsrc='$(melody 2 440 1 4)':s=44100:d=21" -c:a libmp3lame -b:a 96k untagged-demo-tone.mp3
  # a "server library" folder (MUSIC_DIR) with two of the songs
  mkdir -p server-music && cp "02 Coffee Run.mp3" "05 Salt Air.flac" server-music/
  cat > mix.m3u8 <<'M3U'
#EXTM3U
#PLAYLIST:Test Mix
#EXTINF:35,Mira Vale - Static Bloom
06 Static Bloom.mp3
#EXTINF:30,The Quiet Tides - Neon Harbor
music/elsewhere/04 Neon Harbor.m4a
#EXTINF:32,Lumen Drive - Morning Light
C:\Users\someone\Music\01 Morning Light.mp3
#EXTINF:22,The Quiet Tides - Salt Air
missing-file-name.flac
#EXTINF:-1,Not In Library - Nowhere
nowhere.mp3
M3U
  cat > mix.pls <<'PLS'
[playlist]
NumberOfEntries=2
File1=02 Coffee Run.mp3
Title1=Lumen Drive - Coffee Run
Length1=26
File2=03 Late Train.mp3
Title2=Late Train
Length2=38
Version=2
PLS
  ;;
radio)
  cover cover-signals.jpg 0x2b8a6e 0x0c2a22 "Test Signals"
  song "01 Sunrise Tone.mp3" "Sunrise Tone" "The Sine Waves" "Test Signals" 1 2024 "Ambient" 30 cover-signals.jpg "$(melody 2 261.63 4 3)" "${MP3[@]}"
  song "02 Night Owl Hum.mp3" "Night Owl Hum" "Low Frequency Club" "Test Signals" 2 2024 "Ambient" 30 cover-signals.jpg "$(melody 1.5 196 5 4)" "${MP3[@]}"
  song "03 Harbor Lights.mp3" "Harbor Lights" "Tide Machine" "Test Signals" 3 2024 "Ambient" 30 cover-signals.jpg "$(melody 3 220 3 6)" "${MP3[@]}"
  ;;
demo)
  cover cover-golden-hour.jpg 0xff8a3d 0x4a1606 "Golden Hour" "LUMEN DRIVE"
  cover cover-tidal.jpg 0x2a9d8f 0x08262b "Tidal" "THE QUIET TIDES"
  cover cover-paper-planes.jpg 0xf4c95d 0x6b2f0a "Paper Planes" "MIRA VALE"
  cover cover-night-market.jpg 0x2f6fdb 0x081833 "Night Market" "CITY PULSE"
  song "01 Golden Hour.mp3" "Golden Hour" "Lumen Drive" "Golden Hour" 1 2024 "Synthpop" 214 cover-golden-hour.jpg "$(chords 220 4 4)" "${MP3[@]}"
  song "02 Highway Bloom.mp3" "Highway Bloom" "Lumen Drive" "Golden Hour" 2 2024 "Synthpop" 187 cover-golden-hour.jpg "$(chords 246.94 3 6)" "${MP3[@]}"
  song "03 Low Tide.mp3" "Low Tide" "The Quiet Tides" "Tidal" 1 2023 "Ambient" 241 cover-tidal.jpg "$(chords 174.61 6 2)" "${MP3[@]}"
  song "04 Lantern Swim.mp3" "Lantern Swim" "The Quiet Tides" "Tidal" 2 2023 "Ambient" 198 cover-tidal.jpg "$(chords 196 5 3)" "${MP3[@]}"
  song "05 Paper Planes.mp3" "Paper Planes" "Mira Vale" "Paper Planes" 1 2025 "Indie" 176 cover-paper-planes.jpg "$(chords 261.63 2 4)" "${MP3[@]}"
  song "06 Kitchen Radio.mp3" "Kitchen Radio" "Mira Vale" "Paper Planes" 2 2025 "Indie" 203 cover-paper-planes.jpg "$(chords 293.66 3 5)" "${MP3[@]}"
  song "07 Night Market.mp3" "Night Market" "City Pulse" "Night Market" 1 2022 "Electronic" 229 cover-night-market.jpg "$(chords 207.65 2 8)" "${MP3[@]}"
  song "08 Last Bus Home.mp3" "Last Bus Home" "City Pulse" "Night Market" 2 2022 "Electronic" 192 cover-night-market.jpg "$(chords 185 4 6)" "${MP3[@]}"
  ;;
*) echo "usage: $0 player|radio|demo [dir]" >&2; exit 1 ;;
esac
echo "made $kind media in $out"
