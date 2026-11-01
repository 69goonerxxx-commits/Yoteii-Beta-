// WAVE: the liquid fill inside the dot of the task that is running now.
// The coloured part sits at the top and grows downward as the task goes on. Two wave paths are redrawn ~22 times a second,
// only while a running task is on screen. With "reduce motion" on, the wave is drawn once and stays still.
const W = 56;
let running = false, last = 0;
function pathFor(lvl, ph, amp){
  let d = 'M0 0 L0 ' + (lvl + amp * Math.sin(ph)).toFixed(2);
  for (let x = 0; x <= W; x += 2) d += ' L' + x + ' ' + (lvl + amp * Math.sin(ph + x / W * Math.PI * 2)).toFixed(2);
  return d + ' L' + W + ' 0 Z';
}
export function paintWaves(t){
  const all = document.querySelectorAll('.dotWv');
  all.forEach(s => {
    const h = Number(s.dataset.h), f = Number(s.dataset.f), lvl = h * f;
    const a = s.querySelector('.wF'), b = s.querySelector('.wB');
    if (a) a.setAttribute('d', pathFor(lvl, t, 2.4));
    if (b) b.setAttribute('d', pathFor(lvl, t + 1.9, 3));
  });
  return all.length;
}
export function startWaves(){
  const n = paintWaves(0);
  if (!n || running) return;
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  running = true;
  const tick = ts => {
    if (ts - last > 45){ last = ts; if (!document.hidden && paintWaves(ts / 450) === 0){ running = false; return; } }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
