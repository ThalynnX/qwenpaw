import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders } from "@/test/common_setup";
import type { ApprovalQuestion } from "@/api/modules/console";
import styles from "./ApprovalCard.module.less";
import { ApprovalCard, type ApprovalCardProps } from "./ApprovalCard";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (
      _key: string,
      fallback: string,
      options?: Record<string, string | number>,
    ) =>
      typeof fallback === "string"
        ? fallback.replace(/\{\{(\w+)\}\}/g, (token, name) =>
            String(options?.[name] ?? token),
          )
        : fallback,
  }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

function renderApprovalCard() {
  const onApprove = vi
    .fn<ApprovalCardProps["onApprove"]>()
    .mockResolvedValue(undefined);
  renderCard({ onApprove });
  return onApprove;
}

function renderCard({
  isGeneralized = true,
  onApprove = async () => {},
  questions,
  timeoutSeconds = 60,
}: {
  isGeneralized?: boolean;
  onApprove?: ApprovalCardProps["onApprove"];
  questions?: ApprovalQuestion[];
  timeoutSeconds?: number;
} = {}) {
  renderWithProviders(
    <ApprovalCard
      requestId="approval-1"
      toolName="shell"
      toolSource="tool"
      severity="medium"
      findingsCount={0}
      findingsSummary=""
      toolParams={{}}
      questions={questions}
      createdAt={Date.now() / 1000}
      timeoutSeconds={timeoutSeconds}
      agentId="default"
      isGeneralized={isGeneralized}
      exactTarget="pytest -q"
      similarTarget="pytest *"
      onApprove={onApprove}
      onDeny={vi.fn().mockResolvedValue(undefined)}
    />,
  );

  return onApprove;
}

describe("ApprovalCard generalized approval", () => {
  it("prioritizes one-time approval without changing approval scopes", async () => {
    const onApprove = renderApprovalCard();
    const user = userEvent.setup();
    const approveOnce = screen.getByRole("button", { name: "Just Once" });
    const approveAlways = screen.getByRole("button", {
      name: "Always Allow",
    });

    expect(approveOnce).toHaveClass(styles.approveOnceButton);
    expect(approveAlways).toHaveClass(styles.approveAlwaysButton);
    expect(approveOnce).toHaveClass("ant-btn-primary");
    expect(approveAlways).not.toHaveClass("ant-btn-primary");
    expect(
      approveOnce.compareDocumentPosition(approveAlways) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);

    await user.click(approveOnce);
    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledWith("approval-1", "exact");
    });
    await waitFor(() => expect(approveAlways).not.toBeDisabled());

    await user.click(approveAlways);
    await waitFor(() => {
      expect(onApprove).toHaveBeenLastCalledWith("approval-1", "similar");
    });
  });

  it("keeps a single-scope approval visually primary", () => {
    renderCard({ isGeneralized: false });

    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toHaveClass(styles.approveOnceButton);
    expect(approve).toHaveClass("ant-btn-primary");
  });
});

const SINGLE_QUESTION: ApprovalQuestion[] = [
  {
    question: "Which scope should I refactor?",
    header: "Scope",
    options: [
      { label: "auth only", description: "touch login only" },
      { label: "auth + session", description: "login and session" },
    ],
  },
];
const RECOMMENDED_QUESTION: ApprovalQuestion[] = [
  {
    question: "Which approach should I use?",
    header: "Approach",
    options: [
      {
        label: "Reuse ApprovalService (Recommended)",
        description: "Preserves the existing blocking approval flow.",
      },
      {
        label: "Use a separate prompt service",
        description: "Requires an additional response channel.",
      },
    ],
  },
];
const MULTI_QUESTIONS: ApprovalQuestion[] = [
  SINGLE_QUESTION[0],
  {
    question: "Add tests?",
    header: "Tests",
    options: [
      { label: "yes", description: "cover the tool" },
      { label: "no", description: "skip them" },
    ],
  },
];

describe("ApprovalCard interactive questions", () => {
  it.each([
    { choice: "recommended", index: 0 },
    { choice: "alternative", index: 1 },
  ])(
    "shows a recommendation without preselection and submits the $choice choice",
    async ({ index }) => {
      const onApprove = vi
        .fn<ApprovalCardProps["onApprove"]>()
        .mockResolvedValue(undefined);
      renderCard({
        isGeneralized: false,
        onApprove,
        questions: RECOMMENDED_QUESTION,
      });
      const user = userEvent.setup();
      const options = screen.getAllByRole("button", { pressed: false });
      const submit = screen.getByRole("button", { name: "Submit answer" });

      expect(options).toHaveLength(2);
      const recommendation = screen.getByText("Recommended", { exact: true });
      expect(recommendation).toBeVisible();
      expect(recommendation).toHaveClass("ant-tag");
      expect(options[0]).toContainElement(recommendation);
      expect(options[0]).toHaveTextContent("Reuse ApprovalService");
      expect(options[0]).not.toHaveTextContent("(Recommended)");
      expect(options[0]).toHaveTextContent(
        "Preserves the existing blocking approval flow.",
      );
      expect(options[1]).toHaveTextContent("Use a separate prompt service");
      expect(screen.queryByRole("button", { pressed: true })).toBeNull();
      expect(submit).toBeDisabled();
      expect(onApprove).not.toHaveBeenCalled();

      await user.click(options[index]);
      expect(options[index]).toHaveAttribute("aria-pressed", "true");
      expect(submit).toBeEnabled();
      await user.click(submit);

      await waitFor(() => {
        expect(onApprove).toHaveBeenCalledWith(
          "approval-1",
          undefined,
          JSON.stringify([
            {
              question: RECOMMENDED_QUESTION[0].question,
              selected: [RECOMMENDED_QUESTION[0].options[index].label],
              other: null,
            },
          ]),
        );
      });
    },
  );

  it("keeps a later recommended option in its original position", () => {
    renderCard({
      questions: [
        {
          ...RECOMMENDED_QUESTION[0],
          options: [...RECOMMENDED_QUESTION[0].options].reverse(),
        },
      ],
    });
    const options = screen.getAllByRole("button", { pressed: false });
    const recommendation = screen.getByText("Recommended", { exact: true });

    expect(options[0]).toHaveTextContent("Use a separate prompt service");
    expect(options[0]).not.toContainElement(recommendation);
    expect(options[1]).toContainElement(recommendation);
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Submit answer" }),
    ).toBeDisabled();
  });

  it.each([
    "Reuse ApprovalService (recommended)",
    "Reuse ApprovalService (Recommended) later",
    "Reuse ApprovalService (Recommended) ",
  ])("requires the exact recommendation suffix in %j", (label) => {
    renderCard({
      questions: [
        {
          ...SINGLE_QUESTION[0],
          options: [
            { label, description: "Preserve the option label." },
            SINGLE_QUESTION[0].options[1],
          ],
        },
      ],
    });

    expect(screen.queryByText("Recommended", { exact: true })).toBeNull();
    expect(screen.getAllByRole("button", { pressed: false })).toHaveLength(2);
  });

  it("ignores an unsupported recommended field without a label marker", () => {
    const optionsWithExtraField = [
      SINGLE_QUESTION[0].options[0],
      { ...SINGLE_QUESTION[0].options[1], recommended: true },
    ];
    renderCard({
      questions: [{ ...SINGLE_QUESTION[0], options: optionsWithExtraField }],
    });

    expect(screen.queryByText("Recommended", { exact: true })).toBeNull();
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Submit answer" }),
    ).toBeDisabled();
  });

  it("sends the chosen option back as an AskUserAnswer", async () => {
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockResolvedValue(undefined);
    renderCard({ isGeneralized: false, onApprove, questions: SINGLE_QUESTION });
    const user = userEvent.setup();

    expect(
      screen.getByText("Which scope should I refactor?"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Recommended", { exact: true })).toBeNull();
    const submit = screen.getByRole("button", { name: "Submit answer" });
    expect(submit).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Next question" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Previous question" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: /auth only/ }));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledWith(
        "approval-1",
        undefined,
        JSON.stringify([
          {
            question: SINGLE_QUESTION[0].question,
            selected: ["auth only"],
            other: null,
          },
        ]),
      );
    });
  });

  it("falls back to free text when no option is chosen", async () => {
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockResolvedValue(undefined);
    renderCard({
      isGeneralized: false,
      onApprove,
      questions: SINGLE_QUESTION,
    });
    const user = userEvent.setup();

    await user.type(
      screen.getByPlaceholderText("Other — type your answer"),
      "nothing yet",
    );
    await user.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledWith(
        "approval-1",
        undefined,
        JSON.stringify([
          {
            question: SINGLE_QUESTION[0].question,
            selected: [],
            other: "nothing yet",
          },
        ]),
      );
    });
  });

  it("pairs answers per question for multi-question forms", async () => {
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockResolvedValue(undefined);
    renderCard({
      isGeneralized: false,
      onApprove,
      questions: MULTI_QUESTIONS,
    });
    const user = userEvent.setup();

    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Next question" }),
    ).toBeDisabled();
    expect(screen.queryByText("Add tests?")).toBeNull();
    expect(screen.getByText("1 / 2")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /auth only/ }));
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.queryByText(SINGLE_QUESTION[0].question)).toBeNull();
    expect(screen.getByText("2 / 2")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Submit answer" }),
    ).toBeDisabled();
    await user.click(screen.getByRole("button", { name: /yes/ }));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledWith(
        "approval-1",
        undefined,
        JSON.stringify([
          {
            question: SINGLE_QUESTION[0].question,
            selected: ["auth only"],
            other: null,
          },
          { question: "Add tests?", selected: ["yes"], other: null },
        ]),
      );
    });
  });

  it("requires a current answer before advancing and cannot submit a middle page", async () => {
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockResolvedValue(undefined);
    renderCard({ questions: MULTI_QUESTIONS, onApprove });
    const user = userEvent.setup();
    const next = screen.getByRole("button", { name: "Next question" });
    const previous = screen.getByRole("button", { name: "Previous question" });

    expect(previous).toBeDisabled();
    expect(next).toBeDisabled();
    await user.type(screen.getByRole("textbox"), "   ");
    expect(next).toBeDisabled();
    await user.click(next);
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /auth only/ }));
    await user.click(next);
    await user.click(screen.getByRole("button", { name: /yes/ }));
    expect(screen.getByRole("button", { name: "Submit answer" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Previous question" }));

    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Next question" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /auth only/ }));
    expect(
      screen.getByRole("button", { name: "Next question" }),
    ).toBeDisabled();
  });

  it("preserves choices and free text when navigating back and resets scrolling", async () => {
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockResolvedValue(undefined);
    renderCard({
      questions: [
        {
          ...MULTI_QUESTIONS[0],
          context: "scope context",
          options: [
            { ...MULTI_QUESTIONS[0].options[0], preview: "auth preview" },
            MULTI_QUESTIONS[0].options[1],
          ],
        },
        MULTI_QUESTIONS[1],
      ],
      onApprove,
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /auth only/ }));
    await user.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.queryByText("scope context")).toBeNull();
    expect(screen.queryByText("auth preview")).toBeNull();
    await user.type(screen.getByRole("textbox"), "write focused tests");
    const content = screen
      .getByText("Add tests?")
      .closest<HTMLDivElement>(`.${styles.content}`);
    expect(content).not.toBeNull();
    content!.scrollTop = 180;
    await user.click(screen.getByRole("button", { name: "Previous question" }));

    expect(content!.scrollTop).toBe(0);
    expect(screen.getByText("scope context")).toBeInTheDocument();
    expect(screen.getByText("auth preview")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /auth only/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("textbox")).toHaveValue("");
    await user.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.getByRole("textbox")).toHaveValue("write focused tests");
    await user.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledWith(
        "approval-1",
        undefined,
        JSON.stringify([
          {
            question: SINGLE_QUESTION[0].question,
            selected: ["auth only"],
            other: null,
          },
          {
            question: "Add tests?",
            selected: [],
            other: "write focused tests",
          },
        ]),
      );
    });
  });

  it.each([
    { label: "a batch", questions: MULTI_QUESTIONS },
    { label: "a single question", questions: SINGLE_QUESTION },
    { label: "an ordinary approval", questions: undefined },
  ])("does not take focus when $label mounts", ({ questions }) => {
    const initialFocus = document.activeElement;
    renderCard({ questions });

    expect(document.activeElement).toBe(initialFocus);
  });

  it("focuses the current question after navigation and tabs into its options", async () => {
    renderCard({ questions: MULTI_QUESTIONS });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /auth only/ }));
    await user.click(screen.getByRole("button", { name: "Next question" }));

    const secondHeading = screen.getByRole("heading", { name: "Add tests?" });
    expect(secondHeading).toHaveFocus();
    expect(secondHeading).toHaveAttribute("tabindex", "-1");
    expect(
      screen.getByRole("button", { name: "Submit answer" }),
    ).toBeDisabled();
    await user.tab();
    expect(screen.getByRole("button", { name: /yes/ })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Previous question" }));
    expect(
      screen.getByRole("heading", { name: SINGLE_QUESTION[0].question }),
    ).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "Previous question" }),
    ).toBeDisabled();
    await user.tab();
    expect(screen.getByRole("button", { name: /auth only/ })).toHaveFocus();
  });

  it("freezes the answer snapshot while the batch submission is pending", async () => {
    let finishSubmission!: () => void;
    const pendingSubmission = new Promise<void>((resolve) => {
      finishSubmission = resolve;
    });
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockReturnValue(pendingSubmission);
    renderCard({ questions: MULTI_QUESTIONS, onApprove });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /auth only/ }));
    await user.click(screen.getByRole("button", { name: "Next question" }));
    expect(onApprove).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: /yes/ }));
    const submit = screen.getByRole("button", { name: "Submit answer" });
    const input = screen.getByRole("textbox");

    try {
      await user.click(submit);
      expect(onApprove).toHaveBeenCalledTimes(1);
      expect(submit).toBeDisabled();
      expect(
        screen.getByRole("button", { name: "Previous question" }),
      ).toBeDisabled();
      expect(screen.getByRole("button", { name: /yes/ })).toBeDisabled();
      expect(screen.getByRole("button", { name: /no/ })).toBeDisabled();
      expect(input).toBeDisabled();
      await user.click(screen.getByRole("button", { name: /no/ }));
      await user.type(input, "a later edit");
      expect(input).toHaveValue("");
      expect(onApprove).toHaveBeenCalledWith(
        "approval-1",
        undefined,
        JSON.stringify([
          {
            question: SINGLE_QUESTION[0].question,
            selected: ["auth only"],
            other: null,
          },
          { question: "Add tests?", selected: ["yes"], other: null },
        ]),
      );
    } finally {
      finishSubmission();
    }
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it("keeps every choice when multi_select is set", async () => {
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockResolvedValue(undefined);
    renderCard({
      isGeneralized: false,
      onApprove,
      questions: [
        {
          question: "Which surfaces need work?",
          header: "Surfaces",
          multi_select: true,
          options: [
            { label: "console", description: "web console" },
            { label: "desktop", description: "desktop shell" },
          ],
        },
      ],
    });
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: /console/ }));
    await user.click(screen.getByRole("button", { name: /desktop/ }));
    await user.click(screen.getByRole("button", { name: "Submit answer" }));

    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledWith(
        "approval-1",
        undefined,
        JSON.stringify([
          {
            question: "Which surfaces need work?",
            selected: ["console", "desktop"],
            other: null,
          },
        ]),
      );
    });
  });

  it("renders context always and preview only for the chosen option", async () => {
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockResolvedValue(undefined);
    renderCard({
      isGeneralized: false,
      onApprove,
      questions: [
        {
          question: "Approve this draft?",
          header: "Draft",
          context: "the draft under review",
          options: [
            {
              label: "keep",
              description: "leave it",
              preview: "draft-marker-keep",
            },
            { label: "rewrite", description: "replace it" },
          ],
        },
      ],
    });
    const user = userEvent.setup();

    expect(screen.getByText("the draft under review")).toBeInTheDocument();
    expect(screen.queryByText("draft-marker-keep")).toBeNull();

    await user.click(screen.getByRole("button", { name: /keep/ }));
    expect(screen.getByText("draft-marker-keep")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /rewrite/ }));
    expect(screen.queryByText("draft-marker-keep")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /keep/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("requires an answer even if a question request is marked generalized", () => {
    renderCard({ questions: SINGLE_QUESTION });

    expect(screen.queryByRole("button", { name: "Always Allow" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Just Once" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Submit answer" }),
    ).toBeDisabled();
  });

  it("rejects whitespace and lets the user switch between a choice and free text", async () => {
    const onApprove = vi
      .fn<ApprovalCardProps["onApprove"]>()
      .mockResolvedValue(undefined);
    renderCard({ onApprove, questions: SINGLE_QUESTION });
    const user = userEvent.setup();
    const input = screen.getByRole("textbox", {
      name: "Other — type your answer",
    });
    const submit = screen.getByRole("button", { name: "Submit answer" });

    await user.type(input, "   ");
    expect(submit).toBeDisabled();
    await user.click(submit);
    expect(onApprove).not.toHaveBeenCalled();

    const choice = screen.getByRole("button", { name: /auth only/ });
    await user.click(choice);
    expect(input).toHaveValue("");
    expect(choice).toHaveAttribute("aria-pressed", "true");
    await user.type(input, "  auth after review  ");
    expect(choice).toHaveAttribute("aria-pressed", "false");
    await user.click(submit);

    await waitFor(() => {
      expect(onApprove).toHaveBeenCalledWith(
        "approval-1",
        undefined,
        JSON.stringify([
          {
            question: SINGLE_QUESTION[0].question,
            selected: [],
            other: "auth after review",
          },
        ]),
      );
    });
  });

  it("does not show an option preview for a multi-select question", async () => {
    renderCard({
      questions: [
        {
          ...SINGLE_QUESTION[0],
          multi_select: true,
          options: [
            { ...SINGLE_QUESTION[0].options[0], preview: "single-select only" },
            SINGLE_QUESTION[0].options[1],
          ],
        },
      ],
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /auth only/ }));

    expect(screen.queryByText("single-select only")).not.toBeInTheDocument();
    expect(screen.getByText("touch login only")).toBeInTheDocument();
  });

  it("does not accept an answer after the question times out", () => {
    renderCard({ questions: SINGLE_QUESTION, timeoutSeconds: 0 });

    expect(screen.getByText("Timed out, auto denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(screen.getByRole("button", { name: /auth only/ })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
  });

  it("does not allow navigation after a batch of questions times out", () => {
    renderCard({ questions: MULTI_QUESTIONS, timeoutSeconds: 0 });

    expect(screen.getByText("Timed out, auto denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Submit answer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Next question" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Previous question" }),
    ).toBeNull();
  });
});
