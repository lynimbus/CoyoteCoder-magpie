import { describe, expect, it } from "vitest";
import { summarizeReply } from "../../hooks.ts";

describe("summarizeReply", () => {
  it("reads usage and tool calls out of a Chat Completions reply", () => {
    const reply = {
      choices: [{ message: { tool_calls: [{ id: "a" }, { id: "b" }] } }],
      usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 }
    };
    expect(summarizeReply(reply, { success: true })).toMatchObject({
      success: true,
      status: 200,
      outputTokens: 5,
      totalTokens: 6,
      toolCalls: 2
    });
  });

  it("reads an Anthropic Messages reply", () => {
    const reply = {
      content: [{ type: "text" }, { type: "tool_use" }],
      stop_reason: "end_turn",
      usage: { output_tokens: 9 }
    };
    expect(summarizeReply(reply, { success: true })).toMatchObject({
      success: true,
      outputTokens: 9,
      toolCalls: 1,
      finishReason: "end_turn"
    });
  });

  it("takes the status of an error reply and does not call it a success", () => {
    expect(summarizeReply({ error: { code: 429 } }, { success: false })).toMatchObject({
      success: false,
      status: 429
    });
  });

  it("has nothing to read for a streamed reply", () => {
    expect(summarizeReply(null, { success: true })).toMatchObject({
      success: true,
      outputTokens: undefined,
      toolCalls: 0
    });
  });
});
