// Query string appended to rewritten HLS segment URIs. It must carry every
// param that transcoderKey() keys on (q, t, a, da, ds, at) so the segment
// route resolves the SAME transcoder the playlist route spawned.
function segmentQuery({ quality, offsetSecs = 0, audio = "stereo", diskSel = null, audioTrack = 0 }) {
  return `q=${quality}` +
    (offsetSecs > 0 ? `&t=${offsetSecs}` : "") +
    (audio === "surround" ? `&a=surround` : "") +
    (diskSel?.a != null ? `&da=${diskSel.a}` : "") +
    (diskSel?.s != null ? `&ds=${diskSel.s}` : "") +
    (audioTrack > 0 ? `&at=${audioTrack}` : "");
}
module.exports = { segmentQuery };
