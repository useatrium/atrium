export function createDraftChangeDebouncer(
  save: (key: string, text: string) => void,
  delayMs = 400,
) {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const clear = (key: string) => {
    const timer = timers.get(key);
    if (timer) clearTimeout(timer);
    timers.delete(key);
  };

  return {
    schedule(key: string, text: string) {
      clear(key);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          save(key, text);
        }, delayMs),
      );
    },
    saveNow(key: string, text: string) {
      clear(key);
      save(key, text);
    },
    cancel(key?: string) {
      if (key) {
        clear(key);
        return;
      }
      for (const draftKey of [...timers.keys()]) clear(draftKey);
    },
  };
}
