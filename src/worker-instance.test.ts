import { describe, it, expect } from "vitest";
import { FailureClass } from "./events/index.js";
import { classifyError, isRetryable } from "./worker-instance.js";
import { OutputValidationError } from "./executor/index.js";

describe("error classification", () => {
  describe("classifyError", () => {
    it("returns UNKNOWN for non-Error values", () => {
      expect(classifyError("string error")).toBe(FailureClass.UNKNOWN);
      expect(classifyError(null)).toBe(FailureClass.UNKNOWN);
      expect(classifyError(undefined)).toBe(FailureClass.UNKNOWN);
      expect(classifyError(42)).toBe(FailureClass.UNKNOWN);
      expect(classifyError({ message: "object" })).toBe(FailureClass.UNKNOWN);
    });

    it("classifies OutputValidationError as INVALID_INPUT", () => {
      const error = new OutputValidationError("validation failed");
      expect(classifyError(error)).toBe(FailureClass.INVALID_INPUT);
    });

    it("classifies abort errors as ABORTED", () => {
      expect(classifyError(new Error("Operation aborted"))).toBe(
        FailureClass.ABORTED,
      );
      expect(classifyError(new Error("Request was aborted by user"))).toBe(
        FailureClass.ABORTED,
      );

      const abortError = new Error("error");
      abortError.name = "AbortError";
      expect(classifyError(abortError)).toBe(FailureClass.ABORTED);
    });

    it("classifies timeout errors as TIMEOUT", () => {
      expect(classifyError(new Error("Request timeout"))).toBe(
        FailureClass.TIMEOUT,
      );
      expect(classifyError(new Error("Connection timeout occurred"))).toBe(
        FailureClass.TIMEOUT,
      );

      const timeoutError = new Error("error");
      timeoutError.name = "TimeoutError";
      expect(classifyError(timeoutError)).toBe(FailureClass.TIMEOUT);
    });

    it("classifies rate limit errors as RATE_LIMITED", () => {
      expect(classifyError(new Error("Rate limit exceeded"))).toBe(
        FailureClass.RATE_LIMITED,
      );
      expect(classifyError(new Error("Too many requests, rate limit"))).toBe(
        FailureClass.RATE_LIMITED,
      );
      expect(classifyError(new Error("Error 429: Too Many Requests"))).toBe(
        FailureClass.RATE_LIMITED,
      );
    });

    it("classifies context length errors as CONTEXT_LENGTH_EXCEEDED", () => {
      expect(classifyError(new Error("Context length exceeded"))).toBe(
        FailureClass.CONTEXT_LENGTH_EXCEEDED,
      );
      expect(classifyError(new Error("Input too long for model"))).toBe(
        FailureClass.CONTEXT_LENGTH_EXCEEDED,
      );
      expect(classifyError(new Error("Maximum context length is 4096"))).toBe(
        FailureClass.CONTEXT_LENGTH_EXCEEDED,
      );
    });

    it("classifies network errors as NETWORK_ERROR", () => {
      expect(classifyError(new Error("Network error occurred"))).toBe(
        FailureClass.NETWORK_ERROR,
      );
      expect(classifyError(new Error("ECONNRESET: Connection reset"))).toBe(
        FailureClass.NETWORK_ERROR,
      );
      expect(classifyError(new Error("ECONNREFUSED: Connection refused"))).toBe(
        FailureClass.NETWORK_ERROR,
      );
    });

    it("classifies model errors as MODEL_ERROR", () => {
      expect(classifyError(new Error("Model not found"))).toBe(
        FailureClass.MODEL_ERROR,
      );
      expect(classifyError(new Error("Invalid model specified"))).toBe(
        FailureClass.MODEL_ERROR,
      );
    });

    it("classifies validation errors as INVALID_INPUT", () => {
      expect(classifyError(new Error("Invalid input format"))).toBe(
        FailureClass.INVALID_INPUT,
      );
      expect(classifyError(new Error("Validation failed"))).toBe(
        FailureClass.INVALID_INPUT,
      );
    });

    it("returns UNKNOWN for unrecognized errors", () => {
      expect(classifyError(new Error("Something went wrong"))).toBe(
        FailureClass.UNKNOWN,
      );
      expect(classifyError(new Error("Unexpected error"))).toBe(
        FailureClass.UNKNOWN,
      );
    });

    it("is case-insensitive", () => {
      expect(classifyError(new Error("TIMEOUT ERROR"))).toBe(
        FailureClass.TIMEOUT,
      );
      expect(classifyError(new Error("RATE LIMIT exceeded"))).toBe(
        FailureClass.RATE_LIMITED,
      );
      expect(classifyError(new Error("Network ERROR"))).toBe(
        FailureClass.NETWORK_ERROR,
      );
    });
  });

  describe("isRetryable", () => {
    it("TIMEOUT is retryable", () => {
      expect(isRetryable(FailureClass.TIMEOUT)).toBe(true);
    });

    it("RATE_LIMITED is retryable", () => {
      expect(isRetryable(FailureClass.RATE_LIMITED)).toBe(true);
    });

    it("NETWORK_ERROR is retryable", () => {
      expect(isRetryable(FailureClass.NETWORK_ERROR)).toBe(true);
    });

    it("INVALID_INPUT is not retryable", () => {
      expect(isRetryable(FailureClass.INVALID_INPUT)).toBe(false);
    });

    it("MODEL_ERROR is not retryable", () => {
      expect(isRetryable(FailureClass.MODEL_ERROR)).toBe(false);
    });

    it("CONTEXT_LENGTH_EXCEEDED is not retryable", () => {
      expect(isRetryable(FailureClass.CONTEXT_LENGTH_EXCEEDED)).toBe(false);
    });

    it("ABORTED is not retryable", () => {
      expect(isRetryable(FailureClass.ABORTED)).toBe(false);
    });

    it("GUARDRAIL_VIOLATION is not retryable", () => {
      expect(isRetryable(FailureClass.GUARDRAIL_VIOLATION)).toBe(false);
    });

    it("DETERMINISM_VIOLATION is not retryable", () => {
      expect(isRetryable(FailureClass.DETERMINISM_VIOLATION)).toBe(false);
    });

    it("UNKNOWN is not retryable", () => {
      expect(isRetryable(FailureClass.UNKNOWN)).toBe(false);
    });
  });

  describe("classification priority", () => {
    it("abort takes priority when message contains multiple keywords", () => {
      // "abort" is checked before "timeout" in the implementation
      expect(classifyError(new Error("Operation aborted due to timeout"))).toBe(
        FailureClass.ABORTED,
      );
    });

    it("OutputValidationError takes priority over message-based classification", () => {
      const error = new OutputValidationError("timeout in validation");
      expect(classifyError(error)).toBe(FailureClass.INVALID_INPUT);
    });
  });
});
