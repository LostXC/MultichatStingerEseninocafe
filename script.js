'use strict';
/* =========================================================================
   Eseninocafe multichat stingers
   - tip-jar stinger : intro + persistent bit gems + arc bit throws
   - sub-stinger     : full-screen frame sequence @ 25fps
   - donation-stinger: same player, enabled once frames exist in
                       assets/donation-stinger/donation-stinger.00.svg …
   Trigger API: window.stinger  (also driven live by Streamer.bot, see bottom)
   ========================================================================= */

const { Engine, Bodies, Body, Composite, Sleeping } = Matter;

/* ---------------- config ---------------- */
const CFG = {
  fps: 25,                 // frame sequences play at 25fps
  gemSize: 72,             // settled gem size (design-space px, scaled via MAP)
  overlap: 0.4,            // physics radius shrink 0–0.5
  defaultBits: 20,         // demo fill amount
  maxJarGems: 26,          // physical jar capacity — oldest gems culled beyond this
  maxQueuedThrows: 40,     // big cheers get clamped to this many visible throws
  throwDurationMs: 780,    // full flight time along the arc
  throwStaggerMs: 170,     // gap between queued throws
  physicsHandoff: 0.8,     // fraction of the flight where physics takes over
  outsideTTLMs: 3200,      // gems that land outside the jar rest, then fade away
  outsideFadeMs: 700,
  noteDurationMs: 850,     
  noteOverlapThreshold: 0.3, // 0.6 means previous note is 60% done before next spawns
  // cheer(amount) decomposes the cheered bits into gem throws, biggest tier
  // first: one gem per full `min` of that tier, remainder flows down.
  // Each gray gem represents ~10 bits so the jar isn't flooded with tiny throws.
  bitTiers: [
    { min: 10000, gem: 'red'    },
    { min: 5000,  gem: 'blue'   },
    { min: 1000,  gem: 'green'  },
    { min: 100,   gem: 'purple' },
    { min: 10,    gem: 'gray'   },
  ],
  // merge ratios when jar overflows — N gems of color become 1 of the next tier
  mergeUp: [
    { from: 'gray',   to: 'purple', count: 10 },
    { from: 'purple', to: 'green',  count: 10 },
    { from: 'green',  to: 'blue',   count: 5  },
    { from: 'blue',   to: 'red',    count: 2  },
  ],
  storageKey: 'eseninocafe.tipjar.bits',
  subFrames: 65,
  waitBeforeFadeMs: 800,
  fadeOutMs: 400,
  subFadeInMs: 250,        // sub/dono stinger eases in instead of popping
};

const TIP_FILL   = i => `assets/tip-jar-stinger/fill/tip-jar.${pad2(i)}.svg`;
const TIP_STROKE = i => `assets/tip-jar-stinger/stroke/tip-jar.${pad2(i)}.svg`;
const SUB_FRAME  = i => `assets/sub-stinger/sub-stinger.${pad2(i)}.svg`;
const DONO_FRAME = i => `assets/donation-stinger/donation-stinger.${pad2(i)}.svg`;
const GEM_COLORS = ['red','blue','green','purple','gray'];
const GEM_URLS = GEM_COLORS.map(c => `assets/gems/bit-${c}.svg`);
let gemByColor = {};   // color -> loaded image, filled in loadAssets

const collision = window.TIPJAR_COLLISION;
const W = collision.meta.sourceWidth, H = collision.meta.sourceHeight;

/* ---- design-space mapping ----
   The throw arcs, note arcs, gem and sub-stinger sizes were authored in the
   original 500x650 mocks (bit-throw-structure.svg / music-effect.svg). The
   animation canvas can change (now 400x400) — everything is anchored to the
   jar's final backBox, so the authored geometry follows the art automatically. */
const DESIGN = { bbBottomCenter:[252.25, 324.285], bbW:340.9, subBottomY:650 };
const MAP = (()=>{
  const bb = collision.frames[collision.frames.length-1].backBox;
  const s = (bb.w*W)/DESIGN.bbW;
  return { s,
    dx: bb.cx*W - DESIGN.bbBottomCenter[0]*s,
    dy: (bb.cy+bb.h/2)*H - DESIGN.bbBottomCenter[1]*s };
})();
const mapPt = p => [p[0]*MAP.s+MAP.dx, p[1]*MAP.s+MAP.dy];

let GEM = Math.round(CFG.gemSize*MAP.s), OVERLAP = CFG.overlap;

const WALL_T = 16;
const LIVE = { frictionAir:.002, restitution:.15 };

/* =========================================================================
   Bit-throw geometry (from bit-throw-structure.svg, 500x650 space)

   Bits spawn one by one on a front "camera-near" arc at the bottom, fly a
   cubic bezier up over the rim and into the jar mouth, shrinking from
   near-camera size down to GEM at the mouth. Three reference curves were
   drawn (left / center / right); everything in between is interpolated
   with a quadratic Lagrange basis over u ∈ [0,1] (0=left, 0.5=center, 1=right).
   ========================================================================= */
const THROW = {
  spawn: { x0:81.5, x1:412.5, yEdge:491.264, sag:527 - 491.264 },
  // sample values at u = 0, 0.5, 1
  mouthX:    [227, 249.5, 267.5],
  mouthY:    326.5,
  ctrlSpawn: [[105,152.499],[249.5,211.5],[389.5,152.499]], // control near spawn
  ctrlMouth: [[201.5,101.5],[251,47.5002],[293,101.5]],     // control near mouth
  sizeEdge: 124, sizeCenter: 134,  // near-camera bit size at arc edge / center
  shrinkEnd: 0.75,                 // fraction of flight where size reaches GEM
};

// music-note arcs (from music-effect.svg, design space): notes float up-outward
const mapArc = a => ({ P0:mapPt(a.P0), P1:mapPt(a.P1), P2:mapPt(a.P2), P3:mapPt(a.P3) });
const NOTE_ARCS = {
  right: mapArc({ P0:[353,254],   P1:[367.5,192.502], P2:[418.5,155.002], P3:[442.5,148.502] }),
  left:  mapArc({ P0:[151.5,254], P1:[137,192.502],   P2:[86,155.002],    P3:[62,148.502]    }),
};

function pad2(i){ return String(i).padStart(2,'0'); }
const lerp = (a,b,f)=>a+(b-a)*f;
const bump = u => 4*u*(1-u);                    // 0 at edges, 1 at center
const smooth = t => t*t*(3-2*t);                // smoothstep
// quadratic Lagrange through samples at u = 0, 0.5, 1
function lag(u, s){ return s[0]*(2*u-1)*(u-1) + s[1]*4*u*(1-u) + s[2]*u*(2*u-1); }
function lagPt(u, pts){ return [lag(u, pts.map(p=>p[0])), lag(u, pts.map(p=>p[1]))]; }

function throwPathFor(u){
  const P0 = [ lerp(THROW.spawn.x0, THROW.spawn.x1, u),
               THROW.spawn.yEdge + THROW.spawn.sag * bump(u) ];
  const P1 = lagPt(u, THROW.ctrlSpawn);
  const P2 = lagPt(u, THROW.ctrlMouth);
  const P3 = [ lag(u, THROW.mouthX), THROW.mouthY ];
  const size0 = lerp(THROW.sizeEdge, THROW.sizeCenter, bump(u));
  return { P0:mapPt(P0), P1:mapPt(P1), P2:mapPt(P2), P3:mapPt(P3), size0: size0*MAP.s };
}
function cubic(p, t){
  const m = 1-t;
  return [
    m*m*m*p.P0[0] + 3*m*m*t*p.P1[0] + 3*m*t*t*p.P2[0] + t*t*t*p.P3[0],
    m*m*m*p.P0[1] + 3*m*m*t*p.P1[1] + 3*m*t*t*p.P2[1] + t*t*t*p.P3[1],
  ];
}
function cubicTangent(p, t){          // derivative, per unit t
  const m = 1-t;
  return [
    3*( (p.P1[0]-p.P0[0])*m*m + 2*(p.P2[0]-p.P1[0])*m*t + (p.P3[0]-p.P2[0])*t*t ),
    3*( (p.P1[1]-p.P0[1])*m*m + 2*(p.P2[1]-p.P1[1])*m*t + (p.P3[1]-p.P2[1])*t*t ),
  ];
}

/* ---------------- persistence ---------------- */
let savedGems = []; // array of {c, x, y, ang}

function loadBits(){
  let data;
  try{
    const stored = localStorage.getItem(CFG.storageKey);
    if(stored) data = JSON.parse(stored);
  }catch(e){}
  
  if (Array.isArray(data)) return data;
  if (typeof data === 'number') {
    const arr = [];
    for(let i=0; i<data; i++) arr.push({ c: null });
    return arr;
  }
  return [];
}
function saveBits(arr){ try{ localStorage.setItem(CFG.storageKey, JSON.stringify(arr)); }catch(e){} }

function setBitCount(n){
  savedGems = [];
  const count = Math.max(0, n|0);
  for(let i=0; i<count; i++) savedGems.push({ c: null });
  saveBits(savedGems);
  updateHUDCount();
}

function updateHUDCount() {
  const el = $('bitCount'); 
  if(el) {
    if (jarState === 'IDLE') el.textContent = 'bits: ' + savedGems.length;
    else el.textContent = 'bits: ' + (prefill.length + gems.length);
  }
}

function saveJarState() {
  const arr = [];
  const allGems = [...prefill, ...gems];
  for(const g of allGems) {
    if (g.position.y < H + GEM) {
      arr.push({
        c: g.plugin.color,
        x: g.position.x,
        y: g.position.y,
        ang: g.angle
      });
    }
  }
  savedGems = arr;
  saveBits(savedGems);
  updateHUDCount();
}

/* ---------------- assets ---------------- */
const $ = id => document.getElementById(id);
function loadImg(url){
  return new Promise((res, rej)=>{
    const im = new Image();
    im.onload = ()=>res(im);
    im.onerror = ()=>rej(new Error('missing ' + url));
    im.src = url;
  });
}

let fillImgs = [], strokeImgs = [], gemImgs = [], subImgs = [], donoImgs = [], noteImgs = [];

async function loadAssets(){
  const nTip = collision.frames.length;   // frame count follows collision.json
  const tipF = Promise.all(Array.from({length:nTip}, (_,i)=>loadImg(TIP_FILL(i))));
  const tipS = Promise.all(Array.from({length:nTip}, (_,i)=>loadImg(TIP_STROKE(i))));
  const subs = Promise.all(Array.from({length:CFG.subFrames}, (_,i)=>loadImg(SUB_FRAME(i))));
  const gems = Promise.all(GEM_URLS.map(loadImg));
  const notes = Promise.all(['assets/notes/music-eighth-note.svg',
                             'assets/notes/music-quaver-note.svg'].map(loadImg));
  [fillImgs, strokeImgs, subImgs, gemImgs, noteImgs] = await Promise.all([tipF, tipS, subs, gems, notes]);
  GEM_COLORS.forEach((c,i)=>{ gemByColor[c] = gemImgs[i]; });

  // donation frames are optional — probe until the first missing file
  for(let i=0; i<100; i++){
    try{ donoImgs.push(await loadImg(DONO_FRAME(i))); }
    catch(e){ break; }
  }
}

/* ---------------- pre-rasterized frames ----------------
   OBS's browser source (CEF) re-rasterizes an <svg> image on every drawImage —
   the jar redraws its fill + stroke (twice) full-canvas plus every gem each frame,
   so that vector work is what makes it lag/glitch in OBS even though it's smooth in
   a real browser. Bake every frame/sprite to an offscreen raster canvas once, at the
   size it's actually drawn, so the per-frame draws become cheap bitmap blits. */
let fillBaked = [], strokeBaked = [];
const gemBaked = new Map();    // source img -> baked canvas
const noteBaked = new Map();
function bakeToCanvas(img, w, h){
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}
function bakeAssets(){
  // Only the CONTINUOUS jar animation is baked (drawn full-canvas 3x + gems, every
  // frame) — that's the hot path. The sub/donation frames play straight from their
  // SVGs (a short one-shot, one draw per frame) so we don't keep ~40MB of extra
  // canvases resident, which can push OBS's browser source into crashing & reloading.
  fillBaked   = fillImgs.map(im => bakeToCanvas(im, W, H));   // full-canvas: exact 1:1 blits
  strokeBaked = strokeImgs.map(im => bakeToCanvas(im, W, H));
  // gems: bake at the largest on-screen size (a bit's spawn size in flight) so both
  // the smaller settled gems and the larger flying ones stay crisp when scaled.
  const gemPx = Math.ceil(Math.max(GEM, THROW.sizeCenter * MAP.s));
  for(const im of gemImgs){
    const s = gemPx / Math.max(im.width, im.height);
    gemBaked.set(im, bakeToCanvas(im, im.width * s, im.height * s));
  }
  for(const im of noteImgs) noteBaked.set(im, bakeToCanvas(im, im.width, im.height));
}

/* =========================================================================
   Collision / jar animation helpers (backBox smoothing, wall pairs,
   rigid jar transform for the settled-gem intro trick)
   ========================================================================= */
let smoothedBoxes = [];
function buildSmoothedBoxes(){
  smoothedBoxes = [];
  const N = collision.frames.length;
  for(let i=0; i<N; i++){
    const fr = collision.frames[i];
    if(!fr || !fr.backBox || fr.backBox.cx === undefined){ smoothedBoxes.push(null); continue; }
    let sumCx=0, sumCy=0, sumW=0, sumH=0, sumAng=0, count=0;
    for(let j=Math.max(0,i-2); j<=Math.min(N-1,i+2); j++){
      const b2 = collision.frames[j]?.backBox;
      if(b2 && b2.cx !== undefined){
        sumCx += b2.cx; sumCy += b2.cy; sumW += b2.w; sumH += b2.h;
        let ang = b2.angle || 0;
        if(count > 0){ // keep angle contiguous to avoid flip averaging
          const base = sumAng / count;
          while(ang - base >  Math.PI) ang -= Math.PI*2;
          while(ang - base < -Math.PI) ang += Math.PI*2;
        }
        sumAng += ang; count++;
      }
    }
    smoothedBoxes.push({ cx:(sumCx/count)*W, cy:(sumCy/count)*H,
                         w:(sumW/count)*W, h:(sumH/count)*H, angle:sumAng/count });
  }
}
function interpolatedBox(t){
  if(!smoothedBoxes.length) return null;
  const a = Math.floor(t), b2 = Math.min(a+1, smoothedBoxes.length-1), f = t-a;
  const A = smoothedBoxes[a], B = smoothedBoxes[b2];
  if(A && B){
    let da = B.angle - A.angle;
    if(da >  Math.PI) da -= 2*Math.PI;
    if(da < -Math.PI) da += 2*Math.PI;
    return { cx:A.cx+(B.cx-A.cx)*f, cy:A.cy+(B.cy-A.cy)*f,
             w:A.w+(B.w-A.w)*f, h:A.h+(B.h-A.h)*f, angle:A.angle+da*f };
  }
  return A || B;
}
// pad grows the box outward along its own axes (px), used to overlap the two
// stroke passes so their shared edge can't show a seam — see SEAM_OVERLAP.
function boxCornersAt(t, pad = 0){
  const bx = interpolatedBox(t);
  if(!bx) return null;
  const c = Math.cos(bx.angle), s = Math.sin(bx.angle), hw = bx.w/2 + pad, hh = bx.h/2 + pad;
  return [[-hw,-hh],[hw,-hh],[hw,hh],[-hw,hh]].map(([x,y])=>[bx.cx+x*c-y*s, bx.cy+x*s+y*c]);
}
function clipToCorners(ctx, corners){
  corners.forEach((p,i)=> i ? ctx.lineTo(p[0],p[1]) : ctx.moveTo(p[0],p[1]));
  ctx.closePath();
}

/* How far the BACK stroke pass reaches past the backBox, in canvas px.

   The jar's stroke is painted twice against complementary clips of the same
   box — inside it behind the gems, outside it in front of them — so together
   they should rebuild one whole stroke. Canvas clips are anti-aliased, though,
   so on the shared edge the back pass paints coverage a and the front pass
   1-a, and compositing those lands at 1-(1-a)*a, which never reaches opaque:
   the white fill underneath shows through as a hairline along the box's top
   and bottom edges. Letting the back pass run a pixel past the boundary makes
   it cover that line solidly. The front pass — the edge you actually see, and
   the one that decides which gems are occluded — is left exactly where it was,
   and it paints straight over the extra pixel. */
const SEAM_OVERLAP = 1;

/* Offscreen layer the jar is composited on before it's blitted at its current
   alpha — see the render loop. Allocated once and cleared per frame; sizing a
   canvas allocates a backing store, and doing that every frame would undo the
   point of baking the frames in the first place. */
let _jarLayer = null;
function jarLayer(){
  if(!_jarLayer){
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    _jarLayer = c.getContext('2d');
  }
  _jarLayer.clearRect(0, 0, W, H);
  return _jarLayer;
}

function pairsRaw(frameIdx){
  const fr = collision.frames[Math.min(frameIdx, collision.frames.length-1)];
  const pairs = [];
  if(fr.wallSegments){
    for(const poly of fr.wallSegments)
      for(let i=0; i<poly.length-1; i++)
        pairs.push([[poly[i][0]*W, poly[i][1]*H], [poly[i+1][0]*W, poly[i+1][1]*H]]);
  } else if(fr.sampled){
    for(let i=0; i<fr.sampled.length-1; i++)
      pairs.push([[fr.sampled[i][0]*W, fr.sampled[i][1]*H], [fr.sampled[i+1][0]*W, fr.sampled[i+1][1]*H]]);
  }
  return pairs;
}
function pairsAt(t){
  const a = Math.floor(t), b = Math.min(a+1, collision.frames.length-1), f = t-a;
  const A = pairsRaw(a), B = pairsRaw(b);
  if(!A.length) return B;
  if(!B.length || A.length !== B.length || f === 0) return A;
  return A.map((pa,i)=>{
    const pb = B[i];
    return [[pa[0][0]+(pb[0][0]-pa[0][0])*f, pa[0][1]+(pb[0][1]-pa[0][1])*f],
            [pa[1][0]+(pb[1][0]-pa[1][0])*f, pa[1][1]+(pb[1][1]-pa[1][1])*f]];
  });
}

// rigid transform for gem tracking, fitted to the CUP FLOOR ARC — the longest
// wallSegments polyline (7 tool-sampled points, stable correspondence every
// frame). It's the surface the gems sit on and it moves exactly with the art,
// so the gems neither twitch (hand-placed backBox wobble) nor lag (smoothing).
function cupArc(frameIdx){
  const fr = collision.frames[Math.min(frameIdx, collision.frames.length-1)];
  if(!fr.wallSegments || !fr.wallSegments.length) return null;
  let best = null;
  for(const poly of fr.wallSegments) if(!best || poly.length > best.length) best = poly;
  return best && best.length >= 3 ? best.map(p=>[p[0]*W, p[1]*H]) : null;
}
function cupArcAt(t){
  const a = Math.floor(t), b = Math.min(a+1, collision.frames.length-1), f = t-a;
  const A = cupArc(a), B = cupArc(b);
  if(!A) return B;
  if(!B || f === 0 || A.length !== B.length) return A;
  return A.map((pa,i)=>[pa[0]+(B[i][0]-pa[0])*f, pa[1]+(B[i][1]-pa[1])*f]);
}
function jarTransformBetween(tFrom, tTo){
  const A = cupArcAt(tFrom), B = cupArcAt(tTo);
  if(A && B && A.length === B.length && A.length >= 3){
    const ca = [A.reduce((s,p)=>s+p[0],0)/A.length, A.reduce((s,p)=>s+p[1],0)/A.length];
    const cb = [B.reduce((s,p)=>s+p[0],0)/B.length, B.reduce((s,p)=>s+p[1],0)/B.length];
    let sxx=0, sxy=0;
    for(let i=0; i<A.length; i++){
      const ax=A[i][0]-ca[0], ay=A[i][1]-ca[1];
      const bx=B[i][0]-cb[0], by=B[i][1]-cb[1];
      sxx += ax*bx + ay*by;
      sxy += ax*by - ay*bx;
    }
    return { ca, cb, dAng: Math.atan2(sxy, sxx), s:1 };
  }
  // fallback: smoothed backBox (frames without walls)
  const A2 = interpolatedBox(tFrom), B2 = interpolatedBox(tTo);
  if(!A2 || !B2) return null;
  let dAng = B2.angle - A2.angle;
  while(dAng >  Math.PI) dAng -= 2*Math.PI;
  while(dAng < -Math.PI) dAng += 2*Math.PI;
  return { ca:[A2.cx, A2.cy], cb:[B2.cx, B2.cy], dAng, s:1 };
}
function applyT(T, p){
  const dx=p[0]-T.ca[0], dy=p[1]-T.ca[1];
  const c=Math.cos(T.dAng), si=Math.sin(T.dAng);
  return [T.cb[0]+T.s*(dx*c-dy*si), T.cb[1]+T.s*(dx*si+dy*c)];
}

/* =========================================================================
   Tip jar runtime
   ========================================================================= */
let engine, walls=[], gems=[], prefill=[], flights=[], throwQueue=[], throwTimer=null;
let debug=false, gemDebug=false, arcDebug=false;
let playhead=0, playing=true, lastT=null, firstWallFrame=0, introHidden=true;
let jarState = 'IDLE'; // IDLE, INTRO, PLAYING, OUTRO
let outroT = 0;
let lastWallKey = null; // skips rebuilding the static physics walls every frame once settled
let physicsAcc = 0;     // real-time physics accumulator (keeps gems at correct speed below 60fps)
let idleTime = 0;
const LAST = ()=>fillImgs.length-1;

function makeGem(x, y, im){
  im = im || gemImgs[Math.floor(Math.random()*gemImgs.length)];
  const scale = GEM/Math.max(im.width, im.height);
  const r = GEM*0.5*(1-OVERLAP);
  const b = Bodies.circle(x, y, r, {...LIVE, friction:0.02, frictionStatic:0.05,
                                    density:0.002, angle:Math.random()*Math.PI});
  b.plugin = { im, scale, r };
  return b;
}

// how many gems physically fit in the cup at the final pose;
// CFG.maxJarGems is only the upper clamp
let JAR_CAP = CFG.maxJarGems;
function computeJarCapacity(){
  const pairs = pairsRaw(LAST());
  if(!pairs.length) return CFG.maxJarGems;
  let minX=1e9, maxX=-1e9, minY=1e9, maxY=-1e9;
  for(const [p,q] of pairs) for(const pt of [p,q]){
    minX=Math.min(minX,pt[0]); maxX=Math.max(maxX,pt[0]);
    minY=Math.min(minY,pt[1]); maxY=Math.max(maxY,pt[1]);
  }
  const eff = GEM*(1-OVERLAP);
  const cells = ((maxX-minX)-eff*0.5) * ((maxY-minY)-eff*0.5) / (eff*eff);
  return Math.max(4, Math.min(CFG.maxJarGems, Math.floor(cells*0.9)));
}

function boot(overridePrefillN = null){
  JAR_CAP = computeJarCapacity();
  
  let prefillGems = [...savedGems];
  if (overridePrefillN !== null && overridePrefillN < prefillGems.length) {
    prefillGems.sort((a,b) => (b.y || 0) - (a.y || 0));
    prefillGems.splice(0, prefillGems.length - overridePrefillN);
  } else if (prefillGems.length > JAR_CAP) {
    prefillGems.sort((a,b) => (b.y || 0) - (a.y || 0));
    prefillGems.splice(0, prefillGems.length - JAR_CAP);
  }

  const cv = $('jarCv'); cv.width = W; cv.height = H;

  walls=[]; gems=[]; prefill=[]; flights=[]; throwQueue=[];
  if(throwTimer){ clearInterval(throwTimer); throwTimer=null; }

  engine = Engine.create();
  engine.gravity.y = 5.35;
  engine.enableSleeping = true;
  engine.positionIterations = 16;
  engine.velocityIterations = 14;

  // ground collision removed so gems fall off screen immediately

  firstWallFrame = 0;
  for(let i=0; i<collision.frames.length; i++){ if(pairsRaw(i).length){ firstWallFrame=i; break; } }
  const nPairs = pairsRaw(firstWallFrame).length;
  for(let i=0; i<nPairs; i++){
    const b = Bodies.rectangle(0,-1000,10,10,{ isStatic:true, friction:.4, restitution:.05 });
    walls.push(b); Composite.add(engine.world, b);
  }

  positionWalls(pairsRaw(LAST()));
  
  for(let i=0; i<prefillGems.length; i++){
    const data = prefillGems[i];
    let im = data.c ? gemByColor[data.c] : null;
    let x = (data.x !== undefined) ? data.x : W*0.38 + Math.random()*W*0.24;
    let y = (data.y !== undefined) ? data.y : H*0.45 - i*GEM*0.45;
    let ang = data.ang !== undefined ? data.ang : Math.random()*Math.PI;
    
    const g = makeGem(x, y, im);
    Body.setAngle(g, ang);
    
    let colorStr = 'gray';
    for(const c of GEM_COLORS) { if (gemByColor[c] === g.plugin.im) colorStr = c; }
    g.plugin.color = colorStr;
    
    prefill.push(g); Composite.add(engine.world, g);
  }
  
  // always settle so gems rest properly inside the jar walls
  for(let i=0; i<400; i++) Engine.update(engine, 1000/60);
  captureAndFreeze(prefill);

  playhead=0; playing=true; introHidden=true; lastT=null;
  jarState = 'INTRO';
  idleTime = 0;
  lastWallKey = null;   // force a wall rebuild for the new run
}

function captureAndFreeze(list){
  for(const g of list){
    g.plugin.settled = { x:g.position.x, y:g.position.y, ang:g.angle };
    Body.setStatic(g, true);
  }
}
function unfreezeInto(t){
  const T = jarTransformBetween(LAST(), t);
  for(const g of prefill){
    const st = g.plugin.settled;
    const p = T ? applyT(T,[st.x,st.y]) : [st.x,st.y];
    Body.setPosition(g,{x:p[0],y:p[1]});
    Body.setAngle(g, st.ang + (T ? T.dAng : 0));
  }
}
function positionWalls(pairs){
  // the physics circle is (1-OVERLAP) of the sprite, so gems could visually poke
  // ~GEM*OVERLAP/2 through the art — inset every wall toward the jar interior
  // by exactly that slop so sprites stay inside the drawn walls
  let ccx=0, ccy=0, cn=0;
  for(const [p,q] of pairs){ ccx+=p[0]+q[0]; ccy+=p[1]+q[1]; cn+=2; }
  if(cn){ ccx/=cn; ccy/=cn; }
  const inset = (GEM*0.5*OVERLAP) + 8;
  for(let i=0; i<walls.length; i++){
    if(i >= pairs.length){ Body.setPosition(walls[i],{x:-2000,y:-2000}); continue; }
    let [[x1,y1],[x2,y2]] = pairs[i];
    const len = Math.hypot(x2-x1, y2-y1) || 1;
    let nx = -(y2-y1)/len, ny = (x2-x1)/len;
    const mx0=(x1+x2)/2, my0=(y1+y2)/2;
    if(nx*(ccx-mx0) + ny*(ccy-my0) < 0){ nx=-nx; ny=-ny; }
    x1+=nx*inset; y1+=ny*inset; x2+=nx*inset; y2+=ny*inset;
    const ang = Math.atan2(y2-y1, x2-x1);
    const ht = WALL_T/2;
    // center the body OUTSIDE the line so its collision FACE sits exactly on
    // the (inset) segment — a centered rect would float gems half a wall
    // thickness off the drawn floor arc
    const mx=(x1+x2)/2 - nx*ht, my=(y1+y2)/2 - ny*ht;
    const hw=Math.max(1,len/2), c=Math.cos(ang), s=Math.sin(ang);
    const vs=[[-hw,-ht],[hw,-ht],[hw,ht],[-hw,ht]].map(([vx,vy])=>({x:mx+vx*c-vy*s, y:my+vx*s+vy*c}));
    Body.setPosition(walls[i],{x:mx,y:my});
    Body.setVertices(walls[i], vs);
  }
}

/* ---------------- bit throwing ---------------- */
function launchFlight(color){
  const u = Math.random();
  const path = throwPathFor(u);
  flights.push({
    ...path,
    im: (color && gemByColor[color]) || gemImgs[Math.floor(Math.random()*gemImgs.length)],
    start: performance.now(),
    dur: CFG.throwDurationMs,
    angle0: Math.random()*Math.PI*2,
    spin: (Math.random()*2-1)*0.9,
  });
}
function landFlight(fl){
  // hand over to physics part-way along the arc, so the gem really drops in
  const h = CFG.physicsHandoff;
  const p = cubic(fl, h);
  const g = makeGem(p[0], p[1], fl.im);
  Body.setAngle(g, fl.angle0 + fl.spin*h);
  const [dx, dy] = cubicTangent(fl, h);
  let vx = dx/fl.dur*16.667, vy = dy/fl.dur*16.667;
  const sp = Math.hypot(vx, vy), cap = 14;
  if(sp > cap){ vx *= cap/sp; vy *= cap/sp; }
  Body.setVelocity(g, {x:vx, y:vy});
  Body.setAngularVelocity(g, fl.spin*0.15);
  let colorStr = 'gray';
  for(const c of GEM_COLORS) { if (gemByColor[c] === fl.im) colorStr = c; }
  g.plugin.color = colorStr;
  gems.push(g); Composite.add(engine.world, g);
  updateHUDCount();
  spawnNote();
  // the jar is finite: merge bottom gems into higher tiers to free space
  if(prefill.length + gems.length > JAR_CAP){
    mergeBottomGems();
  }
}

/* ---------------- gem merging (jar overflow) ---------------- */
function removeGem(g){
  Composite.remove(engine.world, g);
  let idx = prefill.indexOf(g);
  if(idx >= 0){ prefill.splice(idx, 1); return; }
  idx = gems.indexOf(g);
  if(idx >= 0) gems.splice(idx, 1);
}

function mergeBottomGems(){
  let needed = (prefill.length + gems.length) - JAR_CAP;
  if(needed <= 0) return;

  // find the lowest point in the jar (highest Y among wall pairs) for placing merged gems
  const pairs = pairsRaw(LAST());
  let bottomY = H * 0.7;
  let bottomX = W * 0.5;
  if(pairs.length){
    let maxY = -Infinity;
    for(const [p,q] of pairs){
      for(const pt of [p,q]){
        if(pt[1] > maxY){ maxY = pt[1]; bottomX = pt[0]; bottomY = pt[1] - GEM*0.5; }
      }
    }
  }

  // 1. Try strict merging: pick any gems of the right color from anywhere in the jar
  for(const rule of CFG.mergeUp){
    if(needed <= 0) break;
    while(needed > 0){
      // gather all gems of this color
      const matches = [...prefill, ...gems].filter(g => g.plugin.color === rule.from);
      if(matches.length < rule.count) break;   // not enough to merge

      // pick the first `count` (any, not position-dependent)
      const batch = matches.slice(0, rule.count);
      for(const g of batch) removeGem(g);

      // spawn the upgraded gem near the bottom of the jar
      const ng = makeGem(bottomX + (Math.random()-0.5)*GEM, bottomY);
      ng.plugin.color = rule.to;
      ng.plugin.im = gemByColor[rule.to];
      ng.plugin.scale = GEM / Math.max(ng.plugin.im.width, ng.plugin.im.height);
      gems.push(ng); Composite.add(engine.world, ng);

      needed -= (rule.count - 1);
    }
  }

  // 2. FORCE merge fallback if strict rules couldn't free enough space
  while(needed > 0){
    const all = [...prefill, ...gems];
    if (all.length < 2) break; // Needs at least 2 to merge

    // Visually make sense by merging the lowest tier gems first
    all.sort((a,b) => {
      let tA = GEM_COLORS.indexOf(a.plugin.color);
      let tB = GEM_COLORS.indexOf(b.plugin.color);
      if (tA === -1) tA = 4;
      if (tB === -1) tB = 4;
      return tB - tA;
    });

    const g1 = all[0];
    const g2 = all[1];

    let tier1 = GEM_COLORS.indexOf(g1.plugin.color);
    let tier2 = GEM_COLORS.indexOf(g2.plugin.color);
    if (tier1 === -1) tier1 = 4;
    if (tier2 === -1) tier2 = 4;
    
    let bestTier = Math.min(tier1, tier2);
    let nextTier = Math.max(0, bestTier - 1);
    let newColor = GEM_COLORS[nextTier];

    // Spawn the new gem at the position of whichever fused gem was lowest in the jar
    let spawnX = g1.position.y > g2.position.y ? g1.position.x : g2.position.x;
    let spawnY = g1.position.y > g2.position.y ? g1.position.y : g2.position.y;

    removeGem(g1);
    removeGem(g2);

    const ng = makeGem(spawnX, spawnY);
    ng.plugin.color = newColor;
    ng.plugin.im = gemByColor[newColor];
    ng.plugin.scale = GEM / Math.max(ng.plugin.im.width, ng.plugin.im.height);
    gems.push(ng); Composite.add(engine.world, ng);

    needed -= 1;
  }

  // Absolute fallback: if merging still couldn't free enough (e.g. only 1 gem left over 0 cap), delete
  if(needed > 0){
    const all = [...prefill, ...gems].sort((a,b) => b.position.y - a.position.y);
    for(let i = 0; i < needed && i < all.length; i++){
      removeGem(all[i]);
    }
  }

  // wake everything so the pile re-settles smoothly around the fused gems
  for(const g2 of prefill) Sleeping.set(g2, false);
  for(const g2 of gems)    Sleeping.set(g2, false);
}

// gems that bounce out land on the ground, rest a moment, then fade away
function cullEscaped(now){
  for(const list of [prefill, gems]){
    for(let i=list.length-1; i>=0; i--){
      const g = list[i], p = g.position;
      if(p.y > H+GEM || p.x < -GEM || p.x > W+GEM){        // fell off the world
        Composite.remove(engine.world, g); list.splice(i,1); continue;
      }
      const outside = p.y > H*0.6 && (p.x < W*0.235 || p.x > W*0.765);
      if(!outside){ delete g.plugin.outsideSince; g.plugin.alpha = 1; continue; }
      if(g.plugin.outsideSince === undefined) g.plugin.outsideSince = now;
      const fadeIn = now - g.plugin.outsideSince - (CFG.outsideTTLMs - CFG.outsideFadeMs);
      g.plugin.alpha = 1 - Math.max(0, Math.min(1, fadeIn/CFG.outsideFadeMs));
      if(g.plugin.alpha <= 0){ Composite.remove(engine.world, g); list.splice(i,1); }
    }
  }
}

/* ---------------- music notes (middle plane, one at a time) ---------------- */
let activeNotes = [], noteOnRight = false;
function spawnNote(){
  if(!noteImgs.length) return;
  
  const now = performance.now();
  
  // If there is already a note playing, check how far along it is
  if (activeNotes.length > 0) {
    const lastNote = activeNotes[activeNotes.length - 1];
    const t = (now - lastNote.start) / lastNote.dur;
    
    // If the newest note hasn't reached our "almost done" point (e.g., 60%), don't spawn a new one
    if (t < CFG.noteOverlapThreshold) return;
  }

  noteOnRight = !noteOnRight;
  activeNotes.push({
    im: noteImgs[Math.random() < 0.75 ? 0 : 1],   // 75% eighth, 25% quaver
    arc: noteOnRight ? NOTE_ARCS.right : NOTE_ARCS.left,
    dir: noteOnRight ? 1 : -1,
    start: now,
    dur: CFG.noteDurationMs,
  });
}

function drawNotes(ctx, now){
  // Loop backward to safely remove notes that have fully finished their arc
  for(let i = activeNotes.length - 1; i >= 0; i--) {
    const n = activeNotes[i];
    const t = (now - n.start) / n.dur;
    
    if(t >= 1){ 
      activeNotes.splice(i, 1); // Note is 100% done, remove from array
      continue; 
    }
    
    const e = 1-(1-t)*(1-t);                        // ease-out along the arc
    const p = cubic(n.arc, e);
    const scale = MAP.s * lerp(1, 1.26, e);         // grows toward the camera
    const rot = n.dir * e * 4 * Math.PI/180;        // slight outward tilt
    const alpha = Math.min(1, t/0.12) * (1 - smooth(Math.max(0, (t-0.7)/0.3)));
    
    ctx.save();
    ctx.globalAlpha *= alpha;
    ctx.translate(p[0], p[1]); ctx.rotate(rot); ctx.scale(scale, scale);
    ctx.drawImage(noteBaked.get(n.im) || n.im, -n.im.width/2, -n.im.height/2);
    ctx.restore();
  }
}

function pumpThrowQueue(){
  if(throwTimer || !throwQueue.length) return;
  throwTimer = setInterval(()=>{
    if(jarState !== 'PLAYING' || !throwQueue.length){     // wait out the intro
      if(!throwQueue.length){ clearInterval(throwTimer); throwTimer=null; }
      return;
    }
    launchFlight(throwQueue.shift());
    if(!throwQueue.length){ clearInterval(throwTimer); throwTimer=null; }
  }, CFG.throwStaggerMs);
}
// queue n throws; color is one of GEM_COLORS, or null for random
// merge savedGems data so N low-tier gems become 1 higher-tier gem
// queue n throws; color is one of GEM_COLORS, or null for random
// merge savedGems data so N low-tier gems become 1 higher-tier gem
function mergeSavedGems(targetCount){
  // 1. Sanitize: ensure any uncolored gems are marked as 'gray' so merging doesn't break
  for(let i=0; i<savedGems.length; i++){
    if(!savedGems[i].c) savedGems[i].c = 'gray';
  }

  // 2. Strict merge (e.g. 10 gray -> 1 purple)
  while(savedGems.length > targetCount){
    let merged = false;
    for(const rule of CFG.mergeUp){
      const indices = [];
      for(let i = 0; i < savedGems.length; i++){
        if(savedGems[i].c === rule.from) indices.push(i);
        if(indices.length >= rule.count) break;
      }
      if(indices.length >= rule.count){
        // remove matched gems (reverse order to keep indices valid)
        for(let j = indices.length - 1; j >= 0; j--) savedGems.splice(indices[j], 1);
        // add the upgraded gem (no position — physics will settle it)
        savedGems.push({ c: rule.to });
        merged = true;
        break;
      }
    }
    if(!merged) break;  // can't merge anymore with strict rules, stop
  }

  // 3. Force merge: If STILL over limit, fuse the lowest value gems to forcefully reduce count
  while(savedGems.length > targetCount && savedGems.length >= 2){
    // Sort by tier, lowest tier first ('gray' is highest index 4, 'red' is 0)
    savedGems.sort((a, b) => {
      let tA = GEM_COLORS.indexOf(a.c);
      let tB = GEM_COLORS.indexOf(b.c);
      if (tA === -1) tA = 4;
      if (tB === -1) tB = 4;
      return tB - tA; 
    });

    let g1 = savedGems[0];
    let g2 = savedGems[1];

    let tier1 = GEM_COLORS.indexOf(g1.c);
    let tier2 = GEM_COLORS.indexOf(g2.c);
    if (tier1 === -1) tier1 = 4;
    if (tier2 === -1) tier2 = 4;

    // Upgrade to the next tier above the highest of the two fused gems
    let bestTier = Math.min(tier1, tier2);
    let nextTier = Math.max(0, bestTier - 1); // Cap at 'red' (0)

    savedGems.splice(0, 2);
    savedGems.push({ c: GEM_COLORS[nextTier] });
  }
}

function startCheerSequence(throws) {
  if (jarState === 'IDLE' || jarState === 'OUTRO') {
    JAR_CAP = computeJarCapacity();
    let targetPrefill = Math.max(0, JAR_CAP - throws.length);
    // merge saved gems to make room instead of deleting them
    if(savedGems.length > targetPrefill){
      mergeSavedGems(targetPrefill);
      saveBits(savedGems);
    }
    boot();
  }
  
  for(let c of throws) {
    if (throwQueue.length < CFG.maxQueuedThrows) {
      throwQueue.push(c);
    }
  }
  
  if (jarState === 'PLAYING') {
    pumpThrowQueue();
  }
  idleTime = 0;
}

function throwBits(n=1, color=null){
  let arr = [];
  for(let i=0; i<Math.max(1, n|0) && arr.length<CFG.maxQueuedThrows; i++)
    arr.push(color);
  startCheerSequence(arr);
}
// decompose a cheered bits amount into typed gem throws (see CFG.bitTiers)
function cheer(bits){
  let rest = Math.max(0, bits|0);
  if(!rest) return;

  let newThrows = [];
  for(const tier of CFG.bitTiers){
    if(rest <= 0) break;
    const n = Math.floor(rest / tier.min);
    if(n <= 0) continue;
    rest -= n * tier.min;
    for(let i = 0; i < n; i++) newThrows.push(tier.gem);
  }
  // minimum 1 gray for any nonzero cheer below the smallest tier
  if(!newThrows.length) newThrows.push('gray');
  
  startCheerSequence(newThrows);
}

function drawGem(ctx, g){
  const { im, scale } = g.plugin;
  const src = gemBaked.get(im) || im;   // baked raster (falls back to the svg pre-bake)
  ctx.save();
  if(g.plugin.alpha !== undefined) ctx.globalAlpha *= g.plugin.alpha;
  ctx.translate(g.position.x, g.position.y); ctx.rotate(g.angle);
  ctx.drawImage(src, -im.width*scale/2, -im.height*scale/2, im.width*scale, im.height*scale);
  ctx.restore();
}
function drawFlight(ctx, fl, now){
  const t = Math.min(1, (now-fl.start)/fl.dur);
  const p = cubic(fl, t);
  const size = lerp(fl.size0, GEM, smooth(Math.min(1, t/THROW.shrinkEnd)));
  const scale = size/Math.max(fl.im.width, fl.im.height);
  const src = gemBaked.get(fl.im) || fl.im;
  ctx.save(); ctx.translate(p[0], p[1]); ctx.rotate(fl.angle0 + fl.spin*t);
  ctx.drawImage(src, -fl.im.width*scale/2, -fl.im.height*scale/2,
                fl.im.width*scale, fl.im.height*scale);
  ctx.restore();
}

/* ---------------- main loop ---------------- */
function loop(ts){
  if (jarState === 'IDLE') {
    lastT = ts;
    const ctx = $('jarCv').getContext('2d');
    ctx.clearRect(0,0,W,H);
    renderFramePlayer(performance.now());   // a sub/dono can play over the idle (blank) jar
    requestAnimationFrame(loop);
    return;
  }

  if (lastT === null) lastT = ts;
  const dt = ts - lastT;
  lastT = ts;

  if (jarState === 'OUTRO') {
    outroT += dt;
    if (outroT > CFG.fadeOutMs) {
      jarState = 'IDLE';
      const ctx = $('jarCv').getContext('2d');
      ctx.clearRect(0,0,W,H);
      requestAnimationFrame(loop);
      return;
    }
  }

  if(playing){
    // clamp the frame delta: if the browser source stalls (OBS throttling,
    // tab hidden), the intro pauses instead of teleporting to the end with
    // the gems left hanging mid-air
    playhead = Math.min(playhead + Math.min(dt, 100)/1000*CFG.fps, LAST());
    if(introHidden && playhead >= firstWallFrame){
      introHidden = false;
      unfreezeInto(playhead);
    }
    if(playhead >= LAST()){
      playing = false;
      jarState = 'PLAYING';
      pumpThrowQueue();
      for(const g of prefill){
        Body.setStatic(g, false);
        Body.setVelocity(g,{x:0,y:0}); Body.setAngularVelocity(g,0);
        g.frictionAir = LIVE.frictionAir; g.restitution = LIVE.restitution;
      }
    }
  }

  // While the jar is moving (intro) the walls track it every frame; once it's
  // settled into PLAYING the pose is constant, so rebuild them once and then skip
  // — Body.setVertices on every wall each frame was pure waste during throwing.
  if(playing){
    positionWalls(pairsAt(playhead));
    lastWallKey = null;
  } else if(lastWallKey !== 'settled'){
    positionWalls(pairsAt(LAST()));
    lastWallKey = 'settled';
  }

  if(playing && !introHidden){
    const T = jarTransformBetween(LAST(), playhead);
    if(T){
      for(const g of prefill){
        const st = g.plugin.settled;
        const p = applyT(T,[st.x,st.y]);
        Body.setPosition(g,{x:p[0],y:p[1]});
        Body.setAngle(g, st.ang + T.dAng);
      }
    }
  }

  // Real-time fixed-step physics. The old code ran exactly 4 sub-steps per frame,
  // which advances the simulation a fixed 16.7ms regardless of the real frame time —
  // so whenever OBS dips below 60fps the gems fall in slow-motion and desync from the
  // (real-time) bit flights, which reads as "glitchy". Drive the same 240Hz sub-step
  // off real elapsed time instead: identical to before at 60fps, correct below it.
  const STEP = 1000/240;
  physicsAcc += Math.min(dt, 100);              // clamp so a stall can't spiral
  let pSteps = 0;
  while(physicsAcc >= STEP && pSteps < 24){ Engine.update(engine, STEP); physicsAcc -= STEP; pSteps++; }
  if(pSteps >= 24) physicsAcc = 0;              // fell far behind — drop the backlog

  // hand flights to physics part-way (pure animation until this moment)
  const now = performance.now();
  for(let i=flights.length-1; i>=0; i--){
    if(now - flights[i].start >= flights[i].dur*CFG.physicsHandoff){
      landFlight(flights[i]);
      flights.splice(i,1);
    }
  }
  if(!playing) cullEscaped(now);

  if (jarState === 'PLAYING') {
    if (throwQueue.length === 0 && flights.length === 0 && activeNotes.length === 0) {
      idleTime += dt;
      if (idleTime > CFG.waitBeforeFadeMs) {
        saveJarState();
        jarState = 'OUTRO';
        outroT = 0;
      }
    } else {
      idleTime = 0;
    }
  }

  const ctx = $('jarCv').getContext('2d');
  ctx.clearRect(0,0,W,H);
  const fi = Math.round(playing ? playhead : LAST());
  let alpha = 1;
  if (jarState === 'OUTRO') {
    alpha = 1 - Math.min(1, outroT / CFG.fadeOutMs);
  } else {
    alpha = playing && playhead <= 3 ? playhead/3 : 1;
  }
  const fillImg = fillBaked[fi] || fillImgs[fi], strokeImg = strokeBaked[fi] || strokeImgs[fi];

  /* The jar is assembled opaque on its own layer and blitted once at `alpha`.

     Fading each pass individually instead is what made the fade look wrong: the
     stroke is painted twice against complementary clips (see SEAM_OVERLAP), and
     wherever those two passes overlap, two draws at alpha a composite to
     1-(1-a)^2 — darker than the single draw everywhere else, so the overlap
     surfaced as a dark hairline the moment the jar started fading. Any two
     overlapping pieces had the same problem; a gem crossing the stroke was
     quietly denser than the rest of it all the way through the fade.

     Compositing first and fading once means every overlap resolves at full
     opacity, exactly as it looks when the jar is solid, and `alpha` then dims a
     finished picture. Costs one extra 400x400 blit per frame. */
  const lx = jarLayer();
  lx.drawImage(fillImg, 0, 0, W, H);

  const boxT = playing ? playhead : LAST();
  const corners = boxCornersAt(boxT);
  if(corners){
    lx.save();
    // grown by SEAM_OVERLAP so this pass covers the boundary the front pass
    // will only half-cover; the overlap ends up hidden under that pass
    lx.beginPath(); clipToCorners(lx, boxCornersAt(boxT, SEAM_OVERLAP)); lx.clip();
    lx.drawImage(strokeImg, 0, 0, W, H);
    lx.restore();
  }

  drawNotes(lx, now);   // middle ground: behind the gems, in front of the back art

  if(!introHidden) for(const g of prefill) drawGem(lx, g);
  for(const g of gems) drawGem(lx, g);

  if(corners){
    lx.save();
    lx.beginPath();
    lx.rect(0,0,W,H);
    clipToCorners(lx, corners);
    lx.clip('evenodd');
    lx.drawImage(strokeImg, 0, 0, W, H);
    lx.restore();
  } else {
    lx.drawImage(strokeImg, 0, 0, W, H);
  }

  // front-most plane: flying bits, over the jar stroke
  for(const fl of flights) drawFlight(lx, fl, now);

  ctx.globalAlpha = alpha;
  ctx.drawImage(lx.canvas, 0, 0);
  ctx.globalAlpha = 1;

  if(debug){
    ctx.strokeStyle='#3a7bff'; ctx.lineWidth=2;
    ctx.beginPath();
    for(const [p,q] of pairsAt(playing ? playhead : LAST())){ ctx.moveTo(p[0],p[1]); ctx.lineTo(q[0],q[1]); }
    ctx.stroke();
    if(corners){ ctx.strokeStyle='#ff8a00'; ctx.beginPath(); clipToCorners(ctx,corners); ctx.stroke(); }
  }
  if(gemDebug){
    ctx.strokeStyle='#00b34d'; ctx.lineWidth=2;
    for(const g of [...prefill, ...gems]){
      ctx.beginPath(); ctx.arc(g.position.x, g.position.y, g.plugin.r, 0, Math.PI*2); ctx.stroke();
    }
  }
  if(arcDebug){
    ctx.lineWidth=1.5;
    for(let k=0; k<=10; k++){
      const p = throwPathFor(k/10);
      ctx.strokeStyle='rgba(255,0,80,.5)';
      ctx.beginPath(); ctx.moveTo(p.P0[0], p.P0[1]);
      ctx.bezierCurveTo(p.P1[0],p.P1[1], p.P2[0],p.P2[1], p.P3[0],p.P3[1]);
      ctx.stroke();
    }
  }
  renderFramePlayer(now);   // sub/dono overlay, drawn by this same loop
  requestAnimationFrame(loop);
}

/* =========================================================================
   Full-screen frame stingers (sub / donation)
   Driven by the SAME main loop that renders the jar (renderFramePlayer, called
   every frame from loop()). The old version ran its own requestAnimationFrame on
   a position:fixed canvas — that combination dropped out of the render in OBS's
   browser source (the sub never showed there, though it did in a real browser).
   It fades itself IN and OUT on its real timeline, so nothing else has to time it.
   ========================================================================= */
const stingerCv = ()=>$('stingerCv');
let stingerBusy = false;         // a sub/dono sequence is on screen
let framePlay = null;            // { imgs, type, t0 }

function playFrames(imgs, type){
  if(!imgs.length || stingerBusy) return;
  stingerBusy = true;
  const cv = stingerCv();
  cv.width = imgs[0].width; cv.height = imgs[0].height;
  cv.style.display = 'block';
  framePlay = { imgs, type, t0: performance.now() };
}
function playSub(){ playFrames(subImgs, 'sub'); }
function playDonation(){
  if(!donoImgs.length){
    console.warn('[stinger] donation-stinger frames not found — add assets/donation-stinger/donation-stinger.00.svg …');
    return;
  }
  playFrames(donoImgs, 'dono');
}

// Advance + draw the active sub/dono frame. Called once per frame by loop().
function renderFramePlayer(now){
  if(!framePlay) return;
  const { imgs, t0 } = framePlay;
  const cv = stingerCv(), ctx = cv.getContext('2d');
  const elapsed = now - t0;
  const totalDuration = imgs.length / CFG.fps * 1000;

  let alpha = 1, fi = Math.floor(elapsed/1000*CFG.fps), isFinished = false;
  if (elapsed >= totalDuration) {
    fi = imgs.length - 1;                       // hold the last frame
    const post = elapsed - totalDuration;
    if (post >= CFG.waitBeforeFadeMs) {
      const fo = post - CFG.waitBeforeFadeMs;
      if (fo < CFG.fadeOutMs) alpha = 1 - fo/CFG.fadeOutMs;   // real outro fade
      else { alpha = 0; isFinished = true; }
    }
  }
  if (elapsed < CFG.subFadeInMs) alpha = Math.min(alpha, elapsed / CFG.subFadeInMs);  // ease in

  if (isFinished) { ctx.clearRect(0,0,cv.width,cv.height); cv.style.display = 'none'; framePlay = null; stingerBusy = false; return; }

  ctx.clearRect(0,0,cv.width,cv.height);
  ctx.globalAlpha = alpha;
  ctx.drawImage(imgs[fi], 0, 0);
  ctx.globalAlpha = 1;
}

/* =========================================================================
   Public API + Streamer.bot hookup point
   ========================================================================= */
window.stinger = {
  cheer,                           // stinger.cheer(1234) — cheered amount -> tiered gems
  throwBits,                       // stinger.throwBits(5, 'red'?) — raw throws (color optional)
  playSub,                         // stinger.playSub()
  playDonation,                    // stinger.playDonation()
  replayIntro: ()=>boot(Math.min(savedGems.length, computeJarCapacity())),
  setBits: n => { setBitCount(n); boot(Math.min(n, computeJarCapacity())); },
  resetBits: ()=> { setBitCount(0); boot(0); },
  get bits(){ return savedGems.length; },
};

/* =========================================================================
   Chat-overlay sync
   -------------------------------------------------------------------------
   The chat overlay (MultichatOverlayEseninocafe) and this stinger are two
   SEPARATE OBS browser sources layered over each other. OBS isolates browser
   sources (no shared localStorage / BroadcastChannel), so they can't talk to
   each other directly — instead they BOTH subscribe to the same Streamer.bot
   events and react on their own.

   This source drives NO fixed timing: the jar and the sub each fade themselves in
   and out on their real completion (the jar via its own intro/outro, the sub via
   renderFramePlayer). All triggerStinger does is hold the effect back by chatFadeMs
   so the chat has faded out first. Because there is no forced duration here, the
   jar can never "false fade" mid-throw.

   stingerContentMs() only *predicts* how long a stinger will run, so the overlay
   knows roughly when to fade its chat back in. It must stay identical to the copy
   in the overlay's script.js. It errs slightly long; and since this stinger is
   layered on top, a small mismatch is hidden behind it anyway.
   ========================================================================= */
const STINGER_SYNC = {
  chatFadeMs:     350,  // how long the overlay's chat fade takes (we just wait it out)
  // --- tip-jar timing model (mirrors CFG in this file) so the overlay can predict
  //     a cheer's length from the bit amount. Keep in step with CFG if you retune. ---
  fps:            25,   // CFG.fps
  jarIntroFrames: 36,   // collision.frames.length — the jar-rise intro
  throwStaggerMs: 170,  // CFG.throwStaggerMs — gap between queued throws
  throwFlightMs:  780,  // CFG.throwDurationMs — a gem's flight time
  noteTailMs:     850,  // CFG.noteDurationMs — the last note lingers after the last landing
  jarIdleMs:      800,  // CFG.waitBeforeFadeMs — idle the jar/sub holds before it fades out
  maxThrows:      40,   // CFG.maxQueuedThrows — the jar clamps a cheer to this many
  subFrames:      65,   // sub-stinger frame count (subImgs.length)
  marginMs:       250,  // small pad so the chat's card lands as the stinger clears, not before
};

// How many gems a cheer throws — mirrors CFG.bitTiers decomposition (biggest tier
// first, one gem per full tier amount, remainder flows down), clamped like the jar.
function stingerCheerThrows(bits){
  const mins = [10000, 5000, 1000, 100, 10];
  let rest = Math.max(0, Math.floor(bits) || 0), n = 0;
  for(const m of mins){ const c = Math.floor(rest / m); if(c > 0){ rest -= c * m; n += c; } }
  if(n === 0) n = 1;                       // any nonzero cheer throws at least one gray
  return Math.min(n, STINGER_SYNC.maxThrows);
}

// Predicted on-screen time (ms), from the effect firing to it starting to fade out.
// Shared verbatim with the overlay so its chat returns as the stinger clears.
function stingerContentMs(kind, data){
  const S = STINGER_SYNC;
  if(kind === 'cheer'){
    const n = stingerCheerThrows(data && data.bits);
    const introMs  = S.jarIntroFrames / S.fps * 1000;                  // jar rises
    const throwsMs = (n - 1) * S.throwStaggerMs + S.throwFlightMs;      // launch all + last flight
    return Math.round(introMs + throwsMs + S.noteTailMs + S.jarIdleMs + S.marginMs);
  }
  // sub / resub / gift / bomb — frames play, then hold jarIdleMs, then fade
  return Math.round(S.subFrames / S.fps * 1000 + S.jarIdleMs + S.marginMs);
}

// Route a Streamer.bot event to the stinger. The jar/sub own their own fades, so we
// only delay the trigger by chatFadeMs (let the chat fade out first) and collapse a
// gift-sub bomb into a single sub.
let subQueued = false;
function triggerStinger(kind, effect){
  if(kind === 'sub'){
    if(subQueued || stingerBusy) return;                                // one sub at a time
    subQueued = true;
    setTimeout(() => { subQueued = false; effect(); }, STINGER_SYNC.chatFadeMs);
  } else {
    setTimeout(effect, STINGER_SYNC.chatFadeMs);                        // the jar queues multiple cheers itself
  }
}

/* =========================================================================
   Streamer.bot connection
   Uses the official @streamerbot/client (loaded in index.html). It connects
   to the Streamer.bot WebSocket server running on the same machine as OBS
   (default 127.0.0.1:8080), auto-reconnects, and maps events to the stinger.

   OBS browser source: just point it at the deployed index.html at 400x400.
   Optional URL params (all have sensible defaults):
     ?address=127.0.0.1   Streamer.bot host
     ?port=8080           Streamer.bot WebSocket port
     ?showCheers=false    disable the cheer -> tip-jar reaction
     ?showSubs=false      disable the sub/resub/giftsub -> sub stinger
   ========================================================================= */
function connectStreamerbot(){
  const p = new URLSearchParams(location.search);
  const boolParam = (k, def) => {
    const v = p.get(k);
    if(v === null) return def;
    return v !== 'false' && v !== '0';
  };
  const address    = p.get('address') || '127.0.0.1';
  const port       = p.get('port')    || '8080';
  const showCheers = boolParam('showCheers', true);
  const showSubs   = boolParam('showSubs', true);

  if(typeof StreamerbotClient === 'undefined'){
    console.warn('[stinger] @streamerbot/client not loaded — running in manual/HUD mode only');
    return;
  }

  const client = new StreamerbotClient({
    host: address,
    port: port,
    onConnect: () => console.log('[stinger] connected to Streamer.bot'),
    onDisconnect: () => console.log('[stinger] disconnected from Streamer.bot — retrying…'),
  });

  // Cheer -> tiered bit gems in the tip jar (delayed so the chat fades out first)
  if(showCheers){
    client.on('Twitch.Cheer', ({ data }) => {
      const bits = Number(data?.bits ?? data?.message?.bits ?? 0);
      console.log('[stinger] Twitch.Cheer received — bits:', bits);
      if(bits > 0) triggerStinger('cheer', () => stinger.cheer(bits));
    });
  }

  // Sub / Resub / Gift sub -> full-screen sub stinger (donation stinger untouched).
  // A gift-sub bomb fires many GiftSub events; triggerStinger collapses them into one.
  if(showSubs){
    const onSub = (name) => () => {
      console.log('[stinger] ' + name + ' received → sub stinger');
      triggerStinger('sub', () => stinger.playSub());
    };
    client.on('Twitch.Sub',     onSub('Twitch.Sub'));
    client.on('Twitch.ReSub',   onSub('Twitch.ReSub'));
    client.on('Twitch.GiftSub', onSub('Twitch.GiftSub'));
  }

  // Empty the tip jar at the start of each stream. Streamer.bot fires StreamOnline
  // when you go live; setBitCount(0) clears the saved gems silently (no animation —
  // the jar just stays blank until the first cheer). The jar still persists across
  // reloads DURING a stream, so a scene switch or accidental refresh won't wipe it.
  // Disable with ?resetEachStream=false.
  if(boolParam('resetEachStream', true)){
    client.on('Twitch.StreamOnline', () => {
      console.log('[stinger] Twitch.StreamOnline — emptying the tip jar for the new stream');
      setBitCount(0);
    });
  }
}
connectStreamerbot();

/* ---------------- HUD / keys / boot ---------------- */
function wireHud(){
  $('throw1Btn').onclick  = ()=>throwBits(1);
  $('throw10Btn').onclick = ()=>throwBits(10);
  $('cheerBtn').onclick   = ()=>cheer(parseInt($('cheerAmt').value, 10) || 0);
  $('subBtn').onclick     = ()=>playSub();
  $('donoBtn').onclick    = ()=>playDonation();
  $('replayBtn').onclick  = ()=>boot(Math.min(bitCount, computeJarCapacity()));
  $('demoBtn').onclick    = ()=>{ setBitCount(CFG.defaultBits); boot(CFG.defaultBits); };
  $('resetBtn').onclick   = ()=>{ setBitCount(0); boot(0); };
  $('debugChk').onchange    = e=>{ debug = e.target.checked; };
  $('gemDebugChk').onchange = e=>{ gemDebug = e.target.checked; };
  $('arcDebugChk').onchange = e=>{ arcDebug = e.target.checked; };

  addEventListener('keydown', e=>{
    if(e.repeat) return;
    switch(e.key.toLowerCase()){
      case 'h': $('hud').hidden = !$('hud').hidden; break;
      case 't': throwBits(1); break;
      case 'y': throwBits(10); break;
      case 's': playSub(); break;
      case 'd': playDonation(); break;
      case 'r': boot(); break;
    }
  });
}

(async ()=>{
  const params = new URLSearchParams(location.search);
  // Only surface the "loading assets…" note while debugging — on stream it must stay
  // invisible (OBS reloads the source on scene changes, and a routine loader flashing
  // each time looks broken). A hard asset error still shows so it isn't a silent blank.
  if(params.has('debug')) $('loading').hidden = false;
  try{
    await loadAssets();
  }catch(err){
    $('loading').hidden = false;
    $('loading').textContent = 'asset error: ' + err.message;
    return;
  }
  $('loading').hidden = true;

  bakeAssets();          // pre-rasterize every SVG frame/sprite so OBS isn't re-rasterizing them each frame
  buildSmoothedBoxes();
  if (params.has('bits')) {
    setBitCount(parseInt(params.get('bits'),10) || 0);
  } else {
    savedGems = loadBits();
    updateHUDCount();
  }
  if(params.has('debug')) $('hud').hidden = false;

  wireHud();
  // We don't boot() here so it starts visually empty (IDLE)
  jarState = 'IDLE';
  requestAnimationFrame(loop);
})();