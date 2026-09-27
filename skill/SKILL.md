---
name: rhythm-chart-maker
description: Turn any uploaded audio (instrumental or vocal) into a Monument Rhythm song pack — a subfolder with the audio file plus chart.json. Use when the user asks to generate a rhythm chart, beatmap, 谱面, 游玩文件, 节奏大师 chart, or to convert mp3/wav/ogg into notes for the HTML prototype.
metadata:
  type: workflow
  version: "1.0"
---

# Rhythm Chart Maker

Build a playable song pack for the Monument Rhythm HTML prototype from one audio file. Do not invent a second chart schema. Read `references/chart-format.md` before writing JSON by hand.

## When this skill runs

1. The user attached or named an audio file.
2. The user asked for a chart / 谱面 / 游玩文件 / beatmap for Monument Rhythm or 节奏大师-style play.

If no audio is present, ask for a file (mp3, wav, ogg, m4a, flac) and stop.

## Output contract

Every song is one subfolder under the library root (default `/home/workdir/artifacts/monument-rhythm/songs/`):

```
<library-root>/<slug>/
  <original-audio-filename>
  chart.json
```

Never flatten audio files into the library root. Never put two songs in one folder.

## Procedure

1. Copy the source audio into a working path the sandbox can read.
2. Run the generator (do not reimplement onset detection in a new script):

```
python3 /home/workdir/.grok/skills/rhythm-chart-maker/scripts/make_chart.py \
  "<audio>" \
  --out "/home/workdir/artifacts/monument-rhythm/songs" \
  --title "<title>" \
  --artist "<artist-or-Unknown>" \
  --difficulty normal \
  --lanes 4
```

3. Difficulty map when the user names one — easy / normal / hard. Default `normal`. Lanes default to 4.
4. Title defaults to the audio stem. Artist defaults to `Unknown`.
5. Read the printed JSON summary. Open the written `chart.json` and confirm `notes` is non-empty. If it is empty, rerun with `--difficulty hard`.
6. Tell the user the pack path, note count, estimated BPM, and that the HTML menu will list the folder after a refresh (or after picking that library folder).

## Manual repair

If the user says notes are early or late, edit `offset` in `chart.json` (positive delays notes). If density is wrong, rerun with another `--difficulty`. Do not hand-place hundreds of notes unless the user asked for a short custom pattern.

## Dependencies

The script needs `ffmpeg`, `ffprobe`, and `numpy`. Decode always goes through ffmpeg so vocal tracks and instrumentals use the same path.

## Webpage pack

After the song folder is written, zip that folder (audio + chart.json). The Monument Rhythm page imports this zip and stores it in the browser. Do not maintain a central song index.

```
zip -r <slug>.zip <slug>
```

The zip may contain one song folder or several. Each folder must include the audio file and `chart.json`.

