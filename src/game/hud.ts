/**
 * The moving parts of the HUD that drive.astro lays out: the two numbers that follow the car, the
 * buttons, and the fade that covers a reset and a camera switch.
 *
 * The other two chips are not written here. Sites and secrets belong to the module that keeps
 * that progress, and it writes them when they change.
 */
import type { ModuleFactory } from './types';

/** The markup is drive.astro's, so an element that is missing is a mistake there. */
function find(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`hud: drive.astro has no ${selector}`);
  return element;
}

/**
 * A number in a chip. Its text node is kept and written only when the number changes: a write
 * every frame restyles the chip 144 times a second to say the same thing.
 */
function readout(selector: string): (value: number) => void {
  const text = new Text('0');
  find(selector).replaceChildren(text);
  let shown = 0;
  return (value) => {
    if (value === shown) return;
    shown = value;
    text.data = String(value);
  };
}

export const createHud: ModuleFactory = ({ car, props, events, store }) => {
  const speed = readout('[data-speed]');
  // The count alone: a prop that was rebuilt can be knocked again, so it can pass the total.
  const score = readout('[data-score]');

  // The reset and the view switch both land at the black middle of this, 0.15 s in.
  const fade = find('[data-fade]');
  const blink = () => {
    fade.animate([{ opacity: 0 }, { opacity: 1 }, { opacity: 0 }], 300);
  };
  events.on('reset', blink);
  events.on('camera', blink);

  find('[data-reset]').addEventListener('click', () => events.emit('reset', null));
  find('[data-camera]').addEventListener('click', () => events.emit('camera'));

  // One on the intro and one in the HUD. They only flip the flag: the audio module follows it.
  const sounds = document.querySelectorAll<HTMLElement>('[data-sound]');
  const relabel = () => {
    for (const button of sounds) {
      button.textContent = store.saved.muted ? 'Sound off' : 'Sound on';
      button.setAttribute('aria-pressed', String(!store.saved.muted));
    }
  };
  for (const button of sounds) {
    button.addEventListener('click', () => {
      store.saved.muted = !store.saved.muted;
      store.save();
      relabel();
    });
  }
  relabel();

  return {
    update() {
      speed(Math.round(car.speed * 3.6));
      score(props.knocked);
    },
  };
};
