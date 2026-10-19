import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getAudioMode: vi.fn(),
  getTranscriptionProviderType: vi.fn(),
  getTranscriptionProviders: vi.fn(),
  getLocalWhisperStatus: vi.fn(),
  updateAudioMode: vi.fn(),
  updateTranscriptionProviderType: vi.fn(),
  updateTranscriptionProvider: vi.fn(),
}));
const app = vi.hoisted(() => ({
  message: { success: vi.fn(), error: vi.fn() },
  t: (key: string) => key,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: app.t }),
}));

vi.mock("../../../hooks/useAppMessage", () => ({
  useAppMessage: () => ({ message: app.message }),
}));

vi.mock("../../../api", () => ({ default: api }));

import VoiceTranscriptionPage from ".";

describe("VoiceTranscriptionPage initial load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.updateAudioMode.mockResolvedValue(undefined);
    api.updateTranscriptionProviderType.mockResolvedValue(undefined);
    api.updateTranscriptionProvider.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks edits until retry restores the persisted settings", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let loadFails = true;
    api.getAudioMode.mockImplementation(async () => {
      if (loadFails) throw new Error("network down");
      return { audio_mode: "auto" };
    });
    api.getTranscriptionProviderType.mockResolvedValue({
      transcription_provider_type: "local_whisper",
    });
    api.getTranscriptionProviders.mockResolvedValue({
      providers: [{ id: "p1", name: "Provider One", available: true }],
      configured_provider_id: "p1",
    });
    api.getLocalWhisperStatus.mockResolvedValue({
      available: true,
      ffmpeg_installed: true,
      whisper_installed: true,
    });

    render(<VoiceTranscriptionPage />);

    const retry = await screen.findByRole("button", { name: "common.retry" });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "voiceTranscription.loadFailed",
    );
    expect(
      screen.queryByRole("radiogroup", {
        name: "voiceTranscription.audioModeLabel",
      }),
    ).toBeNull();
    expect(
      screen.queryByRole("radiogroup", {
        name: "voiceTranscription.providerTypeLabel",
      }),
    ).toBeNull();
    expect(api.updateAudioMode).not.toHaveBeenCalled();
    expect(api.updateTranscriptionProviderType).not.toHaveBeenCalled();
    expect(api.updateTranscriptionProvider).not.toHaveBeenCalled();

    loadFails = false;
    fireEvent.click(retry);

    expect(
      await screen.findByRole("radio", {
        name: "voiceTranscription.modeAuto",
      }),
    ).toBeChecked();
    expect(
      screen.getByRole("radio", {
        name: "voiceTranscription.providerTypeLocalWhisper",
      }),
    ).toBeChecked();
    await waitFor(() => expect(api.getAudioMode).toHaveBeenCalledTimes(2));
    expect(api.getTranscriptionProviderType).toHaveBeenCalledTimes(2);
    expect(api.getTranscriptionProviders).toHaveBeenCalledTimes(2);
    expect(api.getLocalWhisperStatus).toHaveBeenCalledTimes(2);
    expect(api.updateAudioMode).not.toHaveBeenCalled();
    expect(api.updateTranscriptionProviderType).not.toHaveBeenCalled();
    expect(api.updateTranscriptionProvider).not.toHaveBeenCalled();
  });
});
