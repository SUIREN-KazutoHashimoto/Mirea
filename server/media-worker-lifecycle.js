import {httpError} from './security.js';

const interrupted = () => Object.assign(httpError(503, 'メディア処理が中断されました。サーバーの稼働状態を確認してください。'), {code: 'MEDIA_WORKER_FAILED'});
const timedOut = () => Object.assign(httpError(422, '本・画像の処理が時間内に完了しませんでした。'), {code: 'MEDIA_PROCESSING_TIMEOUT'});

// A result message is not an exit notification: module evaluation and native
// decoder cleanup can still be running. Keep the job/source files reserved until
// exit, including when cancellation or the whole-operation deadline terminates it.
export function waitForMediaWorker(worker, {signal, timeoutMs = 30_000} = {}) {
  return new Promise((resolve, reject) => {
    let result, received = false, failure, failed = false, terminating = false, finished = false;
    const recordFailure = error => { if (!failed) { failed = true; failure = error; } };
    const terminate = error => {
      recordFailure(error);
      if (terminating || finished) return;
      terminating = true;
      // terminate() resolves after exit; consume its promise without an async
      // event listener. The exit listener below is the only completion path.
      void worker.terminate().catch(recordFailure);
    };
    const onMessage = value => { received = true; result = value; };
    const onError = recordFailure;
    const onAbort = () => terminate(signal.reason);
    const onExit = code => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      worker.removeListener('message', onMessage);
      worker.removeListener('error', onError);
      worker.removeListener('exit', onExit);
      if (failed) reject(failure);
      else if (code !== 0 || !received) reject(interrupted());
      else resolve(result);
    };
    worker.once('message', onMessage);
    worker.once('error', onError);
    worker.once('exit', onExit);
    const timer = setTimeout(() => terminate(timedOut()), timeoutMs);
    signal?.addEventListener('abort', onAbort, {once: true});
    if (signal?.aborted) onAbort();
  });
}
