// Reference-counted leases prevent one finished task from unlocking another task.
const activities = new Set(), listeners = new Set();
export const isUpdateBusy = () => activities.size > 0;
function changed() { for (const listener of listeners) listener(isUpdateBusy()); }
export function beginUpdateActivity() {
  const lease = Symbol('activity'), wasBusy = isUpdateBusy(); activities.add(lease);
  if (!wasBusy) changed();
  return () => { if (activities.delete(lease) && !isUpdateBusy()) changed(); };
}
export function subscribeUpdateBusy(listener) {
  listeners.add(listener); listener(isUpdateBusy());
  return () => listeners.delete(listener);
}
