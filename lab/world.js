// Walk-through world engine (Ojeda Works, 2026-10-24). Used by aoaudit.com/lab/ and myownhit.com/studio/.
// A world = stations around a round room. Walk with keys, tap the floor, or use "Next stop".
// Each world passes: { stations:[{key,kick,name,desc,facts,link,linkText,color,angle,build(THREE,group,h)}], room:{...}, scene(THREE,scene,h) }
(function () {
  window.startWorld = function (W) {
    const canvas = document.getElementById('scene');
    const card = document.getElementById('card'), hint = document.getElementById('hint');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!window.THREE) return fail();
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); } catch (e) { return fail(); }
    function fail() { document.getElementById('fallback').hidden = false; hint.hidden = true; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, innerWidth < 840 ? 1.5 : 2));
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(52, 1, 0.1, 300);
    const R = W.room.radius;
    const solids = [], clickables = [], spinners = [], signs = [];

    // helpers handed to world builders
    const mat = (c, o) => new THREE.MeshStandardMaterial(Object.assign({ color: c, roughness: 0.75, metalness: 0.05 }, o || {}));
    const add = (m, parent) => { m.castShadow = true; m.receiveShadow = true; (parent || scene).add(m); return m; };
    const h = {
      mat,
      box: (w, hh, d, c, x, y, z, parent, o) => { const m = add(new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat(c, o)), parent); m.position.set(x, y, z); return m; },
      cyl: (rt, rb, hh, c, x, y, z, parent, seg, o) => { const m = add(new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, hh, seg || 24), mat(c, o)), parent); m.position.set(x, y, z); return m; },
      sphere: (r, c, x, y, z, parent, o) => { const m = add(new THREE.Mesh(new THREE.SphereGeometry(r, 24, 16), mat(c, o)), parent); m.position.set(x, y, z); return m; },
      torus: (r, t, c, x, y, z, parent, o) => { const m = add(new THREE.Mesh(new THREE.TorusGeometry(r, t, 12, 48), mat(c, o)), parent); m.position.set(x, y, z); return m; },
      spin: (obj, speed, axis) => spinners.push({ obj, speed, axis: axis || 'y' }),
      sign: (lines, bg, fg, pw, ph, parent, x, y, z, font) => {
        const H = Math.round(1024 * ph / pw);
        const draw = () => {
          const c = document.createElement('canvas'); c.width = 1024; c.height = H; const g = c.getContext('2d');
          g.fillStyle = bg; g.fillRect(0, 0, 1024, H); g.textAlign = 'center'; g.textBaseline = 'middle';
          lines.forEach((l) => { let s = l.size; const f = () => `${l.w || 700} ${s}px ${font || W.signFont}`; g.font = f(); while (g.measureText(l.t).width > 1024 * 0.9 && s > 10) { s -= 2; g.font = f(); } g.fillStyle = l.c || fg; g.fillText(l.t, 512, l.y * H); });
          const t = new THREE.CanvasTexture(c); t.anisotropy = 4; return t;
        };
        const m = new THREE.Mesh(new THREE.PlaneGeometry(pw, ph), new THREE.MeshBasicMaterial({ map: draw(), transparent: bg === 'transparent' }));
        m.position.set(x, y, z); (parent || scene).add(m); signs.push({ m, draw }); return m;
      },
      solid: (x0, x1, z0, z1) => solids.push({ x0, x1, z0, z1 }),
      scene, THREE
    };

    // lights
    scene.add(new THREE.HemisphereLight(W.room.skyLight, W.room.groundLight, W.room.hemi));
    const sun = new THREE.DirectionalLight(0xffffff, W.room.sun);
    sun.position.set(-14, 26, 12); sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -R - 4, right: R + 4, top: R + 4, bottom: -R - 4, near: 1, far: 80 }); scene.add(sun);
    if (W.room.fog) scene.fog = new THREE.Fog(W.room.fog, R * 1.6, R * 4);

    // floor + wall ring
    const floor = add(new THREE.Mesh(new THREE.CircleGeometry(R + 0.5, 64), mat(W.room.floor, { roughness: W.room.floorRough || 0.8 })));
    floor.rotation.x = -Math.PI / 2; floor.name = 'floor';
    const wall = add(new THREE.Mesh(new THREE.CylinderGeometry(R + 0.6, R + 0.6, W.room.wallH, 72, 1, true), mat(W.room.wall, { side: THREE.BackSide })));
    wall.position.y = W.room.wallH / 2; wall.castShadow = false;
    if (W.scene) W.scene(THREE, scene, h);

    // stations: placed on a ring, facing the middle
    const stations = W.stations.map((s, i) => {
      const a = s.angle, ring = s.ring || R - 4.2;
      const g = new THREE.Group(); g.position.set(Math.sin(a) * ring, 0, -Math.cos(a) * ring); g.rotation.y = -a; scene.add(g);
      s.build(THREE, g, h);
      const stand = new THREE.Vector3(Math.sin(a) * (ring - 3.4), 0, -Math.cos(a) * (ring - 3.4));
      const fx = g.position.x, fz = g.position.z; h.solid(fx - 1.6, fx + 1.6, fz - 1.6, fz + 1.6);
      g.traverse((o) => { if (o.isMesh) { o.userData.station = i; clickables.push(o); } });
      return Object.assign({}, s, { group: g, stand, yaw: a });
    });

    // walker
    const me = new THREE.Group(); scene.add(me);
    const legs = [h.box(0.32, 0.7, 0.32, 0x0f1420, -0.2, 0.35, 0, me), h.box(0.32, 0.7, 0.32, 0x0f1420, 0.2, 0.35, 0, me)];
    h.box(0.95, 1.0, 0.6, W.walker.body, 0, 1.2, 0, me); h.box(0.75, 0.7, 0.65, 0xf2c9a0, 0, 2.05, 0, me);
    h.box(0.82, 0.22, 0.72, W.walker.cap, 0, 2.5, 0, me); h.box(0.8, 0.08, 0.35, W.walker.cap, 0, 2.42, 0.45, me);
    [-0.17, 0.17].forEach((x) => h.box(0.09, 0.12, 0.02, 0x0f1420, x, 2.1, 0.33, me));
    me.position.set(0, 0, R - 3.5); let heading = Math.PI; me.rotation.y = heading;

    const marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.65, 32), new THREE.MeshBasicMaterial({ color: W.walker.cap, transparent: true, opacity: 0.85 }));
    marker.rotation.x = -Math.PI / 2; marker.position.y = 0.05; marker.visible = false; scene.add(marker);

    // input
    const keys = {}, KEYMAP = { ArrowUp: 'f', KeyW: 'f', ArrowDown: 'b', KeyS: 'b', ArrowLeft: 'l', KeyA: 'l', ArrowRight: 'r', KeyD: 'r' };
    addEventListener('keydown', (e) => { if (KEYMAP[e.code]) { keys[KEYMAP[e.code]] = true; target = null; marker.visible = false; if (e.target === document.body || e.target === canvas) e.preventDefault(); } });
    addEventListener('keyup', (e) => { if (KEYMAP[e.code]) keys[KEYMAP[e.code]] = false; });
    addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
    let target = null, detour = null, sense = 0, tourIdx = -1;
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(); let downAt = null;
    canvas.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; canvas.focus({ preventScroll: true }); });
    canvas.addEventListener('pointerup', (e) => {
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 8) return;
      const r = canvas.getBoundingClientRect();
      ndc.set((e.clientX - r.left) / r.width * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); ray.setFromCamera(ndc, camera);
      const hs = ray.intersectObjects(clickables, false)[0]; if (hs) return goTo(hs.object.userData.station);
      const hf = ray.intersectObject(floor, false)[0]; if (hf) { sense = 0; target = hf.point.clone(); target.y = 0; marker.position.set(target.x, 0.05, target.z); marker.visible = true; }
    });
    function goTo(i) { tourIdx = i; sense = 0; target = stations[i].stand.clone(); marker.position.set(target.x, 0.05, target.z); marker.visible = true; }
    const nextBtn = document.getElementById('next');
    if (nextBtn) nextBtn.addEventListener('click', () => goTo((tourIdx + 1) % stations.length));

    function blocked(x, z) { return Math.hypot(x, z) > R - 1 || solids.some((s) => x > s.x0 && x < s.x1 && z > s.z0 && z < s.z1); }

    // station card
    let shown = -1;
    function showCard(i) {
      if (shown === i) return; shown = i;
      const about = document.getElementById('about'); if (about) about.hidden = i >= 0;
      if (i < 0) { card.hidden = true; hint.hidden = false; return; }
      const s = stations[i];
      card.style.setProperty('--c', s.color || W.accent);
      document.getElementById('cKick').textContent = s.kick;
      document.getElementById('cName').textContent = s.name;
      document.getElementById('cDesc').textContent = s.desc;
      document.getElementById('cFacts').innerHTML = (s.facts || []).map((f) => '<li>' + f.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</li>').join('');
      const a = document.getElementById('cLink');
      if (s.link) { a.hidden = false; a.href = s.link; a.textContent = s.linkText; } else a.hidden = true;
      card.hidden = false; hint.hidden = true;
      if (nextBtn) nextBtn.textContent = i === stations.length - 1 ? 'Start over' : 'Next stop';
    }

    // camera
    const camOff = new THREE.Vector3(0, 8.5, 11.5), look = new THREE.Vector3(), camPos = new THREE.Vector3();
    let camYaw = 0, near = -1;
    function placeCamera(snap) {
      const wantYaw = near >= 0 ? stations[near].yaw : camYaw;   // keep the view until the next stop
      let dy = wantYaw - camYaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); camYaw = snap ? wantYaw : camYaw + dy * 0.05;
      const up = new THREE.Vector3(0, 1, 0);
      const want = me.position.clone().add(camOff.clone().applyAxisAngle(up, -camYaw));
      if (snap) camPos.copy(want); else camPos.lerp(want, 0.08);
      camera.position.copy(camPos);
      const ahead = new THREE.Vector3(0, 0, -3).applyAxisAngle(up, -camYaw);
      look.set(me.position.x + ahead.x, 1.4, me.position.z + ahead.z); camera.lookAt(look);
    }
    function resize() { const w = innerWidth, hh = innerHeight; renderer.setSize(w, hh, false); camera.aspect = w / hh; camOff.set(0, w < hh ? 11 : 8.5, w < hh ? 16 : 11.5); camera.updateProjectionMatrix(); }
    addEventListener('resize', resize); resize(); placeCamera(true);

    const clock = new THREE.Clock(); let walkT = 0, t = 0;
    function frame() {
      const dt = Math.min(clock.getDelta(), 0.05); t += dt;
      let mx = 0, mz = 0;
      // keys move relative to the camera
      const kf = (keys.f ? 1 : 0) - (keys.b ? 1 : 0), kr = (keys.r ? 1 : 0) - (keys.l ? 1 : 0);
      if (kf || kr) { const c = Math.cos(camYaw), s = Math.sin(camYaw); mx = kr * c + kf * s; mz = kr * s - kf * c; }
      if (!mx && !mz && target) {
        const dx = target.x - me.position.x, dz = target.z - me.position.z, d = Math.hypot(dx, dz);
        if (d < 0.25) { target = null; marker.visible = false; sense = 0; if (tourIdx >= 0) heading = Math.PI - stations[tourIdx].yaw; }
        else { mx = dx / d; mz = dz / d; }
      }
      if (detour && target && !(kf || kr)) { detour.t -= dt; const ax = me.position.x + detour.x * 7 * dt, az = me.position.z + detour.z * 7 * dt; if (detour.t > 0 && !blocked(ax, az)) { mx = detour.x; mz = detour.z; } else detour = null; } else detour = null;
      const moving = mx || mz;
      if (moving) {
        const len = Math.hypot(mx, mz); mx /= len; mz /= len; const step = 7 * dt;
        const nx = me.position.x + mx * step, nz = me.position.z + mz * step;
        if (!blocked(nx, nz)) { me.position.x = nx; me.position.z = nz; }
        else if (Math.abs(mx) > 0.25 && !blocked(nx, me.position.z)) me.position.x = nx;
        else if (Math.abs(mz) > 0.25 && !blocked(me.position.x, nz)) me.position.z = nz;
        else {
          let sides = [[-mz, mx, 1], [mz, -mx, -1]];
          if (sense) sides.sort((a) => (a[2] === sense ? -1 : 1));
          else if (target) sides.sort((a, b) => Math.hypot(target.x - me.position.x - a[0], target.z - me.position.z - a[1]) - Math.hypot(target.x - me.position.x - b[0], target.z - me.position.z - b[1]));
          const side = sides.find(([sx, sz]) => !blocked(me.position.x + sx * step, me.position.z + sz * step));
          if (side) { detour = { x: side[0], z: side[1], t: 0.6 }; sense = side[2]; } else if (target) { target = null; marker.visible = false; }
        }
        heading = Math.atan2(mx, mz); walkT += dt * 10;
      }
      let d = heading - me.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); me.rotation.y += d * Math.min(1, dt * 12);
      const sw = moving ? Math.sin(walkT) * 0.5 : 0; legs[0].rotation.x = sw; legs[1].rotation.x = -sw;
      me.position.y = moving ? Math.abs(Math.sin(walkT)) * 0.12 : 0;
      if (!reduce) spinners.forEach((s) => { s.obj.rotation[s.axis] += dt * s.speed; });
      if (W.tick && !reduce) W.tick(t, dt);
      marker.material.opacity = 0.55 + Math.sin(t * 5) * 0.3;
      near = -1; let best = 3.2;
      stations.forEach((s, i) => { const dd = me.position.distanceTo(s.stand); if (dd < best) { best = dd; near = i; } });
      showCard(near);
      placeCamera(false); renderer.render(scene, camera); requestAnimationFrame(frame);
    }
    frame();
    if (document.fonts && document.fonts.load) document.fonts.load('700 100px ' + W.signFontName).then(() => signs.forEach((s) => { s.m.material.map.dispose(); s.m.material.map = s.draw(); s.m.material.needsUpdate = true; })).catch(() => {});
  };
})();
