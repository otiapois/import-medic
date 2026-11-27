import { useCallback, useEffect, useRef, useState } from 'react';
import { WorkbenchWorker } from '../../core/worker/client';
import type { WorkerProgress } from '../../core/worker/protocol';

interface Task {
  worker: WorkbenchWorker;
  progress: (progress: WorkerProgress) => void;
  isCurrent: () => boolean;
}

const PHASES: Record<WorkerProgress['phase'], string> = {
  reading: 'Reading local files',
  parsing: 'Parsing local files',
  repairing: 'Repairing CSV',
  comparing: 'Comparing prices',
  exporting: 'Preparing local output',
};

export function useWorkerSession() {
  const workerRef = useRef<WorkbenchWorker | null>(null);
  const revision = useRef(0);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [error, setError] = useState('');
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);

  const release = useCallback(() => {
    revision.current += 1;
    workerRef.current?.terminate();
    workerRef.current = null;
  }, []);
  useEffect(() => release, [release]);

  const run = useCallback(async <T,>(
    start: (task: Task) => Promise<T>,
    complete: (value: T, worker: WorkbenchWorker) => void,
    phase: WorkerProgress['phase'],
  ) => {
    const job = ++revision.current;
    const isCurrent = () => revision.current === job;
    let shown: WorkerProgress = { phase, percent: 0 };
    let next = shown;
    let frame: number | null = null;
    setProgress(shown);
    setError('');
    setFinished(false);
    try {
      const worker = workerRef.current ??= new WorkbenchWorker();
      const value = await start({ worker, isCurrent, progress: (update) => {
        if (!isCurrent()) return;
        if (update.phase !== shown.phase || (shown.percent === 0 && update.percent > 0)) {
          // Keep new phases and their first actual progress visible even when replies arrive in a burst.
          if (frame !== null) window.cancelAnimationFrame(frame);
          frame = null;
          shown = update;
          setProgress(update);
        } else if (update.percent !== shown.percent) {
          next = update;
          frame ??= window.requestAnimationFrame(() => {
            frame = null;
            if (!isCurrent()) return;
            shown = next;
            setProgress(next);
          });
        }
      } });
      if (isCurrent()) {
        complete(value, worker);
        setFinished(true);
      }
    } catch (cause) {
      if (isCurrent()) setError(cause instanceof Error ? cause.message : 'The local task could not finish.');
    } finally {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (isCurrent()) setProgress(null);
    }
  }, []);

  const invalidate = useCallback(() => {
    revision.current += 1;
    setProgress(null);
    setError('');
    setFinished(false);
  }, []);

  const reset = useCallback(() => {
    release();
    invalidate();
    setPaused(false);
  }, [release, invalidate]);

  const cancel = useCallback(() => {
    reset();
    setPaused(true);
  }, [reset]);

  const resume = useCallback(() => setPaused(false), []);
  return { run, invalidate, reset, cancel, resume, paused, progress, error, finished };
}

export function WorkerStatus({ progress, paused, finished, error, focusHeading, onCancel, onResume }: {
  progress: WorkerProgress | null;
  paused: boolean;
  finished: boolean;
  error: string;
  focusHeading: string;
  onCancel: () => void;
  onResume: () => void;
}) {
  const actionHadFocus = useRef(false);
  useEffect(() => {
    if (!progress && !paused && actionHadFocus.current && document.activeElement === document.body) {
      document.getElementById(focusHeading)?.focus({ preventScroll: true });
      actionHadFocus.current = false;
    }
  }, [focusHeading, progress, paused]);
  return (
    <div className={progress || paused || error ? 'worker-feedback worker-status' : 'worker-feedback'}>
      <p className={progress || paused ? undefined : 'sr-only'} role="status">
        {paused ? 'Processing canceled. Resume to rerun with the selected files and settings.'
          : progress ? `${PHASES[progress.phase]}…` : finished ? 'Local processing complete.' : error ? 'Local processing stopped.' : ''}
      </p>
      {progress ? (
        <progress aria-label={PHASES[progress.phase]} max={100} value={progress.percent}>{progress.percent}%</progress>
      ) : null}
      {progress || paused ? (
        <button type="button" className="button button-secondary button-small"
          onFocus={() => { actionHadFocus.current = true; }} onBlur={(event) => {
            if (event.relatedTarget) actionHadFocus.current = false;
          }} onClick={paused ? onResume : onCancel}>
          {paused ? 'Resume' : 'Cancel'}
        </button>
      ) : null}
      {error ? <p className="file-message file-error" role="alert">{error}</p> : null}
    </div>
  );
}
