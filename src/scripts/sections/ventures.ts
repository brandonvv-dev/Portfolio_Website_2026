import { MQ } from '../kit';
import type { MotionCtx } from '../kit';

/** The demo loop plays while at least half of it is on screen and pauses when it leaves. */
export default function init({ mm }: MotionCtx): void {
  const video = document.querySelector<HTMLVideoElement>('#ventures video');
  if (!video) return;

  // Reduced motion never reaches this callback, so the poster and the controls are all it gets
  mm.add(MQ.ok, () => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            void video.play().catch(() => video.setAttribute('controls', ''));
          } else {
            video.pause();
          }
        }
      },
      { threshold: 0.5 },
    );
    observer.observe(video);

    return () => {
      observer.disconnect();
      video.pause();
    };
  });
}
