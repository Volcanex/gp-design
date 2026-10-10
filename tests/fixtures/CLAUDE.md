# tests/fixtures

Binary test inputs too fiddly to construct in-page. Check in only small
(<100KB), deterministic files with a documented provenance command so they
can be regenerated, not just replaced blind.

- `video-import-16f-64x64.webm`: 16 frames, 64x64, 8fps, VP8. Four frames
  each of solid red/green/blue/yellow in that order (frames 0-3 red, 4-7
  green, 8-11 blue, 12-15 yellow), used by `tests/e2e/video-import.spec.ts`
  to verify decoded/seeked frames land on the right colour through the
  sRGB->OKLab baked-clip upload path. Regenerate with:
  ```
  for i in $(seq 0 15); do
    c=$(( (i/4) % 4 )); color=(0xff0000 0x00ff00 0x0000ff 0xffff00)
    ffmpeg -f lavfi -i color=c=${color[$c]}:s=64x64:d=1 -frames:v 1 frame_$i.png
  done
  ffmpeg -framerate 8 -i frame_%d.png -c:v libvpx -pix_fmt yuv420p -b:v 200k out.webm
  ```
