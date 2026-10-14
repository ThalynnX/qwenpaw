import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import useBackendReadyPolling from "../tauri/useBackendReadyPolling";

vi.mock("../tauri/backendRuntime", () => ({
  backendConsoleUrl: (base: string) => `${base}/console`,
  getBackendStartupError: async () => "",
  initRuntimeApiBaseUrl: async () => "http://127.0.0.1:8088",
  restartBackend: async () => {},
  shouldUseTauriStartupGate: () => true,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps the startup page while HTTP works but core agents are still starting", async () => {
  vi.useFakeTimers();
  let coreReady = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      // /api/version answers throughout background startup. Only healthz
      // distinguishes a reachable HTTP server from usable core agents.
      const ready = url.endsWith("/api/healthz") ? coreReady : true;
      return new Response("{}", { status: ready ? 200 : 503 });
    }),
  );
  const { result } = renderHook(() => useBackendReadyPolling());
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(result.current.status).toBe("checking");
  expect(result.current.readyUrl).toBe("");

  coreReady = true;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(result.current.status).toBe("ready");
  expect(result.current.readyUrl).toBe("http://127.0.0.1:8088/console");
});
