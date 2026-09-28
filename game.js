import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// ---------- Tuning ----------
const LANE_X = [-2.4, 0, 2.4];
const SEG_LEN = 30;          // length of one recycled track segment
const SEG_COUNT = 7;
const SPAWN_Z = -125;        // where new obstacle rows appear
const DESPAWN_Z = 14;        // behind the camera
const GRAVITY = 36;
const JUMP_V = 12.5;
const IDLE_SPEED = 9;
const START_SPEED = 18;
const MAX_SPEED = 44;
const ACCEL = 0.4;           // speed gained per second
const COIN_VALUE = 25;

const rand = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[(Math.random() * arr.length) | 0];
const shuffle = arr => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

// ---------- DOM ----------
const $ = id => document.getElementById(id);
const ui = {
  score: $('score'), coins: $('coins'), coinPill: $('coin-pill'),
  start: $('start'), over: $('over'), toast: $('toast'), mute: $('mute'),
  final: $('final-score'), finalCoins: $('final-coins'), best: $('best-score'), newBest: $('new-best'),
  play: $('play-btn'), retry: $('retry-btn'),
};

// ---------- Renderer / scene ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
$('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
const HORIZON = new THREE.Color('#ffe2bd');
scene.fog = new THREE.Fog(HORIZON, 30, 140);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 320);
camera.position.set(0, 4.4, 8.5);

// Gradient sky dome that follows the camera
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(200, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { top: { value: new THREE.Color('#2a8dff') }, horizon: { value: HORIZON } },
    vertexShader: `
      varying vec3 vDir;
      void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 top;
      uniform vec3 horizon;
      varying vec3 vDir;
      void main() {
        float h = clamp(vDir.y, 0.0, 1.0);
        gl_FragColor = vec4(mix(horizon, top, pow(h, 0.5)), 1.0);
        #include <colorspace_fragment>
      }`,
  })
);
sky.renderOrder = -1;
scene.add(sky);

// Lights
scene.add(new THREE.HemisphereLight('#d6ecff', '#9a7b62', 1.5));
const sun = new THREE.DirectionalLight('#fff1d6', 2.1);
sun.position.set(16, 36, 20);
sun.target.position.set(0, 0, -12);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -16, right: 16, top: 28, bottom: -28, near: 10, far: 100 });
sun.shadow.camera.updateProjectionMatrix();
sun.shadow.bias = -0.0008;
scene.add(sun, sun.target);

// ---------- Materials & textures ----------
const toonRamp = new THREE.DataTexture(new Uint8Array([95, 175, 255]), 3, 1, THREE.RedFormat);
toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter;
toonRamp.needsUpdate = true;
const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap: toonRamp, ...extra });

function canvasTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

const gravelTex = canvasTexture(128, (g, s) => {
  g.fillStyle = '#8a7462';
  g.fillRect(0, 0, s, s);
  for (let i = 0; i < 900; i++) {
    const v = (90 + Math.random() * 80) | 0;
    g.fillStyle = `rgb(${v + 20},${v},${v - 15})`;
    g.fillRect(Math.random() * s, Math.random() * s, 2 + Math.random() * 3, 2 + Math.random() * 3);
  }
});
gravelTex.repeat.set(3, SEG_LEN / 3);

const walkTex = canvasTexture(128, (g, s) => {
  g.fillStyle = '#dcd6cc';
  g.fillRect(0, 0, s, s);
  g.strokeStyle = '#b3aa9d';
  g.lineWidth = 5;
  g.strokeRect(0, 0, s, s);
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.stroke();
});
walkTex.repeat.set(2, SEG_LEN / 1.8);

const stripeTex = canvasTexture(128, (g, s) => {
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#e8322f';
  for (let x = -s; x < s * 2; x += 64) {
    g.beginPath();
    g.moveTo(x, 0); g.lineTo(x + 32, 0); g.lineTo(x + 32 - s, s); g.lineTo(x - s, s);
    g.closePath(); g.fill();
  }
});
stripeTex.repeat.set(3, 1);

// White frame + dark glass: the material colour tints the frame, so one texture fits every palette colour
const windowTex = canvasTexture(64, (g, s) => {
  g.fillStyle = '#fff';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#3d4f6e';
  g.fillRect(14, 12, 36, 40);
  g.fillStyle = '#9cc7ec';
  g.beginPath(); g.moveTo(14, 12); g.lineTo(32, 12); g.lineTo(14, 32); g.fill();
  g.fillStyle = '#fff';
  g.fillRect(30, 12, 4, 40);
});

const trainWinTex = canvasTexture(64, (g, s) => {
  g.fillStyle = '#fff';
  g.fillRect(0, 0, s, s);
  g.fillStyle = '#2f3a4f';
  g.fillRect(8, 8, 48, 48);
  g.fillStyle = '#7e93b3';
  g.beginPath(); g.moveTo(8, 8); g.lineTo(28, 8); g.lineTo(8, 30); g.fill();
});

const M = {
  grass: toon('#8fd16a'),
  bed: toon('#ffffff', { map: gravelTex }),
  walk: toon('#ffffff', { map: walkTex }),
  rail: toon('#c3cad6'),
  sleeper: toon('#6b4a33'),
  pole: toon('#3b4252'),
  bulb: new THREE.MeshBasicMaterial({ color: '#fff4b0' }),
  cap: toon('#4a4f5c'),
  roof: toon('#c9ccd4'),
  dark: toon('#2a2d34'),
  glass: toon('#1e2b44'),
  white: toon('#f4f4f4'),
  light: new THREE.MeshBasicMaterial({ color: '#fff6a0' }),
  red: new THREE.MeshBasicMaterial({ color: '#ff3b3b' }),
  stripe: toon('#ffffff', { map: stripeTex }),
  coin: toon('#ffcf2e', { emissive: '#8a5a00', emissiveIntensity: 0.6 }),
  cloud: toon('#ffffff', { fog: false }),
};
const BUILDING_MATS = ['#ff8a5c', '#ffd166', '#7bdff2', '#b388ff', '#f28482', '#84dcc6', '#f6bd60', '#90be6d']
  .map(c => toon(c, { map: windowTex }));
const TRAIN_COLORS = ['#e63946', '#2a9d8f', '#f4a261', '#6a4cff', '#ff4f9a', '#1d8cf8'];

// ---------- Shared geometry ----------
const G = {
  unit: new THREE.BoxGeometry(1, 1, 1),
  bed: new THREE.PlaneGeometry(8.6, SEG_LEN).rotateX(-Math.PI / 2),
  walk: new THREE.BoxGeometry(3.6, 0.3, SEG_LEN),
  rail: new THREE.BoxGeometry(0.14, 0.16, SEG_LEN),
  sleeper: new THREE.BoxGeometry(1.7, 0.1, 0.34),
  lamp: mergeGeometries([
    new THREE.CylinderGeometry(0.07, 0.1, 5, 8).translate(0, 2.5, 0),
    new THREE.BoxGeometry(1.3, 0.09, 0.09).translate(-0.6, 4.95, 0),
    new THREE.BoxGeometry(0.45, 0.14, 0.3).translate(-1.15, 4.88, 0),
  ]),
  bulb: new THREE.SphereGeometry(0.16, 10, 6).translate(-1.15, 4.76, 0),
  post: new THREE.BoxGeometry(0.14, 1.1, 0.14),
  foot: new THREE.BoxGeometry(0.5, 0.08, 0.5),
  board: new THREE.BoxGeometry(2.0, 0.42, 0.12),
  boardLow: new THREE.BoxGeometry(2.0, 0.2, 0.1),
  beacon: new THREE.SphereGeometry(0.1, 10, 8),
  coin: mergeGeometries([
    new THREE.CylinderGeometry(0.38, 0.38, 0.08, 24),
    new THREE.CylinderGeometry(0.26, 0.26, 0.13, 24),
  ]).rotateX(Math.PI / 2),
};

// Box with window UVs scaled to its real size, plus a roof cap and AC unit (3 material groups)
function buildingGeo(w, h, d) {
  const body = new THREE.BoxGeometry(w, h, d);
  const uv = body.attributes.uv;
  const CELL = 2.2;
  const faces = [[d, h], [d, h], null, null, [w, h], [w, h]]; // +x -x +y -y +z -z
  for (let f = 0; f < 6; f++) {
    for (let v = 0; v < 4; v++) {
      const i = f * 4 + v;
      if (!faces[f]) uv.setXY(i, 0.02, 0.02);
      else uv.setXY(i, uv.getX(i) * Math.round(faces[f][0] / CELL), uv.getY(i) * Math.round(faces[f][1] / CELL));
    }
  }
  body.translate(0, h / 2, 0);
  const cap = new THREE.BoxGeometry(w + 0.4, 0.45, d + 0.4).translate(0, h + 0.2, 0);
  const ac = new THREE.BoxGeometry(1.3, 0.9, 1.6).translate(w * 0.18, h + 0.8, d * 0.2);
  const geo = mergeGeometries([body, cap, ac], true);
  geo.userData.w = w;
  return geo;
}
const BUILDING_GEOS = [];
for (const w of [4.5, 6.5]) for (const h of [7, 11, 15, 21]) BUILDING_GEOS.push(buildingGeo(w, h, 8.6));

function part(parent, geo, mat, x, y, z, shadow = false) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.castShadow = shadow;
  parent.add(m);
  return m;
}

// ---------- World ----------
const ground = new THREE.Mesh(new THREE.PlaneGeometry(500, 500).rotateX(-Math.PI / 2), M.grass);
ground.position.set(0, -0.02, -120);
scene.add(ground);

const dummy = new THREE.Object3D();
const segments = [];

function makeSegment(index) {
  const seg = new THREE.Group();

  const bed = new THREE.Mesh(G.bed, M.bed);
  bed.receiveShadow = true;
  seg.add(bed);

  for (const s of [-1, 1]) {
    const walk = part(seg, G.walk, M.walk, s * 6.1, 0.15, 0);
    walk.receiveShadow = true;
    const lamp = part(seg, G.lamp, M.pole, s * 4.75, 0.3, 0);
    const bulb = part(seg, G.bulb, M.bulb, s * 4.75, 0.3, 0);
    if (s < 0) lamp.rotation.y = bulb.rotation.y = Math.PI;
  }

  const rails = new THREE.InstancedMesh(G.rail, M.rail, 6);
  const sleepers = new THREE.InstancedMesh(G.sleeper, M.sleeper, 60);
  let r = 0, k = 0;
  for (const lx of LANE_X) {
    for (const off of [-0.55, 0.55]) {
      dummy.position.set(lx + off, 0.18, 0);
      dummy.updateMatrix();
      rails.setMatrixAt(r++, dummy.matrix);
    }
    for (let i = 0; i < 20; i++) {
      dummy.position.set(lx, 0.05, -SEG_LEN / 2 + 0.75 + i * 1.5);
      dummy.updateMatrix();
      sleepers.setMatrixAt(k++, dummy.matrix);
    }
  }
  rails.receiveShadow = sleepers.receiveShadow = true;
  seg.add(rails, sleepers);

  seg.userData.buildings = [];
  for (const s of [-1, 1]) {
    for (const z of [-10, 0, 10]) {
      const b = new THREE.Mesh(BUILDING_GEOS[0], [BUILDING_MATS[0], M.cap, M.roof]);
      b.userData.side = s;
      b.position.z = z;
      seg.add(b);
      seg.userData.buildings.push(b);
    }
  }
  dressSegment(seg);

  seg.position.z = 10 - index * SEG_LEN;
  scene.add(seg);
  return seg;
}

function dressSegment(seg) {
  for (const b of seg.userData.buildings) {
    b.geometry = pick(BUILDING_GEOS);
    b.material[0] = pick(BUILDING_MATS);
    b.position.x = b.userData.side * (9.2 + b.geometry.userData.w / 2 + rand(0, 0.6));
  }
}

for (let i = 0; i < SEG_COUNT; i++) segments.push(makeSegment(i));

// Puffy clouds
const cloudGeo = mergeGeometries(
  [[0, 0, 0, 5], [4.5, -0.8, 0.5, 3.8], [-4.5, -1, 0, 3.5], [1.8, 2.2, 0, 3.6], [-2, 1.4, -0.5, 3.2]]
    .map(([x, y, z, r]) => new THREE.SphereGeometry(r, 14, 10).translate(x, y, z))
);
const clouds = [];
for (let i = 0; i < 9; i++) {
  const c = new THREE.Mesh(cloudGeo, M.cloud);
  c.position.set(rand(-150, 150), rand(38, 72), rand(-175, -110));
  c.scale.setScalar(rand(0.9, 1.8));
  c.userData.v = rand(0.6, 1.6);
  scene.add(c);
  clouds.push(c);
}

// ---------- Player ----------
function makePlayer() {
  const mat = {
    skin: toon('#ffc9a0'), hoodie: toon('#ff5d3b'), pants: toon('#2b59c3'), shoe: toon('#ffffff'),
    sole: toon('#ff2d6f'), cap: toon('#ffd23f'), bag: toon('#20c2a8'), pocket: toon('#15917d'), eye: toon('#1b1b1b'),
  };
  const root = new THREE.Group();
  const body = new THREE.Group();
  root.add(body);

  part(body, new THREE.CapsuleGeometry(0.34, 0.42, 4, 12), mat.hoodie, 0, 1.18, 0, true);
  part(body, new THREE.SphereGeometry(0.22, 12, 8), mat.hoodie, 0, 1.56, 0.18, true).scale.set(1.3, 0.7, 0.8);
  part(body, new THREE.SphereGeometry(0.3, 20, 16), mat.skin, 0, 1.86, 0, true);
  part(body, new THREE.SphereGeometry(0.315, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat.cap, 0, 1.9, 0, true);
  part(body, new THREE.CylinderGeometry(0.24, 0.24, 0.04, 20), mat.cap, 0, 1.93, 0.27, true).scale.set(1, 1, 1.25);
  for (const x of [-0.1, 0.1]) part(body, new THREE.SphereGeometry(0.045, 8, 6), mat.eye, x, 1.88, -0.27);
  part(body, new THREE.BoxGeometry(0.5, 0.56, 0.24), mat.bag, 0, 1.2, 0.34, true);
  part(body, new THREE.BoxGeometry(0.36, 0.22, 0.06), mat.pocket, 0, 1.06, 0.48);

  const limb = (x, y, radius, len, m) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, y, 0);
    body.add(pivot);
    part(pivot, new THREE.CapsuleGeometry(radius, len, 4, 8), m, 0, -len / 2 - radius * 0.5, 0, true);
    return pivot;
  };
  const armL = limb(-0.45, 1.46, 0.1, 0.38, mat.hoodie);
  const armR = limb(0.45, 1.46, 0.1, 0.38, mat.hoodie);
  for (const a of [armL, armR]) part(a, new THREE.SphereGeometry(0.11, 10, 8), mat.skin, 0, -0.62, 0, true);
  const legL = limb(-0.17, 0.78, 0.13, 0.42, mat.pants);
  const legR = limb(0.17, 0.78, 0.13, 0.42, mat.pants);
  for (const l of [legL, legR]) {
    part(l, new THREE.BoxGeometry(0.24, 0.16, 0.38), mat.shoe, 0, -0.68, -0.06, true);
    part(l, new THREE.BoxGeometry(0.26, 0.05, 0.4), mat.sole, 0, -0.76, -0.06);
  }

  scene.add(root);
  return { root, body, armL, armR, legL, legR };
}
const player = makePlayer();

// ---------- Obstacles & coins (pooled) ----------
function makeBarrier() {
  const g = new THREE.Group();
  for (const x of [-0.85, 0.85]) {
    part(g, G.post, M.dark, x, 0.55, 0, true);
    part(g, G.foot, M.dark, x, 0.04, 0);
    part(g, G.beacon, M.red, x, 1.15, 0);
  }
  part(g, G.board, M.stripe, 0, 0.84, 0, true);
  part(g, G.boardLow, M.stripe, 0, 0.4, 0, true);
  return { kind: 'barrier', mesh: g, hw: 1.0, h: 1.1, hd: 0.2 };
}

function makeTrain() {
  const g = new THREE.Group();
  const paint = toon(TRAIN_COLORS[0]);
  const tex = trainWinTex.clone();
  tex.needsUpdate = true;
  const band = toon(TRAIN_COLORS[0], { map: tex });
  const p = {
    body: part(g, G.unit, paint, 0, 1.72, 0, true),
    under: part(g, G.unit, M.dark, 0, 0.24, 0),
    roof: part(g, G.unit, M.roof, 0, 3.15, 0, true),
    stripe: part(g, G.unit, M.white, 0, 1.0, 0),
    band: part(g, G.unit, band, 0, 2.3, 0),
    shield: part(g, G.unit, M.glass, 0, 2.35, 0),
    sign: part(g, G.unit, M.light, 0, 2.95, 0),
    bumper: part(g, G.unit, M.dark, 0, 0.45, 0),
    lampL: part(g, G.unit, M.light, -0.62, 0.95, 0),
    lampR: part(g, G.unit, M.light, 0.62, 0.95, 0),
  };
  p.body.scale.set(2.1, 2.75, 1);
  p.under.scale.set(1.7, 0.45, 1);
  p.roof.scale.set(1.8, 0.25, 1);
  p.stripe.scale.set(2.16, 0.22, 1);
  p.band.scale.set(2.14, 0.75, 1);
  p.shield.scale.set(1.6, 0.85, 0.08);
  p.sign.scale.set(0.9, 0.28, 0.06);
  p.bumper.scale.set(1.9, 0.25, 0.16);
  p.lampL.scale.set(0.34, 0.22, 0.08);
  p.lampR.scale.set(0.34, 0.22, 0.08);
  return { kind: 'train', mesh: g, hw: 1.05, h: 3.3, hd: 5, parts: p, paint, band, tex };
}

function setupTrain(o, len, color) {
  const p = o.parts;
  o.hd = len / 2;
  p.body.scale.z = len;
  p.under.scale.z = len - 1;
  p.roof.scale.z = len - 0.4;
  p.stripe.scale.z = len + 0.02;
  p.band.scale.z = len - 0.8;
  for (const k of ['shield', 'sign', 'lampL', 'lampR']) p[k].position.z = len / 2 + 0.04;
  p.bumper.position.z = len / 2 + 0.08;
  o.paint.color.set(color);
  o.band.color.set(color);
  o.tex.repeat.set(Math.round(len / 1.7), 1);
}

function makeCoin() {
  return { kind: 'coin', mesh: new THREE.Mesh(G.coin, M.coin), hw: 0, h: 0, hd: 0.4, collected: false, t: 0 };
}

const makers = { barrier: makeBarrier, train: makeTrain, coin: makeCoin };
const pools = { barrier: [], train: [], coin: [] };
const active = [];

function acquire(kind) {
  let o = pools[kind].pop();
  if (!o) {
    o = makers[kind]();
    scene.add(o.mesh);
  }
  o.mesh.visible = true;
  active.push(o);
  return o;
}

function release(i) {
  const o = active[i];
  o.mesh.visible = false;
  active[i] = active[active.length - 1];
  active.pop();
  pools[o.kind].push(o);
}

function spawnTrain(lane, zFront, len) {
  const o = acquire('train');
  setupTrain(o, len, pick(TRAIN_COLORS));
  o.mesh.position.set(LANE_X[lane], 0, zFront - len / 2);
}

function spawnBarrier(lane, z) {
  acquire('barrier').mesh.position.set(LANE_X[lane], 0, z);
}

function spawnCoin(x, y, z) {
  const o = acquire('coin');
  o.collected = false;
  o.t = 0;
  o.mesh.scale.setScalar(1);
  o.mesh.position.set(x, y, z);
}

// One row of obstacles at zFront. Trains in a row share a length and rows never overlap,
// so there is always a reachable open (or jumpable) lane. Returns distance to the next row.
function spawnRow(zFront) {
  const difficulty = (speed - START_SPEED) / (MAX_SPEED - START_SPEED);
  const lanes = shuffle([0, 1, 2]);
  const train = [false, false, false];
  const barrier = [false, false, false];
  const r = Math.random();

  if (r < 0.24) barrier[lanes[0]] = true;
  else if (r < 0.42) barrier[lanes[0]] = barrier[lanes[1]] = true;
  else if (r < 0.62) {
    train[lanes[0]] = true;
    if (Math.random() < 0.5) barrier[lanes[1]] = true;
  } else if (r < 0.84) {
    train[lanes[0]] = train[lanes[1]] = true;
    if (difficulty > 0.3 && Math.random() < 0.45) barrier[lanes[2]] = true;
  } else barrier.fill(true);

  const len = train.includes(true) ? pick([10, 13, 16]) : 1;
  const barrierZ = len > 1 ? zFront - len / 2 : zFront;
  for (let l = 0; l < 3; l++) {
    if (train[l]) spawnTrain(l, zFront, len);
    if (barrier[l]) spawnBarrier(l, barrierZ);
  }

  // Coins: an arc over a barrier or a line down a free lane
  if (Math.random() < 0.8) {
    const cl = pick([0, 1, 2].filter(l => !train[l]));
    const x = LANE_X[cl];
    if (barrier[cl]) {
      for (let i = 0; i < 7; i++) {
        const t = i / 3 - 1;
        spawnCoin(x, 0.8 + 1.5 * (1 - t * t), barrierZ - t * 4.5);
      }
    } else {
      const n = len > 1 ? Math.floor(len / 1.8) : 6;
      for (let i = 0; i < n; i++) spawnCoin(x, 0.8, zFront - i * 1.8);
    }
  }

  return len + 11 + speed * 0.5 + rand(0, 8);
}

// ---------- Audio (tiny WebAudio synth) ----------
const audio = { ctx: null, on: store.get('railrush-sound', '1') === '1' };
function audioCtx() {
  if (!audio.ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (C) audio.ctx = new C();
  }
  if (audio.ctx && audio.ctx.state === 'suspended') audio.ctx.resume();
  return audio.ctx;
}
function tone(f0, f1, dur, type = 'square', vol = 0.05, delay = 0) {
  if (!audio.on) return;
  const c = audioCtx();
  if (!c) return;
  const t = c.currentTime + delay;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}
function noise(dur, vol) {
  if (!audio.on) return;
  const c = audioCtx();
  if (!c) return;
  const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
  const src = c.createBufferSource();
  const g = c.createGain();
  g.gain.value = vol;
  src.buffer = buf;
  src.connect(g).connect(c.destination);
  src.start();
}
const sfx = {
  jump: () => tone(320, 760, 0.18, 'square', 0.045),
  lane: () => tone(520, 720, 0.06, 'triangle', 0.05),
  coin: () => { tone(988, 0, 0.07, 'square', 0.035); tone(1319, 0, 0.16, 'square', 0.035, 0.07); },
  crash: () => { tone(220, 40, 0.55, 'sawtooth', 0.1); noise(0.35, 0.18); },
  start: () => { tone(523, 0, 0.1, 'square', 0.04); tone(659, 0, 0.1, 'square', 0.04, 0.1); tone(784, 0, 0.2, 'square', 0.04, 0.2); },
  milestone: () => { tone(784, 0, 0.08, 'square', 0.04); tone(1047, 0, 0.18, 'square', 0.04, 0.08); },
};
function updateMuteIcon() { ui.mute.textContent = audio.on ? '🔊' : '🔇'; }
updateMuteIcon();

// ---------- Game state ----------
let state = 'ready'; // ready | playing | dead
let speed = IDLE_SPEED, distance = 0, coins = 0, nextRow = 0, nextMilestone = 1000;
let deadT = 0, shake = 0, runT = 0, coinSpin = 0;
let best = Number(store.get('railrush-best', 0)) || 0;
const p = { lane: 1, x: 0, y: 0, vy: 0, grounded: true, squash: 0 };
const score = () => Math.floor(distance) + coins * COIN_VALUE;

function setState(s) {
  state = s;
  document.body.dataset.state = s;
}

function start() {
  if (state === 'playing') return;
  audioCtx();
  sfx.start();
  ui.start.classList.add('hidden');
  ui.over.classList.add('hidden');

  while (active.length) release(active.length - 1);
  speed = START_SPEED;
  distance = 0;
  coins = 0;
  shake = 0;
  nextMilestone = 1000;
  Object.assign(p, { lane: 1, x: 0, y: 0, vy: 0, grounded: true, squash: 0 });
  player.body.rotation.set(0, 0, 0);
  player.root.position.set(0, 0, 0);
  for (const limb of [player.armL, player.armR, player.legL, player.legR]) limb.rotation.set(0, 0, 0);

  // Pre-fill the track so the action starts right away
  let z = -40;
  while (z > SPAWN_Z) z -= spawnRow(z);
  nextRow = SPAWN_Z - z;

  setState('playing');
}

function crash() {
  setState('dead');
  deadT = 0;
  shake = 0.7;
  p.vy = 6;
  p.grounded = false;
  sfx.crash();
  try { navigator.vibrate?.(120); } catch { /* not supported */ }
}

function showGameOver() {
  const s = score();
  const isBest = s > best;
  if (isBest) {
    best = s;
    store.set('railrush-best', best);
  }
  ui.final.textContent = s;
  ui.finalCoins.textContent = coins;
  ui.best.textContent = best;
  ui.newBest.style.display = isBest ? '' : 'none';
  ui.over.classList.remove('hidden');
  if (matchMedia('(hover: hover)').matches) ui.retry.focus({ preventScroll: true });
}

function collectCoin(o) {
  o.collected = true;
  coins++;
  sfx.coin();
  ui.coinPill.classList.remove('pop');
  void ui.coinPill.offsetWidth;
  ui.coinPill.classList.add('pop');
}

function toast(text) {
  ui.toast.textContent = text;
  ui.toast.classList.remove('show');
  void ui.toast.offsetWidth;
  ui.toast.classList.add('show');
}

// ---------- Simulation ----------
function step(dt) {
  if (state === 'playing') speed = Math.min(MAX_SPEED, speed + ACCEL * dt);
  const move = state === 'dead' ? 0 : speed * dt;
  if (state === 'playing') distance += move;

  for (const seg of segments) {
    seg.position.z += move;
    if (seg.position.z - SEG_LEN / 2 > DESPAWN_Z) {
      seg.position.z -= SEG_LEN * SEG_COUNT;
      dressSegment(seg);
    }
  }

  if (state === 'playing') {
    nextRow -= move;
    if (nextRow <= 0) nextRow += spawnRow(SPAWN_Z - nextRow);
  }

  for (let i = active.length - 1; i >= 0; i--) {
    const o = active[i];
    o.mesh.position.z += move;
    if (o.collected) o.t += dt;
    if (o.mesh.position.z - o.hd > DESPAWN_Z || o.t > 0.35) release(i);
  }

  // Player
  if (state !== 'dead') p.x += (LANE_X[p.lane] - p.x) * Math.min(1, dt * 14);
  if (!p.grounded) {
    p.vy -= GRAVITY * dt;
    p.y += p.vy * dt;
    if (p.y <= 0) {
      p.y = 0;
      p.vy = 0;
      p.grounded = true;
      if (state !== 'dead') p.squash = 1;
    }
  }

  if (state === 'playing') collide();
}

function collide() {
  const centerY = p.y + 0.9;
  for (const o of active) {
    const m = o.mesh;
    const dx = Math.abs(m.position.x - p.x);
    const dz = Math.abs(m.position.z);
    if (o.kind === 'coin') {
      if (!o.collected && dx < 0.9 && dz < 0.9 && Math.abs(m.position.y - centerY) < 1.1) collectCoin(o);
    } else if (dx < o.hw + 0.3 && dz < o.hd + 0.3 && p.y < o.h) {
      crash();
      return;
    }
  }
}

// ---------- Animation / camera ----------
const camTarget = new THREE.Vector3();
const lookTarget = new THREE.Vector3();

function animate(dt) {
  const damp = (a, b, k) => a + (b - a) * (1 - Math.exp(-k * dt));
  const { root, body, armL, armR, legL, legR } = player;

  root.position.x = p.x;
  root.position.y = p.y;

  if (state === 'dead') {
    deadT += dt;
    const k = Math.min(1, deadT * 3.2);
    body.rotation.x = k * 1.45;
    body.rotation.z = damp(body.rotation.z, 0, 8);
    root.position.z = k * 0.9;
    armL.rotation.z = -k * 1.3;
    armR.rotation.z = k * 1.3;
    legL.rotation.x = k * 0.4;
    legR.rotation.x = -k * 0.3;
    if (deadT > 1 && ui.over.classList.contains('hidden')) showGameOver();
  } else {
    runT += dt * (6 + speed * 0.32);
    const s = Math.sin(runT);
    const air = !p.grounded;
    legL.rotation.x = damp(legL.rotation.x, air ? -1.1 : s * 0.95, 25);
    legR.rotation.x = damp(legR.rotation.x, air ? 0.5 : -s * 0.95, 25);
    armL.rotation.x = damp(armL.rotation.x, air ? 0 : -s * 0.85, 25);
    armR.rotation.x = damp(armR.rotation.x, air ? 0 : s * 0.85, 25);
    armL.rotation.z = damp(armL.rotation.z, air ? -2.4 : -0.15, 18);
    armR.rotation.z = damp(armR.rotation.z, air ? 2.4 : 0.15, 18);
    body.position.y = air ? 0 : Math.abs(Math.cos(runT)) * 0.09;
    body.rotation.x = damp(body.rotation.x, -0.12, 10);
    body.rotation.z = damp(body.rotation.z, (p.x - LANE_X[p.lane]) * 0.18, 12);
    p.squash = damp(p.squash, 0, 10);
    body.scale.set(1 + p.squash * 0.15, 1 - p.squash * 0.2, 1 + p.squash * 0.15);
  }

  // Coins spin; collected ones fly up and pop
  coinSpin += dt * 4;
  for (const o of active) {
    if (o.kind !== 'coin') continue;
    o.mesh.rotation.y = coinSpin + o.mesh.position.z * 0.15;
    if (o.collected) {
      o.mesh.position.y += dt * 7;
      o.mesh.scale.setScalar(Math.max(0.01, 1 - o.t / 0.35) * (1 + o.t * 2));
    }
  }

  for (const c of clouds) {
    c.position.x += c.userData.v * dt;
    if (c.position.x > 170) c.position.x = -170;
  }

  // Camera: follows the runner, pulls back on portrait screens, widens with speed
  const aspect = window.innerWidth / window.innerHeight;
  const portrait = aspect < 1;
  camTarget.set(p.x * 0.55, 4.4 + p.y * 0.35 + (portrait ? 1 : 0), 8.5 + (portrait ? (1 - aspect) * 7 : 0));
  if (state === 'ready') camTarget.x += Math.sin(performance.now() / 1400) * 1.2;
  camera.position.x = damp(camera.position.x, camTarget.x, 8);
  camera.position.y = damp(camera.position.y, camTarget.y, 8);
  camera.position.z = damp(camera.position.z, camTarget.z, 8);
  lookTarget.set(p.x * 0.35, 1.3 + p.y * 0.2, -10);
  camera.lookAt(lookTarget);
  if (shake > 0.001) {
    camera.position.x += (Math.random() - 0.5) * shake;
    camera.position.y += (Math.random() - 0.5) * shake;
    shake *= Math.exp(-dt * 6);
  }
  const fov = (portrait ? 70 : 60) + Math.max(0, speed - START_SPEED) * 0.28;
  if (Math.abs(camera.fov - fov) > 0.05) {
    camera.fov = damp(camera.fov, fov, 4);
    camera.updateProjectionMatrix();
  }
  sky.position.copy(camera.position);
}

let shownScore = -1, shownCoins = -1;
function updateHUD() {
  const s = score();
  if (s !== shownScore) { ui.score.textContent = s; shownScore = s; }
  if (coins !== shownCoins) { ui.coins.textContent = coins; shownCoins = coins; }
  if (state === 'playing' && s >= nextMilestone) {
    toast(`${nextMilestone}!`);
    sfx.milestone();
    nextMilestone += 1000;
  }
}

// ---------- Input ----------
function moveLane(dir) {
  if (state !== 'playing') return;
  const lane = Math.max(0, Math.min(2, p.lane + dir));
  if (lane !== p.lane) {
    p.lane = lane;
    sfx.lane();
  }
}
function jump() {
  if (state === 'playing' && p.grounded) {
    p.vy = JUMP_V;
    p.grounded = false;
    sfx.jump();
  }
}
function drop() {
  if (state === 'playing' && !p.grounded) p.vy = Math.min(p.vy, -24);
}

window.addEventListener('keydown', e => {
  const code = e.code;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space'].includes(code)) e.preventDefault();
  if (code === 'KeyM') return toggleSound();
  if (state !== 'playing') {
    if ((code === 'Space' || code === 'Enter') && !e.repeat && (state === 'ready' || deadT > 1)) start();
    return;
  }
  if (e.repeat) return;
  if (code === 'ArrowLeft' || code === 'KeyA') moveLane(-1);
  else if (code === 'ArrowRight' || code === 'KeyD') moveLane(1);
  else if (code === 'ArrowUp' || code === 'KeyW' || code === 'Space') jump();
  else if (code === 'ArrowDown' || code === 'KeyS') drop();
});

// Swipes: act as soon as the finger has moved far enough, tap = jump
let touch = null;
const SWIPE_MIN = 28;
function handleSwipe(dx, dy) {
  if (Math.abs(dx) > Math.abs(dy)) moveLane(dx > 0 ? 1 : -1);
  else if (dy < 0) jump();
  else drop();
}
window.addEventListener('touchstart', e => {
  if (e.target.closest('button')) return;
  const t = e.changedTouches[0];
  touch = { x: t.clientX, y: t.clientY, used: false };
}, { passive: true });
window.addEventListener('touchmove', e => {
  if (state === 'playing') e.preventDefault();
  if (!touch || touch.used) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - touch.x;
  const dy = t.clientY - touch.y;
  if (Math.max(Math.abs(dx), Math.abs(dy)) > SWIPE_MIN) {
    handleSwipe(dx, dy);
    touch.used = true;
  }
}, { passive: false });
window.addEventListener('touchend', () => {
  if (touch && !touch.used) jump();
  touch = null;
});

function toggleSound() {
  audio.on = !audio.on;
  store.set('railrush-sound', audio.on ? '1' : '0');
  updateMuteIcon();
}

for (const btn of [ui.play, ui.retry]) {
  btn.addEventListener('click', e => {
    e.currentTarget.blur();
    start();
  });
}
ui.mute.addEventListener('click', e => {
  e.currentTarget.blur();
  toggleSound();
});

window.addEventListener('resize', () => {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ---------- Main loop ----------
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = Math.min(clock.getDelta(), 0.05);
  // Sub-step so fast speeds never tunnel through thin barriers
  const steps = Math.max(1, Math.ceil((speed * dt) / 0.5));
  for (let i = 0; i < steps; i++) step(dt / steps);
  animate(dt);
  updateHUD();
  renderer.render(scene, camera);
});
