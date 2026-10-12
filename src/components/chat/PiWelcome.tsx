import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { t } from '../../i18n/zh';
import { createPiLogoAnimation, type PiLogoAnimation } from '../../lib/pi-logo-animation';

function LogoAnimation({
  logoRef,
  onFinish
}: {
  logoRef: RefObject<SVGSVGElement>;
  onFinish: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const animationRef = useRef<PiLogoAnimation | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const logo = logoRef.current;
    if (!canvas || !logo) return;
    const animation = createPiLogoAnimation(canvas, logo, onFinish);
    animationRef.current = animation;
    buttonRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      animation.close();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      animation.dispose();
      animationRef.current = null;
    };
  }, [logoRef, onFinish]);

  return (
    <button
      ref={buttonRef}
      type="button"
      className="absolute inset-0 z-10 h-full w-full overflow-hidden rounded outline-none"
      aria-label={t.piLogoAnimationClose}
      onClick={() => animationRef.current?.close()}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-hidden="true" />
      <span className="pointer-events-none absolute inset-x-0 bottom-4 text-center text-xs text-od-text-dim">
        {t.piLogoAnimationHint}
      </span>
    </button>
  );
}

/** The easter egg owns its state and frame loop, independently of the message list. */
export default function PiWelcome() {
  const [playing, setPlaying] = useState(false);
  const logoRef = useRef<SVGSVGElement>(null);
  const wasPlaying = useRef(false);
  const finish = useCallback(() => setPlaying(false), []);

  useEffect(() => {
    if (!playing && wasPlaying.current) logoRef.current?.focus({ preventScroll: true });
    wasPlaying.current = playing;
  }, [playing]);

  return (
    <div className="relative flex h-full flex-col items-center justify-center text-od-text-dim">
      <svg
        ref={logoRef}
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 800 800"
        role="button"
        onClick={() => setPlaying(true)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setPlaying(true);
          }
        }}
        className={`h-36 w-36 cursor-pointer outline-none ${playing ? 'invisible' : ''}`}
        aria-label={t.piLogoAnimationPlay}
        aria-hidden={playing}
        tabIndex={playing ? -1 : 0}
      >
        <path fill="#F09082" d="M165.29 165.29H517.36V400H400V282.65H165.29Z" />
        <path fill="#4D9ABF" d="M165.29 282.65H282.65V400H400V517.36H282.65V634.72H165.29Z" />
        <path fill="#F1BE58" d="M517.36 400H634.72V634.72H517.36Z" />
      </svg>
      <div className="text-center" aria-hidden={playing}>
        <p className="text-lg text-od-text-bright">{t.welcomeTitle}</p>
        <p className="mt-1 text-sm">{t.welcomeHint}</p>
      </div>
      {playing && <LogoAnimation logoRef={logoRef} onFinish={finish} />}
    </div>
  );
}
