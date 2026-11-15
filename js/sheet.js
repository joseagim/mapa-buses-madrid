// Panel: plegado y, en móvil, hoja inferior de tres alturas.

import { $, isMobile } from './dom.js';

// En móvil el panel es una hoja inferior con tres alturas: plegada (solo la
// cabecera), media pantalla y casi pantalla completa. Se cambia pulsando la
// cabecera o arrastrándola con el dedo. En escritorio solo hay plegado o no.
const SHEET_STATES = ['collapsed', 'half', 'full'];

export const sheetState = () => $('#panel').dataset.sheet || 'half';

/** Alto en píxeles de cada estado de la hoja (los mismos valores que en el CSS). */
export function sheetHeights() {
  const vh = window.innerHeight;
  return { collapsed: $('#panel-head').offsetHeight, half: Math.round(vh * 0.5), full: Math.round(vh * 0.9) };
}

export function setSheet(next) {
  const panel = $('#panel');
  panel.dataset.sheet = next;
  panel.classList.toggle('collapsed', next === 'collapsed');
  panel.style.height = '';
  $('#panel-toggle').setAttribute('aria-expanded', String(next !== 'collapsed'));
}

/** Pliega el panel o, si estaba plegado, lo abre (en móvil, a media pantalla). */
export function setPanelCollapsed(collapsed) {
  if (collapsed) setSheet('collapsed');
  else if (sheetState() === 'collapsed') setSheet('half');
}

export function setupSheet() {
  const panel = $('#panel');
  const handle = $('#panel-toggle');
  let drag = null;
  let dragged = false; // el clic que sigue a un arrastre no cuenta como pulsación

  handle.addEventListener('click', () => {
    if (dragged) return;
    const now = sheetState();
    if (isMobile()) setSheet(SHEET_STATES[(SHEET_STATES.indexOf(now) + 1) % SHEET_STATES.length]);
    else setSheet(now === 'collapsed' ? 'half' : 'collapsed');
  });

  handle.addEventListener('pointerdown', (e) => {
    if (!isMobile() || (e.pointerType === 'mouse' && e.button !== 0)) return;
    dragged = false;
    // Con ratón no hay captura implícita: sin esto, al salir el cursor de la
    // cabecera dejarían de llegar los movimientos.
    try { handle.setPointerCapture(e.pointerId); } catch { /* puntero ya soltado */ }
    drag = {
      id: e.pointerId, y0: e.clientY, h0: panel.getBoundingClientRect().height,
      moved: false, lastY: e.clientY, lastT: e.timeStamp, speed: 0,
    };
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved) {
      if (Math.abs(dy) < 8) return; // todavía puede ser una pulsación
      drag.moved = true;
      panel.classList.add('dragging');
      panel.classList.remove('collapsed'); // que se vea el contenido mientras sube
    }
    const dt = e.timeStamp - drag.lastT;
    if (dt > 0) drag.speed = 0.7 * ((e.clientY - drag.lastY) / dt) + 0.3 * drag.speed; // px/ms, hacia abajo
    drag.lastY = e.clientY;
    drag.lastT = e.timeStamp;
    const { collapsed, full } = sheetHeights();
    panel.style.height = `${Math.max(collapsed, Math.min(full + 16, drag.h0 - dy))}px`;
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const { moved } = drag;
    const speed = e.timeStamp - drag.lastT > 120 ? 0 : drag.speed; // parado antes de soltar
    drag = null;
    if (!moved) return;
    dragged = true;
    setTimeout(() => { dragged = false; }, 400);
    panel.classList.remove('dragging');
    // Al soltar: si el dedo iba rápido (un «empujón»), a la siguiente altura
    // en ese sentido; si no, a la más cercana a donde se ha dejado.
    const height = panel.getBoundingClientRect().height;
    const heights = sheetHeights();
    let options = SHEET_STATES;
    if (Math.abs(speed) > 0.45) {
      const flick = SHEET_STATES.filter((st) => (speed < 0 ? heights[st] > height : heights[st] < height));
      if (flick.length) options = flick;
    }
    setSheet(options.reduce((a, b) => (
      Math.abs(heights[b] - height) < Math.abs(heights[a] - height) ? b : a)));
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}
