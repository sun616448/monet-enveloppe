// Time-of-day interpolation over circular (24h) anchors.
// Given anchors at e.g. 7/12/18/22, find the two surrounding a given hour and
// the fractional position between them. Wraps around midnight (22 -> 7).

// Returns sorted indices into the anchors array (ascending by hour).
export function sortAnchors(anchors) {
  return anchors
    .map((a, i) => ({ hour: a.hour, i }))
    .sort((x, y) => x.hour - y.hour);
}

// Given the sorted anchors and an hour in [0,24), return:
//   { a: indexLow, b: indexHigh, t: fraction in [0,1] }
// `t` blends from anchor `a` (t=0) to anchor `b` (t=1).
export function locate(sorted, hour) {
  const h = ((hour % 24) + 24) % 24;
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  // Inside the day range: find the bracketing pair.
  for (let k = 0; k < sorted.length - 1; k++) {
    const lo = sorted[k];
    const hi = sorted[k + 1];
    if (h >= lo.hour && h < hi.hour) {
      const t = (h - lo.hour) / (hi.hour - lo.hour);
      return { a: lo.i, b: hi.i, t };
    }
  }

  // Wrap segment: from last anchor, across midnight, to first anchor.
  const span = first.hour + 24 - last.hour;
  const pos = h >= last.hour ? h - last.hour : h + 24 - last.hour;
  return { a: last.i, b: first.i, t: span === 0 ? 0 : pos / span };
}

export function formatClock(hour) {
  const h = ((hour % 24) + 24) % 24;
  const hh = Math.floor(h);
  const mm = Math.floor((h - hh) * 60);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}
