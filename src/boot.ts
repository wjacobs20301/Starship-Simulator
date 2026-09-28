// The page's entry point: checks that this device can run the simulator before loading it (the
// game itself is loaded only then). A computer with a keyboard and WebGL 2 is required; phones and
// tablets get a message instead. A few things that would make it run badly (a tiny window,
// software rendering) get a warning the player can click past.

interface Problem {
  title: string;
  text: string;
  /** false: can't run at all; true: may run badly (the player can carry on). */
  soft: boolean;
}

function problems(): Problem[] {
  const out: Problem[] = [];
  // Touch-only: a phone or tablet (no mouse or trackpad). A tablet with a trackpad counts as a computer.
  const touchOnly = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  if (touchOnly) {
    out.push({
      title: 'Computer required',
      text: 'Starship Flight Simulator is flown with a keyboard and mouse. Open this page on a desktop or laptop computer.',
      soft: false,
    });
    return out;
  }
  const gl = document.createElement('canvas').getContext('webgl2');
  if (!gl) {
    out.push({
      title: 'Your browser can’t run this',
      text:
        'The simulator needs WebGL 2 (3D graphics in the browser). Try an up-to-date Chrome, Edge, Firefox or Safari, and ' +
        'check that hardware acceleration is turned on in the browser’s settings.',
      soft: false,
    });
    return out;
  }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  if (/swiftshader|llvmpipe|software|basic render/i.test(renderer)) {
    out.push({
      title: 'Hardware acceleration is off',
      text:
        'Your browser is drawing 3D graphics without the graphics card, so the simulator will run very slowly. Turn on ' +
        'hardware acceleration in the browser’s settings (and restart it) for a smooth flight.',
      soft: true,
    });
  }
  if (innerWidth < 900 || innerHeight < 560) {
    out.push({
      title: 'Small window',
      text: 'The simulator’s displays need room: make the browser window larger (or go full screen with F once it loads).',
      soft: true,
    });
  }
  return out;
}

function show(list: Problem[]): Promise<void> {
  const hard = list.some((p) => !p.soft);
  const box = document.createElement('div');
  box.id = 'compat';
  // Behind the message, a short silent loop of the game (liftoff, the booster and the ship caught
  // by the tower): only loaded when this screen shows, ~2 MB. Muted and inline, so phones autoplay
  // it; where they won't (e.g. low-power mode), its poster frame stays up.
  box.innerHTML =
    `<video class="cp-bg" src="/media/bg-loop.mp4" poster="/media/bg-poster.jpg" autoplay muted loop playsinline ` +
    `disablepictureinpicture aria-hidden="true"></video><div class="cp-shade"></div><div class="cp-body">` +
    `<div class="cp-name">STARSHIP</div><div class="cp-sub">FLIGHT SIMULATOR</div>` +
    list.map((p) => `<div class="cp-item"><div class="cp-title">${p.title}</div><p>${p.text}</p></div>`).join('') +
    (hard ? '' : `<button class="cp-go">Continue anyway</button>`) +
    `</div>`;
  document.body.appendChild(box);
  // (Blocked: the loading screen goes. Otherwise it waits underneath for "Continue anyway".)
  if (hard) document.querySelector('#loading')?.remove();
  return new Promise((resolve) => {
    box.querySelector('.cp-go')?.addEventListener('click', () => {
      box.querySelector('video')?.pause();
      box.remove();
      resolve();
    });
  });
}

const found = problems();
if (found.length) {
  const blocked = found.some((p) => !p.soft);
  const go = show(found);
  if (!blocked) go.then(() => import('./main'));
} else {
  import('./main');
}
