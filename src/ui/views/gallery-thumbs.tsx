/**
 * Gallery schematics.
 *
 * Deliberately stylised rather than screenshots of real output. A downscaled
 * screenshot of somebody else's log reads as a *preview of your data* — and
 * keeps reading that way after you run it, now showing a stranger's process
 * beside your own result. A schematic cannot be misread that way, stays
 * legible at 200px where a screenshot does not, and does not rot when a
 * renderer is rewritten.
 *
 * Keyed by artifact type rather than by plugin (see `TYPE_THUMB` in
 * `host/views/destinations.ts`), so every miner producing an Accepting Petri
 * Net gets the Petri net picture without shipping an asset.
 *
 * Host-authored, so these are inline SVG and read the theme tokens directly.
 * A plugin-supplied preview, when manifests gain one, must be rendered
 * through `<img src="blob:…">` instead: SVG inlined into the host document is
 * host XSS, and inside `<img>` it is inert.
 */

/** Okabe-Ito, the same palette the color registry and family colors start from. */
const OK = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00'];
const LINE = 'var(--thumb-line)';
const FILL = 'var(--thumb-fill)';
const DIM = 'var(--text-dim)';

type El = JSX.Element;

let uid = 0;
const k = () => `t${uid++}`;

const line = (x1: number, y1: number, x2: number, y2: number, c = LINE, w = 1.6): El => (
  <path key={k()} d={`M${x1} ${y1}L${x2} ${y2}`} stroke={c} strokeWidth={w} strokeLinecap="round" fill="none" />
);
const poly = (d: string, c = LINE, w = 2.6): El => (
  <path key={k()} d={d} stroke={c} strokeWidth={w} strokeLinecap="round" strokeLinejoin="round" fill="none" />
);
const dot = (x: number, y: number, r: number, c: string): El => (
  <circle key={k()} cx={x} cy={y} r={r} fill={c} />
);
const ring = (x: number, y: number, r: number, c = LINE): El => (
  <circle key={k()} cx={x} cy={y} r={r} fill={FILL} stroke={c} strokeWidth={1.6} />
);
const box = (x: number, y: number, w: number, h: number, c = LINE, rx = 3): El => (
  <rect key={k()} x={x} y={y} width={w} height={h} rx={rx} fill={FILL} stroke={c} strokeWidth={1.6} />
);
const bar = (x: number, y: number, w: number, h: number, c: string, o = 1): El => (
  <rect key={k()} x={x} y={y} width={w} height={h} rx={1.5} fill={c} opacity={o} />
);
const arrow = (x1: number, y: number, x2: number, c = LINE): El[] => [
  line(x1, y, x2, y, c, 1.4),
  <path key={k()} d={`M${x2 - 4} ${y - 3}L${x2} ${y}L${x2 - 4} ${y + 3}`} stroke={c} strokeWidth={1.4}
        fill="none" strokeLinecap="round" strokeLinejoin="round" />,
];

const SCHEMATICS: Record<string, () => El[]> = {
  metro: () => [
    poly('M14 30H70l16 16h84', OK[0]), poly('M14 52h44l16 16h96', OK[1]),
    poly('M14 82h58l16-16h82', OK[2]), poly('M32 96h52l14-14', OK[3]),
    ...([[70, 30], [110, 46], [150, 46], [58, 52], [90, 68], [140, 68], [72, 82], [120, 66]] as const)
      .map(([x, y]) => ring(x, y, 3.4, DIM)),
  ],
  station: () => [
    ...[22, 58, 94, 130, 166].map((x, i) => poly(`M${x} 14V98`, OK[i % OK.length], 2.2)),
    ...([[22, 30], [22, 66], [58, 22], [58, 54], [58, 88], [94, 38], [94, 74], [130, 26], [130, 62], [166, 46], [166, 84]] as const)
      .map(([x, y]) => (
        <rect key={k()} x={x - 7} y={y - 2.6} width={14} height={5.2} rx={2.6} fill={FILL} stroke={DIM} strokeWidth={1.2} />
      )),
  ],
  /**
   * A dotted chart is one row per case, sorted by start time, coloured by
   * activity — so what makes it recognisable is not "a scatter plot" but its
   * silhouette: a concave left edge where the sorted starts fan out, a dense
   * band of early activity just inside it, and dots thinning away to the
   * right as cases run long. The first activity of every case lines that left
   * edge in a single colour, which is the detail that makes it read as a
   * dotted chart rather than as noise.
   *
   * Deterministically pseudo-random: a re-render must not reshuffle it.
   */
  dotted: () => {
    // Enough rows that they read as a texture rather than as countable dots —
    // a real dotted chart is hundreds of cases deep, and its recognisable
    // feature is the *mass*, not the individual marks.
    const rows = 72;
    const palette = [OK[0], OK[1], OK[3], OK[4], DIM, OK[2], OK[1], OK[0], OK[4]];
    const rnd = (a: number, b: number) => {
      const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
      return x - Math.floor(x);
    };
    const out: El[] = [];
    for (let r = 0; r < rows; r++) {
      const t = r / (rows - 1);
      const y = 7 + t * 99;
      // Fast early growth, then nearly vertical: the edge a start-time sort
      // draws when most cases begin in a burst.
      const start = 12 + 45 * Math.pow(t, 0.38);
      const span = (34 + 142 * Math.pow(rnd(r, 1), 1.45)) * (1 - 0.18 * t);
      const n = 9 + Math.floor(rnd(r, 2) * 15);
      for (let k = 0; k < n; k++) {
        // Head-loaded: most of a case's events fall in the first part of it,
        // which is what makes the dense band beside the left edge.
        const u = Math.pow(k / Math.max(1, n - 1), 1.85);
        const x = start + u * span + (rnd(r, k + 5) - 0.5) * 3.4;
        if (x > 192) continue;
        const c = k === 0 ? OK[5] : k === 1 ? OK[2] : palette[(r * 5 + k) % palette.length];
        out.push(dot(x, y, 1.05, c));
      }
    }
    return out;
  },
  petri: () => [
    ring(24, 56, 9), ...arrow(35, 56, 50), box(50, 44, 11, 24, LINE, 2), ...arrow(63, 56, 78),
    ring(89, 34, 9), ring(89, 78, 9), ...arrow(98, 34, 114), ...arrow(98, 78, 114),
    box(114, 22, 11, 24, LINE, 2), box(114, 66, 11, 24, LINE, 2),
    ...arrow(127, 34, 142), ...arrow(127, 78, 142), ring(153, 56, 9), dot(24, 56, 3.4, DIM),
  ],
  ocpn: () => [
    poly('M24 34h132', OK[0], 1.4), poly('M24 78h132', OK[4], 1.4),
    ring(28, 34, 8, OK[0]), ring(28, 78, 8, OK[4]),
    box(72, 22, 11, 24, LINE, 2), box(72, 66, 11, 24, LINE, 2), box(118, 44, 12, 24, DIM, 2),
    ring(160, 34, 8, OK[0]), ring(160, 78, 8, OK[4]),
    line(83, 34, 118, 50, LINE, 1.2), line(83, 78, 118, 62, LINE, 1.2),
    line(130, 50, 160, 34, LINE, 1.2), line(130, 62, 160, 78, LINE, 1.2),
  ],
  dfg: () => [
    box(16, 44, 42, 24), ...arrow(60, 56, 76), box(78, 20, 42, 24), box(78, 68, 42, 24),
    line(60, 56, 78, 32, LINE, 1.4), line(60, 56, 78, 80, LINE, 1.4),
    ...arrow(122, 32, 140), ...arrow(122, 80, 140), box(142, 44, 42, 24),
    line(140, 32, 163, 44, LINE, 1.4), line(140, 80, 163, 68, LINE, 1.4),
    bar(22, 52, 30, 3, DIM, 0.45), bar(84, 28, 30, 3, DIM, 0.45),
    bar(84, 76, 30, 3, DIM, 0.45), bar(148, 52, 30, 3, DIM, 0.45),
  ],
  ocdfg: () => [
    box(16, 44, 38, 24), box(74, 16, 38, 24, OK[0]), box(74, 44, 38, 24, OK[1]), box(74, 72, 38, 24, OK[2]),
    box(132, 44, 38, 24),
    line(54, 56, 74, 28, OK[0]), line(54, 56, 74, 56, OK[1]), line(54, 56, 74, 84, OK[2]),
    line(112, 28, 132, 54, OK[0]), line(112, 56, 132, 56, OK[1]), line(112, 84, 132, 58, OK[2]),
  ],
  tree: () => [
    ring(100, 22, 10), ring(58, 58, 10), ring(142, 58, 10),
    box(28, 84, 34, 18), box(74, 84, 34, 18), box(126, 84, 34, 18),
    line(93, 29, 65, 51, LINE, 1.4), line(107, 29, 135, 51, LINE, 1.4),
    line(52, 66, 45, 84, LINE, 1.4), line(64, 66, 91, 84, LINE, 1.4), line(142, 68, 143, 84, LINE, 1.4),
    <text key={k()} x={100} y={26} fontSize={10} textAnchor="middle" fill={DIM} fontFamily="monospace">→</text>,
    <text key={k()} x={58} y={62} fontSize={10} textAnchor="middle" fill={DIM} fontFamily="monospace">×</text>,
  ],
  bpmn: () => [
    ring(22, 56, 8), ...arrow(32, 56, 46), box(46, 44, 36, 24, LINE, 5), ...arrow(84, 56, 96),
    <path key={k()} d="M112 42 126 56 112 70 98 56Z" fill={FILL} stroke={LINE} strokeWidth={1.6} />,
    ...arrow(128, 34, 142), ...arrow(128, 78, 142),
    box(142, 22, 36, 24, LINE, 5), box(142, 66, 36, 24, LINE, 5),
    line(126, 56, 126, 34, LINE, 1.4), line(126, 56, 126, 78, LINE, 1.4),
  ],
  table: () => [
    bar(14, 16, 172, 12, DIM, 0.22),
    ...[34, 50, 66, 82, 98].flatMap((y, i) => [
      bar(14, y, 44, 7, LINE, 0.55), bar(66, y, 52, 7, LINE, 0.4),
      bar(126, y, 32, 7, OK[i % OK.length], 0.55), bar(166, y, 20, 7, LINE, 0.4),
    ]),
    ...[60, 120].map((x) => line(x, 16, x, 105, LINE, 0.8)),
  ],
  overview: () => [
    ...[14, 76, 138].map((x) => box(x, 14, 48, 30)),
    ...[14, 76, 138].map((x, i) => bar(x + 7, 24, 24, 9, OK[i], 0.8)),
    bar(14, 58, 172, 1.4, LINE, 0.8),
    ...Array.from({ length: 8 }, (_, i) =>
      bar(16 + i * 22, 100 - ((i * 13) % 34) - 10, 14, ((i * 13) % 34) + 10, OK[i % OK.length], 0.75)),
  ],
  /**
   * The friction terrain, as the view actually draws it: a dark plate, warm
   * peaks where waiting piles up, a lit rim at each summit, and a glowing
   * stream threading the valleys — not the stack of ridge lines this used to
   * be, which said "line chart" more than "landscape".
   *
   * The gradients are declared here rather than as flat fills because the
   * warm-summit-to-dark-base fall is the whole read: a peak is *height*, and
   * a flat triangle is just a triangle.
   */
  /**
   * A contour map, drawn in the same flat stroke vocabulary as every other
   * schematic here — not a little rendering of the 3D scene.
   *
   * A faithful picture of the view (dark ground, lit cones, glow) is the right
   * answer in isolation and the wrong one in a grid: among twenty flat line
   * drawings on a light panel it reads as a photograph someone pasted in, and
   * it stays dark while everything around it follows the theme. Contours also
   * happen to be what the view literally draws — `showContours` is one of its
   * controls — so this loses nothing but the gloss.
   *
   * Height is in the ring colour, the way a hypsometric map does it: cool and
   * grey at the plain, warm at the ridge, hot at the summit.
   */
  terrain: () => {
    const band = (i: number, n: number) => (i >= n - 1 ? OK[5] : i >= n - 3 ? OK[1] : i === 0 ? LINE : DIM);
    const peak = (cx: number, cy: number, rx: number, ry: number, n: number, skew = 0) =>
      Array.from({ length: n }, (_, i) => {
        const t = 1 - i / n;
        return (
          <ellipse
            key={k()}
            cx={cx + skew * (1 - t)}
            cy={cy - (ry - ry * t) * 0.35}
            rx={Math.max(2.5, rx * t)}
            ry={Math.max(1.8, ry * t)}
            fill="none"
            stroke={band(i, n)}
            strokeWidth={i >= n - 1 ? 1.6 : 1.2}
            opacity={i === 0 ? 0.75 : 1}
          />
        );
      });
    return [
      ...peak(52, 56, 33, 21, 6, -2),
      ...peak(128, 46, 38, 24, 7, 3),
      ...peak(172, 88, 18, 11, 4),
      // The stream through the saddle, and the stations it passes.
      poly('M10 92 C40 84, 58 70, 88 76 S140 92, 192 70', OK[0], 1.6),
      ...([[38, 86], [88, 76], [140, 88], [176, 78]] as const).map(([x, y]) => ring(x, y, 3, OK[4])),
    ];
  },
  spectrum: () => [
    line(14, 26, 186, 26, LINE, 1.4), line(14, 86, 186, 86, LINE, 1.4),
    ...Array.from({ length: 22 }, (_, i) => {
      const x1 = 16 + i * 7.6;
      return line(x1, 26, Math.min(x1 + 16 + ((i * 11) % 22), 186), 86, OK[(i > 7 && i < 15) ? 5 : 0], 1.5);
    }),
  ],
  variants: () => Array.from({ length: 6 }, (_, r) => {
    const n = 8 - (r % 4);
    return (
      <g key={k()}>
        {Array.from({ length: n }, (_, c) => bar(16 + c * 20, 16 + r * 15, 16, 9, OK[(c + r) % OK.length], 0.85))}
        <text x={16 + n * 20 + 5} y={24 + r * 15} fontSize={8} fill={DIM} fontFamily="monospace">{24 - r * 4}%</text>
      </g>
    );
  }),
  report: () => [
    box(14, 10, 172, 92, LINE, 4), bar(26, 24, 74, 7, DIM, 0.5),
    ...[0, 1, 2, 3].flatMap((i) => [
      bar(26, 42 + i * 15, 52, 6, LINE, 0.55),
      bar(86, 42 + i * 15, 88 - i * 20, 6, [OK[2], OK[1], OK[5], OK[0]][i], 0.8),
    ]),
  ],
  compare: () => [
    box(12, 12, 84, 88, LINE, 4), box(104, 12, 84, 88, LINE, 4),
    ...[0, 1, 2, 3, 4].map((i) => bar(22, 26 + i * 14, 64, 7, LINE, 0.5)),
    ...[0, 1, 2, 3, 4].map((i) => bar(114, 26 + i * 14, 64, 7,
      i === 1 ? OK[5] : i === 3 ? OK[2] : LINE, i === 1 || i === 3 ? 0.85 : 0.5)),
    line(100, 8, 100, 104, LINE, 1),
  ],
  align: () => [
    ...[0, 1].flatMap((r) => Array.from({ length: 8 }, (_, c) => {
      const bad = r === 1 && (c === 2 || c === 5);
      return (
        <rect key={k()} x={16 + c * 22} y={r === 0 ? 28 : 62} width={18} height={22} rx={2.5}
              fill={FILL} stroke={bad ? OK[5] : LINE} strokeWidth={bad ? 2 : 1.4} />
      );
    })),
    ...Array.from({ length: 8 }, (_, c) => (c === 2 || c === 5)
      ? <text key={k()} x={25 + c * 22} y={57} fontSize={11} fill={OK[5]} fontFamily="monospace">≠</text>
      : line(25 + c * 22, 50, 25 + c * 22, 62, LINE, 1.2)),
  ],
  atlas: () => [
    ...Array.from({ length: 7 }, (_, i) => {
      const a = (i / 7) * Math.PI * 2;
      const x = 100 + Math.cos(a) * 54;
      const y = 56 + Math.sin(a) * 38;
      return <g key={k()}>{line(100, 56, x, y, LINE, 1.2)}{ring(x, y, 7, OK[i % OK.length])}</g>;
    }),
    ring(100, 56, 9, DIM),
  ],
  gaps: () => [
    ...Array.from({ length: 6 }, (_, i) => {
      const a1 = (i / 6) * Math.PI * 2;
      const a2 = ((i + 1) / 6) * Math.PI * 2;
      const missing = i % 3 === 1;
      return (
        <path key={k()}
              d={`M${100 + Math.cos(a1) * 56} ${56 + Math.sin(a1) * 36}L${100 + Math.cos(a2) * 56} ${56 + Math.sin(a2) * 36}`}
              stroke={missing ? OK[5] : LINE} strokeWidth={1.5} fill="none"
              strokeDasharray={missing ? '4 4' : undefined} />
      );
    }),
    ...Array.from({ length: 6 }, (_, i) => {
      const a = (i / 6) * Math.PI * 2;
      return ring(100 + Math.cos(a) * 56, 56 + Math.sin(a) * 36, 8, i % 2 ? OK[0] : OK[1]);
    }),
  ],
  replay: () => [
    poly('M20 56h150', LINE, 1.4), ring(26, 56, 9), box(74, 44, 12, 24, LINE, 2), box(126, 44, 12, 24, LINE, 2),
    ring(174, 56, 9), dot(58, 56, 5, OK[1]), dot(104, 56, 5, OK[0]), dot(152, 56, 5, OK[2]),
    <path key={k()} d="M92 92 L104 99 L92 106Z" fill="var(--accent)" />,
    line(20, 99, 86, 99, LINE, 1.4), line(110, 99, 180, 99, LINE, 1.4),
  ],
  lpm: () => ([[14, 14], [110, 14], [14, 62], [110, 62]] as const).map(([x, y], i) => (
    <g key={k()}>
      {box(x, y, 76, 36, LINE, 4)}
      {ring(x + 14, y + 18, 5, OK[i % OK.length])}
      {arrow(x + 21, y + 18, x + 34)}
      {box(x + 34, y + 10, 9, 16, LINE, 2)}
      {arrow(x + 45, y + 18, x + 56)}
      {ring(x + 62, y + 18, 5, OK[i % OK.length])}
    </g>
  )),
  code: () => [
    box(14, 12, 172, 88, LINE, 4), line(14, 30, 186, 30, LINE, 1),
    ...[0, 1, 2, 3].map((i) => dot(24 + i * 9, 21, 2.4, i === 0 ? OK[5] : LINE)),
    ...([[26, 44, 40, OK[0]], [26, 56, 74, DIM], [38, 68, 56, OK[2]], [26, 80, 92, DIM]] as const)
      .map(([x, y, w, c]) => bar(x, y, w, 6, c as string, 0.7)),
  ],
  edit: () => [
    bar(14, 16, 172, 11, DIM, 0.22),
    ...[32, 48, 64, 80].flatMap((y, i) => [
      bar(14, y, 56, 7, LINE, i === 1 ? 0.25 : 0.55),
      bar(78, y, 48, 7, LINE, i === 1 ? 0.2 : 0.4),
      bar(134, y, 52, 7, LINE, i === 1 ? 0.2 : 0.4),
    ]),
    <path key={k()} d="M150 22 L178 22 L166 40 L162 40 Z" fill={FILL} stroke={OK[0]} strokeWidth={1.8} strokeLinejoin="round" />,
    line(164, 40, 164, 52, OK[0], 1.8),
  ],
  dag: () => [
    box(16, 44, 40, 22), box(80, 16, 40, 22), box(80, 72, 40, 22), box(144, 44, 40, 22),
    line(56, 55, 80, 27, LINE, 1.3), line(56, 55, 80, 83, LINE, 1.3),
    line(120, 27, 144, 53, LINE, 1.3), line(120, 83, 144, 57, LINE, 1.3),
  ],
  hist: () => [
    line(16, 96, 186, 96, LINE, 1.2),
    ...[26, 44, 62, 80, 58, 40, 28, 18, 12].map((h, i) => bar(20 + i * 19, 96 - h, 13, h, OK[i % OK.length], 0.8)),
  ],
  spark: () => [
    line(16, 96, 186, 96, LINE, 1.2), line(16, 16, 16, 96, LINE, 1.2),
    ...[30, 52, 74].map((y) => line(16, y, 186, y, LINE, 0.5)),
    poly('M22 82 L44 62 L66 70 L88 40 L110 52 L132 28 L154 36 L180 22', OK[0], 2.2),
    ...([[22, 82], [44, 62], [66, 70], [88, 40], [110, 52], [132, 28], [154, 36], [180, 22]] as const)
      .map(([x, y]) => dot(x, y, 2.8, OK[0])),
    poly('M22 92 L44 88 L66 90 L88 78 L110 84 L132 74 L154 80 L180 70', OK[1], 1.6),
  ],
  export: () => [
    box(30, 20, 96, 76, LINE, 4),
    ...[0, 1, 2].map((i) => bar(42, 38 + i * 16, 60 - i * 12, 6, LINE, 0.5)),
    poly('M140 58h34', 'var(--accent)', 2),
    <path key={k()} d="M166 50 L176 58 L166 66" stroke="var(--accent)" strokeWidth={2} fill="none"
          strokeLinecap="round" strokeLinejoin="round" />,
  ],
};

/**
 * One schematic. `label` is the short type name drawn into the fallback, so a
 * destination whose type has no picture yet still says what it produces
 * rather than showing an empty frame.
 */
export function Thumb({ kind, label }: { kind: string; label?: string }) {
  const draw = SCHEMATICS[kind];
  return (
    <svg className="gal-thumb" viewBox="0 0 200 112" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      {draw ? draw() : (
        <>
          {box(20, 20, 160, 72, LINE, 6)}
          <text x={100} y={63} fontSize={label && label.length > 6 ? 15 : 22} textAnchor="middle"
                fill={DIM} fontFamily="var(--mono, monospace)" opacity={0.7}>
            {label ?? '◻'}
          </text>
        </>
      )}
    </svg>
  );
}
