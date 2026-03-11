// Session timer — tracks elapsed time excluding tab-hidden periods
// Pauses on visibility change, resumes on visible

let startTime = 0;
let accumulatedTime = 0;
let running = false;
let hiddenAt = 0;
let timeMultiplier = 1;
let lastMultiplierCheck = 0;

export function startSessionTimer() {
  startTime = performance.now();
  accumulatedTime = 0;
  running = true;

  document.addEventListener('visibilitychange', onVisibilityChange);
}

export function resetSessionTimer() {
  startTime = performance.now();
  accumulatedTime = 0;
  running = true;
}

function onVisibilityChange() {
  if (!running) return;

  if (document.hidden) {
    // Tab hidden — save accumulated time so far
    hiddenAt = performance.now();
    accumulatedTime += (hiddenAt - startTime) / 1000;
  } else {
    // Tab visible — reset start time
    startTime = performance.now();
  }
}

/** Set time multiplier — hold T to accelerate drying */
export function setTimeMultiplier(mult: number) {
  if (!running) return;
  // Bank accumulated time at old rate before changing multiplier
  if (!document.hidden) {
    const now = performance.now();
    accumulatedTime += ((now - startTime) / 1000) * timeMultiplier;
    startTime = now;
  }
  timeMultiplier = mult;
}

/** Returns session time in seconds, excluding tab-hidden periods */
export function getSessionTime(): number {
  if (!running) return 0;

  if (document.hidden) {
    return accumulatedTime;
  }
  return accumulatedTime + ((performance.now() - startTime) / 1000) * timeMultiplier;
}
