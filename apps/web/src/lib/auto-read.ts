export const AUTO_READ_DELAY_MS = 850;

type Timer = ReturnType<typeof setTimeout>;

/** Keeps the dwell time tied to visible, loaded content rather than route prefetches. */
export function createAutoReadGate(
  markRead: () => Promise<void>,
  onError: (error: unknown) => void,
  delay = AUTO_READ_DELAY_MS,
  schedule: (callback: () => void, milliseconds: number) => Timer = setTimeout,
  cancel: (timer: Timer) => void = clearTimeout,
) {
  let ready = false;
  let visible = false;
  let attempted = false;
  let disposed = false;
  let timer: Timer | null = null;

  function update() {
    if (timer !== null) { cancel(timer); timer = null; }
    if (disposed || attempted || !ready || !visible) return;
    timer = schedule(() => {
      timer = null;
      if (disposed || attempted || !ready || !visible) return;
      attempted = true;
      void markRead().catch(error => { if (!disposed) onError(error); });
    }, delay);
  }

  return {
    setReady(value: boolean) { if (ready !== value) { ready = value; update(); } },
    setVisible(value: boolean) { if (visible !== value) { visible = value; update(); } },
    dispose() { disposed = true; update(); },
    get attempted() { return attempted; },
  };
}
