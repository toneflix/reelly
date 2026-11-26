// Lumen demo product: a tiny notes app used to try /reel.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function route() {
  const name = (location.hash.replace(/^#\/?/, '').split('?')[0]) || 'home';
  $$('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + name));
  $$('nav a').forEach(a => a.classList.toggle('on', a.dataset.route === name));
  if (name === 'insights') startInsights();
}
window.addEventListener('hashchange', route);

// Cookie banner
$('#cookie-banner button').onclick = () => $('#cookie-banner').remove();

// Editor: typing into the doc reveals linked ideas.
const body = $('#doc-body');
const line = $('#typing-line');
body.addEventListener('input', () => {
  if (line.textContent.trim().length > 8) $('#suggest').classList.add('on');
});
body.addEventListener('focus', () => {
  // place caret at end of the typing line
  const r = document.createRange(); r.selectNodeContents(line); r.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  line.classList.add('caret');
});
body.addEventListener('blur', () => line.classList.remove('caret'));
$('#new-page').onclick = () => {
  const a = document.createElement('a'); a.className = 'page'; a.textContent = '✨ Untitled';
  $('#new-page').before(a);
};
$$('.sidebar .page').forEach(p => p.addEventListener('click', () => {
  $$('.sidebar .page').forEach(q => q.classList.remove('active')); p.classList.add('active');
}));

// Board: pointer-driven drag and drop.
let drag = null;
document.addEventListener('pointerdown', e => {
  const card = e.target.closest('.card'); if (!card) return;
  const r = card.getBoundingClientRect();
  drag = { card, x: e.clientX, y: e.clientY, w: r.width };
  card.classList.add('lift');
  card.style.width = r.width + 'px';
  e.preventDefault();
});
document.addEventListener('pointermove', e => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.card.style.transform = `translate(${dx}px, ${dy}px) rotate(${Math.max(-4, Math.min(4, dx / 60))}deg)`;
  $$('.col').forEach(c => {
    const r = c.getBoundingClientRect();
    c.classList.toggle('over', e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom);
  });
});
document.addEventListener('pointerup', e => {
  if (!drag) return;
  const col = $$('.col').find(c => c.classList.contains('over'));
  const { card } = drag;
  card.classList.remove('lift'); card.style.transform = ''; card.style.width = '';
  if (col) { col.appendChild(card); card.classList.remove('land'); void card.offsetWidth; card.classList.add('land'); }
  $$('.col').forEach(c => c.classList.remove('over'));
  drag = null;
});

// Insights: animated counters (requestAnimationFrame) and bars (CSS transitions).
let insightsStarted = false;
function startInsights() {
  if (insightsStarted) return; insightsStarted = true;
  $$('.bar').forEach((b, i) => b.style.setProperty('--i', i));
  setTimeout(() => $('#chart').classList.add('on'), 200);
  const t0 = performance.now();
  const els = $$('.stat .v');
  (function tick(now) {
    const p = Math.min(1, (now - t0) / 1600), e = 1 - Math.pow(1 - p, 3);
    els.forEach(el => el.textContent = Math.round(e * +el.dataset.count).toLocaleString('en-US'));
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}

// Share dialog
$('#share-btn').onclick = () => $('#share-modal').classList.add('on');
$('#share-modal').addEventListener('click', e => { if (e.target.id === 'share-modal') e.currentTarget.classList.remove('on'); });
$('#public').addEventListener('change', e => $('#link').classList.toggle('on', e.target.checked));
$('#invite-send').onclick = () => {
  const v = $('#invite').value.trim(); if (!v) return;
  const p = document.createElement('div'); p.className = 'person new';
  const ini = v.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  p.innerHTML = `<div class="av a3">${ini}</div><div><b>${v}</b><span>Can edit</span></div>`;
  $('.people').appendChild(p);
  $('#invite').value = '';
  const t = $('#toast'); t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 1600);
};

route();
