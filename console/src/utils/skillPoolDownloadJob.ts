import api from "../api";
import { ApiError } from "../api/request";
import type {
  PoolDownloadJob,
  PoolDownloadState,
  SkillPoolDownloadRequest,
} from "../api/types";

/** How often the console asks the backend for the job's real state. */
export const POOL_DOWNLOAD_POLL_MS = 1_000;

/** Upper bound for the backoff applied while status polling keeps failing. */
export const POOL_DOWNLOAD_RETRY_MAX_MS = 5_000;

export interface PoolDownloadHandle {
  /** Resolves once the job reached a terminal state. */
  done: Promise<PoolDownloadJob>;
  /** Ask the backend to stop the job at its next safe point. */
  cancel: () => Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isTerminal(state: PoolDownloadState): boolean {
  return state === "completed" || state === "failed" || state === "cancelled";
}

/**
 * A status request is worth retrying only while its failure says nothing about
 * the job itself: no response (network error, timeout) or a transient server
 * side status. A 404 means the job is gone and retrying would spin forever.
 */
function getErrorStatus(error: unknown): number | undefined {
  // `request()` throws ApiError, which carries the HTTP status directly.
  if (error instanceof ApiError) return error.status;
  // Read the property too: a bundled or proxied copy of ApiError would fail
  // the instanceof check while still exposing `status`.
  const direct = (error as { status?: unknown } | undefined)?.status;
  if (typeof direct === "number") return direct;
  // Keep the axios-shaped lookup for callers that wrap the API differently.
  const status = (error as { response?: { status?: number } } | undefined)
    ?.response?.status;
  return typeof status === "number" ? status : undefined;
}

function isRetryableStatusFailure(error: unknown): boolean {
  const status = getErrorStatus(error);
  // No status at all means the request never got an answer: retry it.
  if (status === undefined) return true;
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(consecutiveFailures: number): number {
  const backoff = POOL_DOWNLOAD_POLL_MS * 2 ** (consecutiveFailures - 1);
  return Math.min(backoff, POOL_DOWNLOAD_RETRY_MAX_MS);
}

/**
 * Start a pool download as a cancellable job and follow it to the end.
 *
 * There is deliberately no overall deadline: a broadcast to many workspaces
 * can legitimately take a long time, and the job keeps reporting its real
 * state — including `cancelling` while its rollback runs — until it reaches a
 * terminal one. Status polling therefore survives temporary connection
 * failures instead of abandoning a download that is still running; only the
 * status request is retried, the download itself is started exactly once.
 */
export function startPoolDownloadJob(
  payload: SkillPoolDownloadRequest,
  options: { onState?: (state: PoolDownloadState) => void } = {},
): PoolDownloadHandle {
  const started = api.startSkillPoolDownload(payload);
  let cancelRequested = false;
  let currentState: PoolDownloadState | null = null;
  let trackingEnded = false;

  const emit = (state: PoolDownloadState): void => {
    // A terminal state is final. Responses to requests that were already in
    // flight when it arrived must not move the dialog back to `cancelling`
    // or `running` and offer a cancel that no longer means anything.
    if (trackingEnded) return;
    // Once the user asked to cancel, a `running` answer is an older response
    // to a question we already superseded: letting it through would flip the
    // dialog back to "downloading" and hide the pending rollback.
    if (
      cancelRequested &&
      currentState === "cancelling" &&
      state === "running"
    ) {
      return;
    }
    currentState = state;
    if (isTerminal(state)) trackingEnded = true;
    options.onState?.(state);
  };

  const cancel = async (): Promise<void> => {
    if (trackingEnded) return;
    const job = await started;
    // The job may have finished while `started` was resolving.
    if (trackingEnded) return;
    cancelRequested = true;
    // Show "cancelling" before the request leaves: the user asked, and the
    // backend may take a moment to acknowledge it.
    emit("cancelling");
    try {
      const response = await api.cancelSkillPoolDownload(job.job_id);
      if (response.state !== "running") {
        emit(response.state);
      }
    } catch (error) {
      // The request never reached the backend, so nothing was cancelled. Say
      // so and fall back to the state we can still prove.
      cancelRequested = false;
      emit("running");
      throw error;
    }
  };

  const done = (async (): Promise<PoolDownloadJob> => {
    let job = await started;
    emit(job.state);
    let failures = 0;
    while (!isTerminal(job.state)) {
      await delay(
        failures === 0 ? POOL_DOWNLOAD_POLL_MS : retryDelay(failures),
      );
      try {
        job = await api.getSkillPoolDownload(job.job_id);
        failures = 0;
      } catch (error) {
        if (!isRetryableStatusFailure(error)) throw error;
        failures += 1;
        continue;
      }
      emit(job.state);
    }
    return job;
  })();

  return { done, cancel };
}
