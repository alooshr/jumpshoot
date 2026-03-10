'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const W = 800, H = 450;          // canvas size

// Physics
const GRAVITY      = 0.5;
const JUMP_VEL     = -11.5;
const WALK_SPEED   = 4;
const MAX_FALL     = 15;

// Jump feel
const JUMP_CUT     = 0.45;       // vy multiplier when jump released early
const COYOTE_TIME  = 6;          // frames after leaving ground where jump still works
const JUMP_BUFFER  = 8;          // frames early jump press is remembered

// Shooting
const SHOOT_CD     = 18;         // frames between shots
const SHOOT_ANIM   = 16;         // frames the shoot animation plays
const BULLET_SPEED = 10;

// Sprite display size (28px native × 2 = 56px)
const SPR = 28;
const DISP = SPR * 2;            // 56

// Squash & stretch
const SQUASH_RECOVERY = 0.2;     // lerp rate back to neutral each frame

// ─────────────────────────────────────────────────────────────────────────────
// LEVEL
// ─────────────────────────────────────────────────────────────────────────────
// Each platform: { x, y, w, h }
// Ground is thick (h>20). Floating platforms are thin (h=16).
//
// Jump-clearance constraint (JUMP_VEL=-11.5, GRAVITY=0.5, player.h=56):
//   After 1 jump frame: player.y = groundY + JUMP_VEL + GRAVITY = groundY - 11
//   Platform bottom must be < (player.y - 11) so no head-bump on first frame.
//
//   Ground  (player.y=334): first jump y=323 → low  platforms need bottom < 323 (y < 307) ✓
//   Low     (player.y=234): first jump y=223 → mid  platforms need bottom < 223 (y < 207) ✓
//   Mid     (player.y=134): first jump y=123 → high platforms need bottom < 123 (y < 107) ✓
//
//   Max jump height ≈ 138px. Tier spacing = 100px → reachable with ~10-frame hold. ✓
const PLATFORMS = [
  { x: 0,   y: 390, w: W,   h: 60  },  // Ground  (surface y=390, player.y=334)
  { x: 60,  y: 290, w: 148, h: 16  },  // Low-Left   (bottom=306 < 323 ✓)
  { x: 310, y: 290, w: 130, h: 16  },  // Low-Center
  { x: 580, y: 290, w: 148, h: 16  },  // Low-Right
  { x: 170, y: 190, w: 100, h: 16  },  // Mid-Left   (bottom=206 < 223 ✓)
  { x: 430, y: 190, w: 110, h: 16  },  // Mid-Right
  { x: 80,  y: 100, w: 110, h: 16  },  // High-Left  (bottom=116 < 123 ✓)
  { x: 560, y: 100, w: 130, h: 16  },  // High-Right
];

// ─────────────────────────────────────────────────────────────────────────────
// ASSETS
// ─────────────────────────────────────────────────────────────────────────────
const IMGS = {};
const ASSET_PATHS = {
  bg:    'assets/bg.png',
  idle:  'assets/idle.png',
  run1:  'assets/run1.png',
  run2:  'assets/run2.png',
  run3:  'assets/run3.png',
  run4:  'assets/run4.png',
  jump:  'assets/jump.png',
  shoot: 'assets/shoot.png',
  ps1:   'assets/player-shoot1.png',
  ps2:   'assets/player-shoot2.png',
  ps3:   'assets/player-shoot3.png',
  ps4:   'assets/player-shoot4.png',
  shot:  'assets/shot.png',
};

function loadAssets(onDone) {
  let left = Object.keys(ASSET_PATHS).length;
  for (const [key, src] of Object.entries(ASSET_PATHS)) {
    const img = new Image();
    img.onload  = () => { IMGS[key] = img; if (--left === 0) onDone(); };
    img.onerror = () => { console.warn('Could not load:', src); if (--left === 0) onDone(); };
    img.src = src;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// INPUT
// ─────────────────────────────────────────────────────────────────────────────
const KEYS = {}, PREV = {};
const held = k => !!KEYS[k];
const just = k => !!(KEYS[k] && !PREV[k]);

const isLeft    = () => held('ArrowLeft')  || held('a') || held('A');
const isRight   = () => held('ArrowRight') || held('d') || held('D');
const isJump    = () => held('ArrowUp')    || held('z') || held('Z') || held(' ');
const jumpJust  = () => just('ArrowUp')    || just('z') || just('Z') || just(' ');
const shootJust = () => just('x') || just('X');

function initInput() {
  const PREVENT = new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ']);
  window.addEventListener('keydown', e => {
    if (PREVENT.has(e.key)) e.preventDefault();
    KEYS[e.key] = true;
  });
  window.addEventListener('keyup', e => { KEYS[e.key] = false; });
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────
// Each animation: array of image keys + frames-per-sprite
const ANIMS = {
  idle:      { frames: ['idle'],               fps: 60 },
  run:       { frames: ['run1','run2','run3','run4'], fps: 6  },
  jump:      { frames: ['jump'],               fps: 60 },
  shoot:     { frames: ['shoot'],                    fps: 60 },
  runshoot:  { frames: ['ps1','ps2','ps3','ps4'],    fps: 4  },
  jumpshoot: { frames: ['ps1','ps2','ps3','ps4'],    fps: 4  },
};

// ─────────────────────────────────────────────────────────────────────────────
// PLAYER
// ─────────────────────────────────────────────────────────────────────────────
let P;

function resetPlayer() {
  P = {
    x: 60, y: 334,   // start on ground (390 - 56 = 334)
    w: DISP, h: DISP,
    vx: 0, vy: 0,
    right: true,
    onGround: true,
    coyote:  0,       // coyote-time countdown
    jbuf:    0,       // jump-buffer countdown
    wasJumpHeld: false,
    scd:     0,       // shoot cooldown
    sanim:   0,       // shoot anim timer
    anim:    'idle',
    aframe:  0,
    atimer:  0,
    sqX:     1,       // squash & stretch x scale
    sqY:     1,       // squash & stretch y scale
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CAMERA
// Ported from gamefeel reference: camBumpXY and camShakesXY
// bump() → directional displacement with friction decay (like gamefeel Camera.bump)
// shakeS() → timed oscillating shake (like gamefeel Camera.shakeS)
// ─────────────────────────────────────────────────────────────────────────────
const CAM = {
  bumpX:        0,
  bumpY:        0,
  bumpFrict:    0.85,   // per-frame friction (matches gamefeel bumpFrict)
  shakeTimer:   0,      // frames remaining
  shakeDuration:0,      // total duration (for ratio calculation)
  shakePower:   1.0,
  frameCount:   0,
};

// Directional camera displacement (canvas-space pixels).
// Positive x = scene shifts right = camera kicks left.
// Positive y = scene shifts down  = camera kicks up.
function camBump(x, y) {
  CAM.bumpX += x;
  CAM.bumpY += y;
}

// Timed oscillating shake. frames = duration, power = amplitude multiplier.
// Like gamefeel Camera.shakeS: does NOT override a longer running shake.
function camShake(frames, power) {
  if (frames > CAM.shakeTimer) {
    CAM.shakeTimer    = frames;
    CAM.shakeDuration = frames;
    CAM.shakePower    = power;    // reset power when taking the longer shake
  } else {
    CAM.shakePower = Math.max(CAM.shakePower, power);
  }
}

function updateCamera() {
  CAM.bumpX *= CAM.bumpFrict;
  CAM.bumpY *= CAM.bumpFrict;
  if (CAM.shakeTimer > 0) CAM.shakeTimer--;
  CAM.frameCount++;
}

// Returns the total camera offset to apply via ctx.translate().
function getCameraOffset() {
  let ox = CAM.bumpX;
  let oy = CAM.bumpY;
  if (CAM.shakeTimer > 0) {
    const ratio = CAM.shakeTimer / CAM.shakeDuration;
    // Oscillation from gamefeel Camera.apply() — two independent frequencies
    ox += Math.cos(CAM.frameCount * 1.1) * 2.5 * CAM.shakePower * ratio;
    oy += Math.sin(0.3 + CAM.frameCount * 1.7) * 2.5 * CAM.shakePower * ratio;
  }
  return { x: Math.round(ox), y: Math.round(oy) };
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTICLES  (dust puffs + cartridge ejections)
// ─────────────────────────────────────────────────────────────────────────────
let particles = [];

// Dust cloud at player's feet on landing. pow = normalised impact 0–1.
// Based on gamefeel landSmoke: starts dim, no gravity, friction only, slight growth.
function spawnDust(cx, groundY, pow) {
  const count = Math.round(6 + 12 * pow);   // 6–18 particles
  for (let i = 0; i < count; i++) {
    const dir = i % 2 === 0 ? 1 : -1;       // strictly alternate L/R
    const startAlpha = (0.1 + Math.random() * 0.1) * Math.min(pow + 0.3, 1.0);
    particles.push({
      type:       'dust',
      x:          cx + Math.random() * 6 * dir,
      y:          groundY + (Math.random() * 2 - 1),
      vx:         dir * (0.1 + Math.random() * 0.9),
      vy:        -(0.1 + Math.random() * 0.4),        // gentle upward drift
      alpha:      startAlpha,
      alphaDecay: startAlpha / (18 + Math.random() * 36),  // fade over 18–54 frames
      size:       6 + Math.random() * 8,              // 6–14 px
      scaleMul:   1 + Math.random() * 0.003,          // grows slightly over time
      frict:      0.92 + Math.random() * 0.02,
    });
  }
}

// Brass cartridge ejected backward + upward from gun on each shot.
// Based on gamefeel cartridge: strong arc, directional spin, long visible life, low friction.
function spawnCartridge(x, y, dir) {
  particles.push({
    type:       'cartridge',
    x, y,
    vx:        -dir * (0.7 + Math.random() * 2.1),   // 0.7–2.8, eject backward
    vy:        -(3 + Math.random()),                  // –3 to –4, strong arc
    alpha:      1.0,
    alphaDecay: 1 / (300 + Math.random() * 180),     // 5–8 s at 60 fps
    rot:        Math.random() * Math.PI * 2,
    rotV:       dir * (0.1 + Math.random() * 0.1),   // spins consistently with eject dir
    frict:      0.96,
  });
}

function updateParticles() {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    if (p.type === 'dust') {
      p.vx *= p.frict;        // friction decelerates — no gravity (floats & fades)
      p.vy *= p.frict;
      p.size *= p.scaleMul;   // puff expands slightly
    }
    if (p.type === 'cartridge') {
      p.vy += 0.18;           // gravity only on cartridge
      p.vx *= p.frict;
      p.rot += p.rotV;
    }
    p.alpha -= p.alphaDecay;
  }
  particles = particles.filter(p => p.alpha > 0);
}

function drawParticles(ctx) {
  ctx.save();
  for (const p of particles) {
    ctx.globalAlpha = Math.max(0, p.alpha);
    if (p.type === 'dust') {
      ctx.fillStyle = '#e8ddd0';   // off-white
      ctx.fillRect(p.x - p.size * 0.5, p.y - p.size * 0.5, p.size, p.size);
    } else {
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = '#cc9933';   // brass body
      ctx.fillRect(-1.5, -3, 3, 6);
      ctx.fillStyle = '#ffdd66';   // shiny primer cap
      ctx.fillRect(-1.5, -3, 3, 2);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
  ctx.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// BULLETS
// ─────────────────────────────────────────────────────────────────────────────
let bullets = [];

function spawnBullet() {
  const bx = P.right ? P.x + P.w - 8 : P.x - 8;
  const by = P.y + 26;          // roughly gun height
  bullets.push({ x: bx, y: by, vx: (P.right ? 1 : -1) * BULLET_SPEED, alive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// COLLISION HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

// ─────────────────────────────────────────────────────────────────────────────
// UPDATE
// ─────────────────────────────────────────────────────────────────────────────
function updatePlayer() {
  const wasOnGround = P.onGround;
  P.onGround = false;

  // ── Horizontal input ──
  P.vx = 0;
  if (isLeft())  { P.vx = -WALK_SPEED; P.right = false; }
  if (isRight()) { P.vx =  WALK_SPEED; P.right = true;  }

  // ── Jump buffer ──
  if (jumpJust()) P.jbuf = JUMP_BUFFER;

  // ── Jump execution ──
  const canJump = wasOnGround || P.coyote > 0;
  if (P.jbuf > 0 && canJump) {
    P.vy          = JUMP_VEL;
    P.coyote      = 0;
    P.jbuf        = 0;
    P.wasJumpHeld = true;
    P.sqX = 0.55;   // stretch: narrow
    P.sqY = 1.6;    // stretch: tall
  }

  // ── Variable jump height: cut velocity when jump released mid-air ──
  if (P.wasJumpHeld && !isJump() && P.vy < 0) {
    P.vy *= JUMP_CUT;
    P.wasJumpHeld = false;
  }
  if (!isJump()) P.wasJumpHeld = false;

  // ── Shoot ──
  if (P.scd  > 0) P.scd--;
  if (P.sanim > 0) P.sanim--;
  if (shootJust() && P.scd === 0) {
    spawnBullet();
    P.scd  = SHOOT_CD;
    P.sanim = SHOOT_ANIM;
    P.sqX = 1.2;    // recoil squash: wide
    P.sqY = 0.9;    // recoil squash: short
    // camBumpXY: small kick opposite to shot direction (like gamefeel shoot: bump(-dir*3, 0))
    const shootDir = P.right ? 1 : -1;
    const running  = wasOnGround && P.vx !== 0;
    camBump(-shootDir * (running ? 5 : 3), running ? -2 : 0);
    // camShakesXY: boost when running so bump isn't masked by movement
    camShake(running ? 10 : 6, running ? 0.35 : 0.2);
    // Cartridge ejection — disabled for now
    // const cartX = P.x + (P.right ? P.w * 0.65 : P.w * 0.35);
    // spawnCartridge(cartX, P.y + 18, shootDir);
  }

  // ── Gravity ──
  P.vy = Math.min(P.vy + GRAVITY, MAX_FALL);

  // ── Move X → collide X (solid ground only) ──
  P.x += P.vx;
  for (const pl of PLATFORMS) {
    if (pl.h <= 20) continue;   // thin platforms are one-way; no side collision
    if (!overlap(P, pl)) continue;
    if (P.vx > 0) P.x = pl.x - P.w;
    else if (P.vx < 0) P.x = pl.x + pl.w;
    P.vx = 0;
  }

  // ── Move Y → collide Y ──
  const landVy = P.vy;  // capture before collision zeroes it
  P.y += P.vy;
  for (const pl of PLATFORMS) {
    if (!overlap(P, pl)) continue;
    if (P.vy >= 0) {
      // For thin (one-way) platforms: only land if the player's bottom was at or
      // above the platform surface before this frame's movement. This lets the
      // player pass fully up through the platform without getting snapped to the
      // top mid-pass when vy transitions to 0 at the apex.
      const prevBottom = (P.y + P.h) - P.vy;
      if (pl.h > 20 || prevBottom <= pl.y) {
        P.y = pl.y - P.h;
        P.vy = 0;
        P.onGround = true;
      }
    } else if (pl.h > 20) {
      // Rising into solid ground only → bump head
      P.y = pl.y + pl.h;
      P.vy = 0;
    }
    // Rising into thin platform → pass through (one-way)
  }

  // ── Landing squash + camera effects ──
  if (!wasOnGround && P.onGround) {
    const pow = Math.min(Math.abs(landVy) / MAX_FALL, 1);
    P.sqX = 1 + 0.4 * pow;           // wide
    P.sqY = Math.max(1 - 0.8 * pow, 0.1); // flat (clamped so it can't go negative)
    // Dust puff — even small landings get a little puff
    spawnDust(P.x + P.w / 2, P.y + P.h, pow);
    // camBumpXY / camShakesXY — only for meaningful falls (pow > 0.2 filters tiny hops)
    if (pow > 0.2) {
      camBump(0, 6 * pow);
      camShake(Math.round(24 * pow), 0.5 * pow);
    }
  }

  // ── Squash & stretch recovery ──
  P.sqX += (1 - P.sqX) * SQUASH_RECOVERY;
  P.sqY += (1 - P.sqY) * SQUASH_RECOVERY;

  // ── Coyote time ──
  if (wasOnGround && !P.onGround && P.vy > 0) P.coyote = COYOTE_TIME;
  if (P.onGround) P.coyote = 0;
  if (P.coyote > 0) P.coyote--;
  if (P.jbuf  > 0) P.jbuf--;

  // ── Screen bounds ──
  if (P.x < 0)         P.x = 0;
  if (P.x + P.w > W)   P.x = W - P.w;
  if (P.y > H + 80) {  // fell into pit → respawn
    P.x = 60; P.y = 334; P.vy = 0;
  }

  // ── Animation state machine ──
  const shooting = P.sanim > 0;
  const moving   = P.vx !== 0;
  const inAir    = !P.onGround;

  const newAnim =
    inAir    ? 'jump'
    : shooting ? (moving   ? 'runshoot'  : 'shoot')
    : moving   ? 'run'
    : 'idle';

  if (newAnim !== P.anim) {
    P.anim = newAnim; P.aframe = 0; P.atimer = 0;
  } else {
    P.atimer++;
    if (P.atimer >= ANIMS[P.anim].fps) {
      P.atimer = 0;
      P.aframe = (P.aframe + 1) % ANIMS[P.anim].frames.length;
    }
  }
}

function updateBullets() {
  for (const b of bullets) {
    b.x += b.vx;
    if (b.x < -20 || b.x > W + 20) { b.alive = false; continue; }
    for (const pl of PLATFORMS) {
      if (b.x < pl.x + pl.w && b.x + 16 > pl.x &&
          b.y < pl.y + pl.h && b.y + 8  > pl.y) {
        b.alive = false; break;
      }
    }
  }
  bullets = bullets.filter(b => b.alive);
}

// ─────────────────────────────────────────────────────────────────────────────
// RENDER
// ─────────────────────────────────────────────────────────────────────────────
function drawBG(ctx) {
  const bg = IMGS.bg;
  if (!bg) {
    // Fallback gradient matching bay-area palette
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0,   '#cc3322');
    grad.addColorStop(0.5, '#dd5533');
    grad.addColorStop(1,   '#440033');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);
    return;
  }
  ctx.imageSmoothingEnabled = false;
  // bg is 144×240 → draw at 2× = 288×480, tiled horizontally, bottom-aligned
  const bw = bg.width  * 2;  // 288
  const bh = bg.height * 2;  // 480
  const by = H - bh;          // -30  (crop top 30px — shows sky + water nicely)
  for (let x = 0; x < W + bw; x += bw) {
    ctx.drawImage(bg, x, by, bw, bh);
  }
}

function drawPlatform(ctx, pl) {
  const ground = pl.h > 20;

  if (ground) {
    // Solid base
    ctx.fillStyle = '#1e0730';
    ctx.fillRect(pl.x, pl.y, pl.w, pl.h);
    // Surface band
    ctx.fillStyle = '#7744bb';
    ctx.fillRect(pl.x, pl.y, pl.w, 6);
    // Bright highlight strip
    ctx.fillStyle = '#cc88ff';
    ctx.fillRect(pl.x, pl.y, pl.w, 2);
    // Orange rivets
    ctx.fillStyle = '#ff9944';
    for (let x = pl.x + 8; x < pl.x + pl.w - 4; x += 48) {
      ctx.fillRect(x,      pl.y + 2, 4, 2);
      ctx.fillRect(x + 24, pl.y + 2, 4, 2);
    }
  } else {
    // Dark body with grill slots
    ctx.fillStyle = '#1a0528';
    ctx.fillRect(pl.x, pl.y + 4, pl.w, pl.h - 4);
    for (let x = pl.x; x < pl.x + pl.w; x += 6) {
      ctx.fillStyle = '#2e0845';
      ctx.fillRect(x, pl.y + 6, 3, pl.h - 7);
    }
    // Rail surface
    ctx.fillStyle = '#8855cc';
    ctx.fillRect(pl.x, pl.y, pl.w, 4);
    // Top highlight
    ctx.fillStyle = '#ddaaff';
    ctx.fillRect(pl.x, pl.y, pl.w, 1);
    // Orange bolt caps
    ctx.fillStyle = '#ff8833';
    for (let x = pl.x + 5; x < pl.x + pl.w - 2; x += 16) {
      ctx.fillRect(x, pl.y + 1, 3, 2);
    }
  }
}

function drawBullets(ctx) {
  ctx.imageSmoothingEnabled = false;
  const shotImg = IMGS.shot;
  for (const b of bullets) {
    if (shotImg && shotImg.width > 1) {
      // Draw sprite
      ctx.drawImage(shotImg, b.x, b.y, 16, 8);
    }
    // Always draw a bright core on top for visibility
    ctx.fillStyle = '#ffee44';
    ctx.fillRect(b.x + 2, b.y + 2, 10, 4);
    // Leading glow dot
    const dx = b.vx > 0 ? b.x + 12 : b.x;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(dx, b.y + 3, 4, 2);
  }
}

function drawPlayer(ctx) {
  const def = ANIMS[P.anim];
  const key = def.frames[P.aframe];
  const img = IMGS[key];

  ctx.imageSmoothingEnabled = false;
  ctx.save();

  // Anchor squash/stretch to bottom-center so the feet stay planted
  const cx  = P.x + P.w / 2;
  const by  = P.y + P.h;
  const dir = P.right ? 1 : -1;

  ctx.translate(cx, by);
  ctx.scale(P.sqX * dir, P.sqY);
  ctx.translate(-P.w / 2, -P.h);

  if (img) ctx.drawImage(img, 0, 0, P.w, P.h);
  else { ctx.fillStyle = '#ff5555'; ctx.fillRect(0, 0, P.w, P.h); }

  ctx.restore();
}

function drawHUD(ctx) {
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(0, H - 20, W, 20);
  ctx.fillStyle = '#aaaacc';
  ctx.font = '11px monospace';
  ctx.fillText('← → Move   ↑ / Z / Space  Jump   X  Shoot', 12, H - 6);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
function loop(ctx) {
  // Update
  updatePlayer();
  updateBullets();
  updateParticles();
  updateCamera();

  // Render — world drawn under camera offset, HUD drawn on top without offset
  ctx.clearRect(0, 0, W, H);
  const { x: camX, y: camY } = getCameraOffset();
  ctx.save();
  ctx.translate(camX, camY);
  drawBG(ctx);
  for (const pl of PLATFORMS) drawPlatform(ctx, pl);
  drawBullets(ctx);
  drawPlayer(ctx);
  drawParticles(ctx);
  ctx.restore();
  drawHUD(ctx);

  // Snapshot keys for next frame
  Object.assign(PREV, KEYS);

  requestAnimationFrame(() => loop(ctx));
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────
window.addEventListener('load', () => {
  const canvas = document.getElementById('game');
  const ctx    = canvas.getContext('2d');

  initInput();
  resetPlayer();

  loadAssets(() => {
    loop(ctx);
  });
});
